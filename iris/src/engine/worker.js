/**
 * engine/worker.js -- Module Web Worker for Iris.
 *
 * Loads and runs Gemma 4 models via transformers.js (v3) + WebGPU.
 * All model interactions happen here; the main thread communicates
 * via structured RPC messages { id, type, payload }.
 *
 * NOTE: transformers.js v3 is required for Gemma 4 support.
 * The CDN import resolves to the latest v3 release.
 */

import {
  AutoTokenizer,
  AutoModelForCausalLM,
  AutoModelForImageTextToText,
  TextStreamer,
  InterruptableStoppingCriteria,
  Tensor,
  env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers';

// Load from HF Hub; browser Cache API persists weights across reloads.
env.allowLocalModels = false;

let tokenizer = null;
let model = null;
let currentRepo = null;
// Holds the InterruptableStoppingCriteria for the in-flight generate (for cancel).
let stopper = null;

// ---------- Helpers ----------

/** Post a message back to the main thread, tagged with the request id. */
function post(id, type, payload) {
  self.postMessage({ id, type, payload });
}

/**
 * Resolve the ONNX execution backend.
 *
 * The Gemma 4 QAT-mobile weights are f16-only (q2f16 / fp16). WebGPU can run
 * f16 models ONLY when the adapter exposes the 'shader-f16' feature; on GPUs or
 * browsers without it, transformers.js throws
 *   "The device (webgpu) does not support fp16".
 * So for 'auto' we probe the adapter and fall back to 'wasm' (CPU) when f16
 * isn't available. WASM runs f16 weights fine -- slower, but it works anywhere.
 *
 *  - 'wasm' / 'cpu' : force CPU.
 *  - 'webgpu'       : force WebGPU (may fail on devices without shader-f16).
 *  - 'auto' (default): WebGPU iff shader-f16 is supported, else WASM.
 */
async function resolveDevice(requested) {
  const want = requested || 'auto';
  if (want === 'wasm' || want === 'cpu') return 'wasm';
  if (want === 'webgpu') return 'webgpu';
  try {
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter && adapter.features.has('shader-f16')) return 'webgpu';
    }
  } catch (_) { /* fall through to wasm */ }
  return 'wasm';
}

// ---------- Operations ----------

/**
 * Load a model + tokenizer from the HF Hub.
 *
 * NOTE: Gemma 4 is multimodal (vision+text). For TEXT-ONLY usage we try the
 * causal-LM class first (AutoModelForCausalLM) which loads only the text head.
 * If that fails (e.g. the repo only has a multimodal config), we fall back to
 * AutoModelForImageTextToText. Either way we only ever pass text inputs, so
 * vision weights are loaded but unused in the fallback case.
 *
 * This try/fallback is THE SINGLE SEAM to change the model loading strategy.
 */
async function loadModel(id, { repo, dtype = 'q4f16', device = 'auto' }) {
  // Unload previous model if any
  if (model) {
    model = null;
    tokenizer = null;
    currentRepo = null;
  }

  // Pick a backend that can actually run these f16-only weights.
  const dev = await resolveDevice(device);

  const progressCallback = (progress) => {
    // transformers.js progress events have { status, file, progress, loaded, total, ... }
    if (progress.status === 'progress') {
      post(id, 'progress', {
        file: progress.file ?? '',
        loaded: progress.loaded ?? 0,
        total: progress.total ?? 0,
        pct: progress.progress ?? 0,
      });
    }
  };

  tokenizer = await AutoTokenizer.from_pretrained(repo, {
    progress_callback: progressCallback,
  });

  // NOTE: Single seam -- try causal-LM (text-only weights) first, fall back
  // to multimodal class. See module-level doc comment for rationale.
  try {
    model = await AutoModelForCausalLM.from_pretrained(repo, {
      dtype,
      device: dev,
      progress_callback: progressCallback,
    });
  } catch (e) {
    // NOTE: Fallback to multimodal class. This loads vision weights too,
    // but we never pass image inputs so only text generation is exercised.
    model = await AutoModelForImageTextToText.from_pretrained(repo, {
      dtype,
      device: dev,
      progress_callback: progressCallback,
    });
  }

  currentRepo = repo;
  post(id, 'loaded', { device: dev });
}

