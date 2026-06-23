/**
 * engine/infer.js — Generic local inference for Hermes Patent Examiner.
 *
 * Thin layer over the reused Iris EngineClient. The app never issues LLM
 * tool-calls; it only needs two things from the model:
 *   - complete()      : a chat completion returning raw text
 *   - completeJSON()  : the same, but extract + repair a single JSON value
 *
 * Keeping this isolated means the cognition modules (features/, mapping/) depend
 * only on a tiny, model-agnostic surface — any of the registry models works,
 * because encoding uses the tokenizer's own chat template inside the worker.
 */

/**
 * Best-effort extraction of the first JSON object/array from arbitrary model
 * text. Handles code fences, leading prose, single quotes, trailing commas, and
 * stray text after the JSON. Returns null if nothing parseable is found.
 *
 * Exported standalone so it can be unit-tested under node with zero deps.
 *
 * @param {string} text
 * @returns {any|null}
 */
export function parseJSONLoose(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  if (!s) return null;

  // Strip Markdown code fences (```json ... ``` or ``` ... ```).
  s = s.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '');

  // Find the first JSON value by scanning for an opening bracket/brace and
  // matching to its balanced close (string-aware, so braces in strings don't
  // confuse the matcher).
  const start = firstJsonStart(s);
  if (start < 0) return null;
  const candidate = sliceBalanced(s, start);
  if (!candidate) return null;

  // Try strict parse first, then a sequence of tolerant repairs.
  const attempts = [candidate, repairJson(candidate)];
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch (_) {
      /* try next */
    }
  }
  return null;
}

/** Index of the first '{' or '[' in s, or -1. */
function firstJsonStart(s) {
  const obj = s.indexOf('{');
  const arr = s.indexOf('[');
  if (obj < 0) return arr;
  if (arr < 0) return obj;
  return Math.min(obj, arr);
}

/**
 * Return the balanced JSON substring starting at index `start` (which must point
 * at '{' or '['), or null if no balanced close is found. String-aware: ignores
 * brackets inside double-quoted strings and respects escapes.
 */
function sliceBalanced(s, start) {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Light-touch JSON repair for common small-model output quirks:
 *   - single-quoted strings -> double-quoted
 *   - trailing commas before } or ]
 *   - Python literals True/False/None
 * Kept conservative so it doesn't corrupt valid JSON.
 */
function repairJson(s) {
  let out = s;
  // True/False/None -> JSON
  out = out.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
  // Remove trailing commas: , followed by optional ws then } or ]
  out = out.replace(/,(\s*[}\]])/g, '$1');
  // Convert single-quoted strings to double-quoted ONLY when the string contains
  // no double quotes (avoids mangling apostrophes inside double-quoted strings).
  out = out.replace(/'([^'"\\]*)'/g, '"$1"');
  return out;
}

/**
 * Default generation config for examiner work: low temperature for faithful,
 * deterministic structured output.
 */
export const EXAMINER_GENCONFIG = {
  do_sample: false,
  temperature: 0.2,
  top_p: 0.9,
  max_new_tokens: 1024,
  repetition_penalty: 1.05,
};

/**
 * Create the inference facade.
 *
 * @param {{ engine: import('../../../iris/src/engine/client.js').EngineClient }} opts
 */
export function createInference({ engine, onDebug }) {
  let loaded = false;

  /** @param {boolean} v */
  function setModelLoaded(v) { loaded = !!v; }
  function isReady() { return loaded; }

  /** Emit a debug record (sent prompt + received output) to the optional sink. */
  function emitDebug(rec) {
    if (!onDebug) return;
    try { onDebug({ ts: Date.now(), ...rec }); } catch (_) { /* never let logging break inference */ }
  }

  /**
   * Build a messages array from a system + user pair.
   * @param {{system?:string, user:string}} p
   */
  function toMessages({ system, user }) {
    const msgs = [];
    if (system && system.trim()) msgs.push({ role: 'system', content: system });
    msgs.push({ role: 'user', content: user });
    return msgs;
  }

  /**
   * Run a chat completion and return the raw text.
   * @param {{system?:string, user:string, genConfig?:object, signal?:AbortSignal, onToken?:Function}} p
   * @returns {Promise<string>}
   */
  async function complete({ system, user, genConfig, signal, onToken }) {
    if (!loaded) throw new Error('No model loaded');
    const messages = toMessages({ system, user });
    // `rendered` is the exact templated prompt string the model sees — the most
    // faithful "what was sent" for the debug inspector.
    const { input_ids, rendered } = await engine.applyChatTemplate({ messages, thinking: false });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    let aborted = false;
    const onAbort = () => { aborted = true; engine.cancel(); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const startedAt = Date.now();
    try {
      const { outputText, stats } = await engine.generate({
        input_ids,
        genConfig: { ...EXAMINER_GENCONFIG, ...(genConfig || {}) },
        onToken: onToken || (() => {}),
      });
      if (aborted) throw new DOMException('Aborted', 'AbortError');
      const cleaned = stripControlTokens(outputText);
      emitDebug({ ms: Date.now() - startedAt, ok: true, system, user, rendered, raw: outputText, output: cleaned, stats });
      return cleaned;
    } catch (e) {
      if (e.name !== 'AbortError') {
        emitDebug({ ms: Date.now() - startedAt, ok: false, system, user, rendered, error: e.message || String(e) });
      }
      throw e;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Run a completion and parse a single JSON value from the output. Retries once
   * with a stricter "JSON only" nudge if the first parse fails.
   *
   * @param {{system?:string, user:string, schemaHint?:string, genConfig?:object, signal?:AbortSignal}} p
   * @returns {Promise<any>}
   */
  async function completeJSON({ system, user, schemaHint, genConfig, signal }) {
    const jsonSystem = [
      system || '',
      'You output ONLY valid JSON — no prose, no Markdown fences, no commentary.',
      schemaHint ? `The JSON must match this shape: ${schemaHint}` : '',
    ].filter(Boolean).join('\n');

    const first = await complete({ system: jsonSystem, user, genConfig, signal });
    let parsed = parseJSONLoose(first);
    if (parsed !== null) return parsed;

    // One retry: feed the bad output back and demand corrected JSON only.
    const retryUser =
      `Your previous answer was not valid JSON. Re-output the SAME content as a single ` +
      `valid JSON value only.\n\nPrevious answer:\n${first}`;
    const second = await complete({ system: jsonSystem, user: retryUser, genConfig, signal });
    parsed = parseJSONLoose(second);
    if (parsed !== null) return parsed;
    throw new Error('Model did not return parseable JSON');
  }

  return { setModelLoaded, isReady, complete, completeJSON };
}

/**
 * Remove model control/special tokens that may leak into decoded text (the Iris
 * worker decodes with skip_special_tokens:false so protocol parsers can see them;
 * for examiner work we just strip the common ones).
 */
function stripControlTokens(text) {
  if (!text) return '';
  return text
    .replace(/<\|?(?:end_of_turn|eot_id|im_end|im_start|start_of_turn|end|endoftext)\|?>/g, '')
    .replace(/<end_of_turn>|<bos>|<eos>/g, '')
    .trim();
}
