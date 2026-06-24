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
  if (candidate) {
    // Try strict parse first, then a sequence of tolerant repairs.
    for (const attempt of [candidate, repairJson(candidate)]) {
      try {
        return JSON.parse(attempt);
      } catch (_) {
        /* try next */
      }
    }
  }

  // Last resort: the value never closed (e.g. generation hit the token cap
  // mid-JSON). Salvage by cutting back to the last fully-completed element and
  // closing the open brackets — so a truncated feature list still yields the
  // features that did complete.
  return salvageTruncatedJSON(s, start);
}

/**
 * Best-effort recovery of a truncated JSON object/array: walk from `start`,
 * find the last position where a nested element fully closed while still inside
 * the outer container, cut there, drop any trailing comma, and append the
 * brackets needed to close what remained open. Returns parsed value or null.
 */
function salvageTruncatedJSON(s, start) {
  let inStr = false;
  let esc = false;
  const stack = [];
  let cut = -1;
  let cutStack = null;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      stack.pop();
      // Closing an inner element while still inside an outer container marks a
      // safe truncation point (e.g. just after a complete feature object).
      if (stack.length > 0) { cut = i + 1; cutStack = stack.slice(); }
    }
  }
  if (cut < 0 || !cutStack) return null;
  let out = s.slice(start, cut).replace(/[\s,]+$/, '');
  for (let i = cutStack.length - 1; i >= 0; i--) out += cutStack[i];
  for (const attempt of [out, repairJson(out)]) {
    try { return JSON.parse(attempt); } catch (_) { /* try next */ }
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
 * Output-token ceiling for structured generation. We default this HIGH rather
 * than trying to predict the right size: generation early-stops as soon as the
 * streamed text is a complete JSON value (see makeCompleteJSON's stopWhen), so a
 * large ceiling is free for short outputs and only matters when the answer is
 * genuinely long. A big-context model (e.g. Gemma 4) gets more headroom.
 *
 * @param {{ getModelContext?: () => number }} [infer]
 * @returns {number}
 */
export function outputTokenCap(infer) {
  const ctx = infer && typeof infer.getModelContext === 'function' ? infer.getModelContext() : 0;
  return ctx >= 100000 ? 32768 : 8192;
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

/** Build a messages array from a system + user pair. */
function toMessages({ system, user }) {
  const msgs = [];
  if (system && system.trim()) msgs.push({ role: 'system', content: system });
  msgs.push({ role: 'user', content: user });
  return msgs;
}

/** A plain-text rendering of a prompt, used by the manual + mock + gemma4
 *  providers (no tokenizer template available) for the debug inspector. */
export function synthRendered({ system, user }) {
  const parts = [];
  if (system && system.trim()) parts.push(`### SYSTEM\n${system}`);
  parts.push(`### USER\n${user}`);
  return parts.join('\n\n');
}

/**
 * Wrap any raw `complete(text)` function with JSON extraction + one repair
 * retry. Mode-agnostic so local, manual, and mock all share the same parsing.
 *
 * @param {(p:{system?:string,user:string,genConfig?:object,signal?:AbortSignal})=>Promise<string>} complete
 */
export function makeCompleteJSON(complete) {
  return async function completeJSON({ system, user, schemaHint, genConfig, signal, onToken }) {
    const jsonSystem = [
      system || '',
      'You output ONLY valid JSON — no prose, no Markdown fences, no commentary.',
      schemaHint ? `The JSON must match this shape: ${schemaHint}` : '',
    ].filter(Boolean).join('\n');

    // Stop generating the moment the streamed text already parses as a complete
    // JSON value — avoids waiting out a small model that keeps emitting tokens
    // after the answer is done. Providers that ignore stopWhen (manual/mock)
    // simply never call it.
    const stopWhen = (acc) => parseJSONLoose(acc) !== null;

    const first = await complete({ system: jsonSystem, user, genConfig, signal, onToken, stopWhen });
    let parsed = parseJSONLoose(first);
    if (parsed !== null) return parsed;

    // One retry: feed the bad output back and demand corrected JSON only.
    const retryUser =
      `Your previous answer was not valid JSON. Re-output the SAME content as a single ` +
      `valid JSON value only.\n\nPrevious answer:\n${first}`;
    const second = await complete({ system: jsonSystem, user: retryUser, genConfig, signal, onToken, stopWhen });
    parsed = parseJSONLoose(second);
    if (parsed !== null) return parsed;
    throw new Error('Model did not return parseable JSON');
  };
}

/** Shared two-phase debug emitter factory. */
export function makeDebugEmitter(onDebug) {
  return function emitDebug(rec) {
    if (!onDebug) return;
    try { onDebug({ ts: Date.now(), ...rec }); } catch (_) { /* never let logging break inference */ }
  };
}

/**
 * Create the LOCAL inference provider (in-browser LLM via the Iris engine).
 *
 * @param {{ engine: import('../../../iris/src/engine/client.js').EngineClient, onDebug?:Function }} opts
 */
export function createInference({ engine, onDebug }) {
  let loaded = false;
  let callSeq = 0; // unique id per model call so the debug drawer can update an entry in place
  const emitDebug = makeDebugEmitter(onDebug);

  function setModelLoaded(v) { loaded = !!v; }
  function isReady() { return loaded; }

  async function complete({ system, user, genConfig, signal, onToken, stopWhen }) {
    if (!loaded) throw new Error('No model loaded');
    const callId = ++callSeq;
    const messages = toMessages({ system, user });
    // Log the INPUT immediately — BEFORE applyChatTemplate, which can itself be
    // slow on first use (tokenizer warmup). This guarantees the inspector shows
    // the system + user prompt the instant a call begins, even if templating or
    // generation then hangs. The exact rendered prompt is filled in just below.
    emitDebug({ callId, status: 'running', system, user });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // `rendered` is the exact templated prompt string the model sees — the most
    // faithful "what was sent" for the debug inspector.
    const { input_ids, rendered } = await engine.applyChatTemplate({ messages, thinking: false });
    // Update the same entry in place now that the rendered prompt is available.
    emitDebug({ callId, status: 'running', system, user, rendered });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    let userAborted = false;
    let earlyStopped = false; // stopWhen fired — a graceful early finish, NOT an abort
    const onAbort = () => { userAborted = true; engine.cancel(); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const startedAt = Date.now();

    // Accumulate streamed text so we can (a) show live progress in the debug
    // drawer, (b) feed callers a running tally, and (c) stop generation as soon
    // as the output already contains everything we need (stopWhen) — small
    // models otherwise keep rambling up to max_new_tokens long after the JSON
    // is complete, which looks like an endless hang.
    let acc = '';
    let lastDebugEmit = 0;
    const innerOnToken = (payload) => {
      const t = payload && payload.text ? payload.text : '';
      if (t) acc += t;
      const now = Date.now();
      if (now - lastDebugEmit > 250) {
        lastDebugEmit = now;
        emitDebug({ callId, status: 'running', system, user, rendered, output: stripControlTokens(acc) });
      }
      if (onToken) { try { onToken(payload, acc); } catch (_) { /* ignore */ } }
      // Only test the (relatively expensive) predicate when a closing bracket
      // just arrived — cheap gate that still catches a completed JSON value.
      if (stopWhen && !earlyStopped && !userAborted && (t.includes('}') || t.includes(']'))) {
        try { if (stopWhen(acc)) { earlyStopped = true; engine.cancel(); } } catch (_) { /* ignore */ }
      }
    };

    try {
      const { outputText, stats } = await engine.generate({
        input_ids,
        genConfig: { ...EXAMINER_GENCONFIG, ...(genConfig || {}) },
        onToken: innerOnToken,
      });
      // A user-initiated abort (not an early stop) is an error path.
      if (userAborted && !earlyStopped) throw new DOMException('Aborted', 'AbortError');
      const cleaned = stripControlTokens(outputText || acc);
      emitDebug({ callId, status: 'done', ms: Date.now() - startedAt, ok: true, system, user, rendered, raw: outputText, output: cleaned, stats: { ...(stats || {}), earlyStopped } });
      return cleaned;
    } catch (e) {
      if (e.name !== 'AbortError') {
        emitDebug({ callId, status: 'error', ms: Date.now() - startedAt, ok: false, system, user, rendered, error: e.message || String(e) });
      }
      throw e;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  const completeJSON = makeCompleteJSON(complete);
  return { mode: 'local', setModelLoaded, isReady, complete, completeJSON };
}

/**
 * Create the MANUAL (copy-paste) inference provider. The app shows the full
 * prompt; the user pastes it into any external AI and pastes the answer back.
 *
 * @param {{ onPrompt:(p:{system?:string,user:string,rendered:string,signal?:AbortSignal})=>Promise<string>, onDebug?:Function }} opts
 */
export function createManualInference({ onPrompt, onDebug }) {
  let callSeq = 0;
  const emitDebug = makeDebugEmitter(onDebug);

  async function complete({ system, user, signal }) {
    if (typeof onPrompt !== 'function') throw new Error('Copy-paste mode is not wired up');
    const callId = ++callSeq;
    const rendered = synthRendered({ system, user });
    emitDebug({ callId, status: 'running', system, user, rendered });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const startedAt = Date.now();
    try {
      const answer = await onPrompt({ system, user, rendered, signal });
      const cleaned = stripControlTokens(answer || '');
      emitDebug({ callId, status: 'done', ms: Date.now() - startedAt, ok: true, system, user, rendered, raw: answer, output: cleaned });
      return cleaned;
    } catch (e) {
      if (e.name !== 'AbortError') {
        emitDebug({ callId, status: 'error', ms: Date.now() - startedAt, ok: false, system, user, rendered, error: e.message || String(e) });
      }
      throw e;
    }
  }

  const completeJSON = makeCompleteJSON(complete);
  return { mode: 'manual', setModelLoaded() {}, isReady: () => typeof onPrompt === 'function', complete, completeJSON };
}

/**
 * Create the MOCK (debug) inference provider. No AI is called — deterministic
 * canned output lets the full workflow (Google Patents fetch, table + matrix
 * UI, export) be exercised quickly.
 *
 * @param {{ onDebug?:Function }} [opts]
 */
export function createMockInference({ onDebug } = {}) {
  let callSeq = 0;
  const emitDebug = makeDebugEmitter(onDebug);

  async function complete({ system, user, signal }) {
    const callId = ++callSeq;
    const rendered = synthRendered({ system, user });
    emitDebug({ callId, status: 'running', system, user, rendered });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const startedAt = Date.now();
    const out = mockResponse({ system, user });
    emitDebug({ callId, status: 'done', ms: Date.now() - startedAt, ok: true, system, user, rendered, raw: out, output: out, stats: { mock: true } });
    return out;
  }

  const completeJSON = makeCompleteJSON(complete);
  return { mode: 'mock', setModelLoaded() {}, isReady: () => true, complete, completeJSON };
}

/**
 * Produce deterministic canned JSON for mock mode by sniffing the prompt's
 * target shape (extraction vs mapping) from the appended schema hint.
 */
let mockVerdictTick = 0;
function mockResponse({ system, user }) {
  const probe = `${system || ''}\n${user || ''}`;
  if (probe.includes('"features"')) {
    // Extraction: emit two fake features per claim number found in the prompt.
    const claimNums = [];
    const re = /(?:^|\n)\s*(?:claim\s+)?(\d+)\s*[.)]/gi;
    let m;
    while ((m = re.exec(user || '')) !== null) {
      const n = parseInt(m[1], 10);
      if (!claimNums.includes(n)) claimNums.push(n);
    }
    if (claimNums.length === 0) claimNums.push(1);
    const features = [];
    for (const n of claimNums) {
      features.push({ claim: n, feature: `[MOCK] primary element of claim ${n}`, evidence: `(mock evidence for claim ${n})`, type: 'component' });
      features.push({ claim: n, feature: `[MOCK] secondary limitation of claim ${n}`, evidence: `(mock evidence for claim ${n})`, type: 'relationship' });
    }
    return JSON.stringify({ features });
  }
  const labelMatch = (user || '').match(/(\[[^\]]+\]|claim\s+\d+)\s*:/i);
  const label = labelMatch ? labelMatch[1] : '[0001]';
  if (probe.includes('"results"')) {
    // Batch mapping: one result per feature id listed as "- N.M: ..." in the user prompt.
    const ids = [];
    const re = /(?:^|\n)\s*-\s*(\d+\.\d+)\s*:/g;
    let m;
    while ((m = re.exec(user || '')) !== null) ids.push(m[1]);
    if (ids.length === 0) ids.push('1.1');
    const results = ids.map((id, i) => {
      const verdict = ['Y', 'P', 'N'][i % 3];
      return { featureId: id, verdict, citations: verdict === 'N' ? [] : [{ label, quote: '(mock verbatim quote)' }], explanation: `[MOCK] deterministic ${verdict} verdict.` };
    });
    return JSON.stringify({ results });
  }
  if (probe.includes('"verdict"')) {
    // Single-feature mapping: cycle Y / P / N deterministically.
    const verdict = ['Y', 'P', 'N'][mockVerdictTick++ % 3];
    const citations = verdict === 'N' ? [] : [{ label, quote: '(mock verbatim quote)' }];
    return JSON.stringify({ verdict, citations, explanation: `[MOCK] deterministic ${verdict} verdict for workflow testing.` });
  }
  return '{}';
}

/**
 * Route cognition calls to the active provider based on the current mode.
 * The cognition modules depend only on this stable surface; switching mode at
 * runtime needs no re-wiring.
 *
 * @param {{ local:object, manual:object, mock:object, getMode:()=>string }} opts
 */
export function createInferenceRouter({ local, manual, mock, getMode }) {
  // Context window (tokens) of the currently-loaded local model, set by the UI
  // on load/unload. Used for auto-selecting the Step 2 mapping batch size.
  let modelContext = 0;
  function active() {
    const m = getMode ? getMode() : 'local';
    if (m === 'manual') return manual;
    if (m === 'mock') return mock;
    return local;
  }
  return {
    // Model load state only applies to the local provider.
    setModelLoaded: (v) => local.setModelLoaded(v),
    setModelContext: (n) => { modelContext = Number(n) || 0; },
    getModelContext: () => modelContext,
    // Load/unload route to the local backend (transformers or gemma4 dispatcher).
    load: (preset, opts) => local.load(preset, opts),
    unload: () => local.unload(),
    // Readiness is mode-aware: manual/mock need no loaded model.
    isReady: () => active().isReady(),
    getMode: () => (getMode ? getMode() : 'local'),
    complete: (p) => active().complete(p),
    completeJSON: (p) => active().completeJSON(p),
  };
}

/**
 * Local backend dispatcher: the "local" execution mode can be served by either
 * the transformers.js worker (Qwen/Llama/most models) or the bespoke Gemma 4
 * WebGPU runtime, depending on the selected preset's `engine`. Presents the same
 * surface as a single provider, plus load(preset)/unload().
 *
 * @param {{ engine: object, transformers: object, gemma4: object }} opts
 */
export function createLocalDispatcher({ engine, transformers, gemma4 }) {
  let active = transformers;

  return {
    mode: 'local',
    async load(preset, { onProgress } = {}) {
      if (preset && preset.engine === 'gemma4') {
        active = gemma4;
        return gemma4.load({ onProgress });
      }
      active = transformers;
      const res = await engine.load({
        repo: preset.repo, dtype: preset.dtype, device: 'auto', onProgress,
      });
      transformers.setModelLoaded(true);
      return res;
    },
    async unload() {
      if (active === gemma4) { await gemma4.unload(); }
      else { await engine.unload(); transformers.setModelLoaded(false); }
    },
    setModelLoaded: (v) => { if (active === transformers) transformers.setModelLoaded(v); },
    isReady: () => active.isReady(),
    complete: (p) => active.complete(p),
    completeJSON: (p) => active.completeJSON(p),
  };
}

/**
 * Remove model control/special tokens that may leak into decoded text (the Iris
 * worker decodes with skip_special_tokens:false so protocol parsers can see them;
 * for examiner work we just strip the common ones).
 */
export function stripControlTokens(text) {
  if (!text) return '';
  return text
    .replace(/<\|?(?:end_of_turn|eot_id|im_end|im_start|start_of_turn|end|endoftext)\|?>/g, '')
    .replace(/<end_of_turn>|<bos>|<eos>/g, '')
    .trim();
}