/**
 * Apply the chat template to produce input_ids and the rendered prompt string.
 *
 * Thinking mode is controlled by the `enable_thinking` template kwarg (the
 * Gemma 4 template reads it), NOT by injecting a token into the system message.
 */
function applyChatTemplate(id, { messages, tools, thinking }) {
  if (!tokenizer) {
    post(id, 'error', { message: 'Tokenizer not loaded' });
    return;
  }

  // Deep-clone messages so we don't mutate the caller's data
  let shaped = JSON.parse(JSON.stringify(messages));

  // Build template options. `enable_thinking` is forwarded to the Jinja
  // template (Gemma 4 / Qwen3-style thinking toggle).
  const templateOpts = {
    add_generation_prompt: true,
    return_dict: true,
    enable_thinking: !!thinking,
  };
  if (tools && tools.length > 0) {
    templateOpts.tools = tools;
  }

  // Get tokenized input_ids (as a tensor)
  const result = tokenizer.apply_chat_template(shaped, templateOpts);

  // Get the rendered (non-tokenized) prompt string for debug display
  const rendered = tokenizer.apply_chat_template(shaped, {
    ...templateOpts,
    return_dict: false,
    tokenize: false,
  });

  // Serialize tensor to plain array for postMessage transfer.
  // result may be { input_ids: Tensor } or a Tensor directly, depending on version.
  let inputIdsArray;
  if (result.input_ids) {
    inputIdsArray = Array.from(result.input_ids.data ?? result.input_ids);
  } else {
    inputIdsArray = Array.from(result.data ?? result);
  }

  post(id, 'templated', { input_ids: inputIdsArray, rendered });
}

/**
 * Generate text from input_ids, streaming tokens back to the main thread.
 */
async function generate(id, { input_ids, genConfig = {} }) {
  if (!model || !tokenizer) {
    post(id, 'error', { message: 'Model not loaded' });
    return;
  }

  // Build a TextStreamer that posts each token chunk back. skip_special_tokens
  // is false so the protocol parser can see the thinking/tool-call control tokens.
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: false,
    callback_function: (text) => {
      if (text) {
        post(id, 'token', { text });
      }
    },
  });

  // Reconstruct tensor from the plain array (1D ids -> [1, seq_len]).
  const inputTensor = new Tensor('int64', BigInt64Array.from(input_ids.map(BigInt)), [1, input_ids.length]);

  // InterruptableStoppingCriteria lets cancel() halt generation; generate then
  // resolves normally with the partial output (no throw).
  stopper = new InterruptableStoppingCriteria();

  const t0 = performance.now();

  try {
    const output = await model.generate({
      input_ids: inputTensor,
      ...genConfig,
      streamer,
      stopping_criteria: stopper,
    });

    const elapsed = performance.now() - t0;

    // model.generate returns prompt + continuation; decode ONLY the generated
    // continuation so the protocol parser/splitFinal never sees the prompt.
    let seq;
    if (typeof output?.tolist === 'function') seq = output.tolist()[0];
    else if (output?.data) seq = Array.from(output.data);
    else if (Array.isArray(output)) seq = Array.isArray(output[0]) ? output[0] : output;
    else seq = [];
    const genIds = seq.slice(input_ids.length).map(Number);
    const outputText = tokenizer.decode(genIds, { skip_special_tokens: false });
    const generatedTokens = genIds.length;

    post(id, 'generated', {
      outputText,
      stats: {
        tokens: generatedTokens,
        ms: Math.round(elapsed),
        tokensPerSec: generatedTokens > 0 ? parseFloat((generatedTokens / (elapsed / 1000)).toFixed(2)) : 0,
      },
    });
  } catch (e) {
    post(id, 'error', { message: e.message || String(e) });
  } finally {
    stopper = null;
  }
}

/**
 * Decode token IDs back to text.
 */
function decode(id, { ids }) {
  if (!tokenizer) {
    post(id, 'error', { message: 'Tokenizer not loaded' });
    return;
  }

  let text;
  if (Array.isArray(ids[0])) {
    text = tokenizer.batch_decode(ids, { skip_special_tokens: false });
  } else {
    text = tokenizer.decode(ids, { skip_special_tokens: false });
  }

  post(id, 'decoded', { text });
}

/**
 * Cancel an in-flight generate call.
 */
