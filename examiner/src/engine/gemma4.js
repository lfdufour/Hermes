/**
 * engine/gemma4.js — Gemma 4 E2B provider (bespoke WebGPU runtime).
 *
 * Gemma 4's QAT-mobile ONNX weights use a 2-bit block-quantized embed table
 * whose `GatherBlockQuantized` op is NOT in the onnxruntime-web build bundled
 * with transformers.js — so the normal Iris worker can't run it. Instead we use
 * the self-contained WebGPU runtime from the webml-community Gemma 4 Space
 * (vendored at ./vendor/gemma-4-e2b.js), which ships its own WGSL kernels.
 *
 * This provider adapts that runtime's `Gemma4Mobile` class to the same
 * complete()/completeJSON() surface the cognition modules use, so it can sit
 * behind the local-backend dispatcher exactly like the transformers.js path.
 *
 * Runs on the main thread (the runtime is not worker-packaged) and requires
 * WebGPU; there is no WASM fallback for this model.
 */

import { makeCompleteJSON, makeDebugEmitter, synthRendered, stripControlTokens } from './infer.js';

// Lazy singleton import so the 550KB bundle is only fetched when Gemma 4 is
// actually selected, not on app start.
let Gemma4Mobile = null;
async function getGemmaClass() {
  if (!Gemma4Mobile) {
    const mod = await import('./vendor/gemma-4-e2b.js');
    Gemma4Mobile = mod.Gemma4Mobile;
    if (!Gemma4Mobile) throw new Error('Gemma4Mobile export missing from vendored bundle');
  }
  return Gemma4Mobile;
}

/** Best-effort normalization of the runtime's progress events into the shape
 *  the model bar expects ({ file, loaded, total, pct }). */
function normalizeProgress(p) {
  if (p == null) return { file: 'gemma-4-e2b', loaded: 0, total: 0, pct: 0 };
  if (typeof p === 'number') return { file: 'gemma-4-e2b', loaded: 0, total: 0, pct: p <= 1 ? p * 100 : p };
  const loaded = p.loaded ?? p.bytes ?? 0;
  const total = p.total ?? p.size ?? 0;
  let pct = p.pct ?? p.percent ?? (typeof p.progress === 'number' ? (p.progress <= 1 ? p.progress * 100 : p.progress) : undefined);
  if (pct == null) pct = total > 0 ? (loaded / total) * 100 : 0;
  return { file: p.file || p.name || p.status || 'gemma-4-e2b', loaded, total, pct };
}

/**
 * Create the Gemma 4 provider.
 * @param {{ onDebug?: Function }} [opts]
 */
export function createGemma4Inference({ onDebug } = {}) {
  let model = null;
  let callSeq = 0;
  const emitDebug = makeDebugEmitter(onDebug);

  async function load({ onProgress } = {}) {
    const Cls = await getGemmaClass();
    // load(null, …) uses the runtime's DEFAULT_MODEL_ID (gemma-4-E2B QAT mobile).
    model = await Cls.load(null, { onProgress: (p) => { if (onProgress) onProgress(normalizeProgress(p)); } });
    try { if (model.warmup) await model.warmup(); } catch (_) { /* warmup is best-effort */ }
    return { device: 'webgpu' };
  }

  async function unload() {
    try { model?.dispose?.(); } catch (_) { /* ignore */ }
    model = null;
  }

  function isReady() { return !!model; }

  async function complete({ system, user, signal, onToken, stopWhen, genConfig }) {
    if (!model) throw new Error('No model loaded');
    const callId = ++callSeq;
    const messages = [];
    if (system && system.trim()) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: user });
    const rendered = synthRendered({ system, user });
    emitDebug({ callId, status: 'running', system, user, rendered });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // Combine the user's abort signal with an internal one we trip on early stop.
    const ctrl = new AbortController();
    let earlyStopped = false;
    let userAborted = false;
    const onUserAbort = () => { userAborted = true; ctrl.abort(); };
    if (signal) signal.addEventListener('abort', onUserAbort, { once: true });

    const startedAt = Date.now();
    let acc = '';
    let lastEmit = 0;
    try {
      if (model.reset) { try { model.reset(); } catch (_) { /* ignore */ } }
      const maxNewTokens = (genConfig && genConfig.max_new_tokens) || 2048;
      const stream = model.generate(messages, { maxNewTokens, signal: ctrl.signal });
      for await (const chunk of stream) {
        // The runtime yields { text } with the FULL accumulated reply each step.
        const full = chunk && typeof chunk.text === 'string' ? chunk.text : '';
        const delta = full.length >= acc.length ? full.slice(acc.length) : full;
        acc = full;
        const now = Date.now();
        if (now - lastEmit > 250) {
          lastEmit = now;
          emitDebug({ callId, status: 'running', system, user, rendered, output: stripControlTokens(acc) });
        }
        if (onToken) { try { onToken({ text: delta }, acc); } catch (_) { /* ignore */ } }
        if (stopWhen && !earlyStopped && (delta.includes('}') || delta.includes(']'))) {
          try { if (stopWhen(acc)) { earlyStopped = true; ctrl.abort(); break; } } catch (_) { /* ignore */ }
        }
      }
      const cleaned = stripControlTokens(acc);
      emitDebug({ callId, status: 'done', ms: Date.now() - startedAt, ok: true, system, user, rendered, raw: acc, output: cleaned, stats: { earlyStopped } });
      return cleaned;
    } catch (e) {
      // An early-stop abort is a graceful finish — return what we have.
      if (earlyStopped && !userAborted) {
        const cleaned = stripControlTokens(acc);
        emitDebug({ callId, status: 'done', ms: Date.now() - startedAt, ok: true, system, user, rendered, raw: acc, output: cleaned, stats: { earlyStopped: true } });
        return cleaned;
      }
      if (e.name !== 'AbortError') {
        emitDebug({ callId, status: 'error', ms: Date.now() - startedAt, ok: false, system, user, rendered, error: e.message || String(e) });
      }
      throw e;
    } finally {
      if (signal) signal.removeEventListener('abort', onUserAbort);
    }
  }

  const completeJSON = makeCompleteJSON(complete);
  return { mode: 'local-gemma4', load, unload, setModelLoaded() {}, isReady, complete, completeJSON };
}