function cancel(id) {
  if (stopper) stopper.interrupt();
  post(id, 'ok', {});
}

/**
 * Return tokenizer metadata for runtime verification of thinking/tool tokens.
 *
 * NOTE: The exact properties available depend on the transformers.js version
 * and model. We do best-effort extraction from multiple possible locations:
 * - chat_template: the Jinja template string (if any)
 * - added_tokens: tokens added beyond the base vocab (control tokens, etc.)
 * - specials: special_tokens_map or special_tokens (whichever exists)
 */
function getTokenizerInfo(id) {
  if (!tokenizer) {
    post(id, 'error', { message: 'Tokenizer not loaded' });
    return;
  }

  // NOTE: added_tokens may be an array of strings or objects with .content
  const addedTokens = (tokenizer.added_tokens ?? []).map((t) =>
    typeof t === 'string' ? t : t.content ?? String(t)
  );

  // NOTE: special tokens can live in multiple places depending on the tokenizer
  const specials =
    tokenizer.special_tokens_map ??
    tokenizer.special_tokens ??
    null;

  post(id, 'tokenizerInfo', {
    chat_template: tokenizer.chat_template ?? null,
    added_tokens: addedTokens,
    specials,
  });
}

/**
 * Storage operations: estimate, persist, list, clear.
 *
 * NOTE: list and clear operate on Cache Storage (used by transformers.js for
 * model weights). This is approximate -- transformers.js may change its caching
 * strategy across versions.
 */
async function storageOp(id, { op, repo }) {
  try {
    let result;

    switch (op) {
      case 'estimate': {
        const estimate = await navigator.storage.estimate();
        result = {
          usage: estimate.usage ?? 0,
          quota: estimate.quota ?? 0,
          usageMB: Math.round((estimate.usage ?? 0) / 1024 / 1024),
          quotaMB: Math.round((estimate.quota ?? 0) / 1024 / 1024),
        };
        break;
      }

      case 'persist': {
        const persisted = await navigator.storage.persist();
        result = { persisted };
        break;
      }

      case 'list': {
        // NOTE: transformers.js v3 uses Cache Storage with cache names like
        // "transformers-cache". We list all caches and their keys as a
        // best-effort inventory.
        const cacheNames = await caches.keys();
        const entries = [];
        for (const name of cacheNames) {
          const cache = await caches.open(name);
          const keys = await cache.keys();
          entries.push({
            cache: name,
            count: keys.length,
            urls: keys.slice(0, 20).map((r) => r.url), // cap to avoid huge payloads
          });
        }
        result = { caches: entries };
        break;
      }

      case 'clear': {
        // Clear all caches, or filter by repo URL substring if provided
        const names = await caches.keys();
        let cleared = 0;
        for (const name of names) {
          if (repo) {
            // Selective clear: delete only entries matching the repo
            const cache = await caches.open(name);
            const keys = await cache.keys();
            for (const req of keys) {
              if (req.url.includes(repo)) {
                await cache.delete(req);
                cleared++;
              }
            }
          } else {
            await caches.delete(name);
            cleared++;
          }
        }
        result = { cleared };
        break;
      }

      default:
        post(id, 'error', { message: `Unknown storage op: ${op}` });
        return;
    }

    post(id, 'storage', { result });
  } catch (e) {
    post(id, 'error', { message: e.message || String(e) });
  }
}

/**
 * Unload the current model and tokenizer.
 */
function unload(id) {
  model = null;
  tokenizer = null;
  currentRepo = null;
  post(id, 'ok', {});
}

// ---------- Message dispatcher ----------

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;

  try {
    switch (type) {
      case 'load':
        await loadModel(id, payload);
        break;
      case 'unload':
        unload(id);
        break;
      case 'applyChatTemplate':
        applyChatTemplate(id, payload);
        break;
      case 'generate':
        await generate(id, payload);
        break;
      case 'decode':
        decode(id, payload);
        break;
      case 'cancel':
        cancel(id);
        break;
      case 'tokenizerInfo':
        getTokenizerInfo(id);
        break;
      case 'storage':
        await storageOp(id, payload);
        break;
      default:
        post(id, 'error', { message: `Unknown message type: ${type}` });
    }
  } catch (e) {
    post(id, 'error', { message: e.message || String(e) });
  }
};
