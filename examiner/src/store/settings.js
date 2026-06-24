/**
 * store/settings.js — App-global settings: execution mode + editable prompts.
 *
 * Two things live here, persisted to localStorage so they survive reloads and
 * can be tuned without code changes:
 *
 *  1. mode — how cognition calls are fulfilled:
 *       'local'  : run the local in-browser LLM (default).
 *       'manual' : copy-paste — the app shows the full prompt; the user pastes
 *                  it into any external AI and pastes the answer back.
 *       'mock'   : no AI at all — canned deterministic output so the workflow,
 *                  Google Patents fetching, table/matrix UI can be tested fast.
 *
 *  2. prompts — the EDITABLE parts of each prompt. Each prompt has an editable
 *     system block and an editable user template (with documented placeholders).
 *     The app always appends a FIXED "structure" block (the exact JSON shape it
 *     parses); that part is NOT editable, so edits can never break parsing.
 *
 * Pure/standalone: guards localStorage so it also imports cleanly under node.
 */

const STORAGE_KEY = 'hermes-examiner-settings';

/** The FIXED output-structure blocks. Appended to the editable system prompt;
 *  surfaced read-only in the UI so the user knows what not to touch. */
export const STRUCTURE = {
  extraction: `OUTPUT FORMAT (STRICT):
Return ONLY a JSON object in this exact structure:
{"features":[{"claim":1,"feature":"...","evidence":"...","type":"component"}]}
"type" is one of: component, method, parameter, relationship.
No extra text before or after the JSON.`,
  mapping: `OUTPUT FORMAT (STRICT):
Return ONLY a JSON object in this exact structure:
{"verdict":"Y","citations":[{"label":"[0023]","quote":"exact text from passage"}],"explanation":"Brief reasoned mapping."}
"verdict" is one of: Y, P, N.
No extra text before or after the JSON.`,
  mappingBatch: `OUTPUT FORMAT (STRICT):
Return ONLY a JSON object in this exact structure, with ONE entry per feature you were given:
{"results":[{"featureId":"1.1","verdict":"Y","citations":[{"label":"[0023]","quote":"exact text from passage"}],"explanation":"Brief reasoned mapping."}]}
"verdict" is one of: Y, P, N. Include EVERY feature id, in the same order.
No extra text before or after the JSON.`,
};

/** Placeholders the user can use in the editable user templates. */
export const PLACEHOLDERS = {
  extraction: ['{{CLAIMS}}'],
  mapping: ['{{FEATURE_ID}}', '{{FEATURE}}', '{{DEPENDENCY}}', '{{PASSAGES}}'],
};

/** Default EDITABLE prompt parts. The locked STRUCTURE above is appended to
 *  the system prompts automatically; do not repeat it here. */
export const DEFAULT_PROMPTS = {
  extractionSystem: `You are a patent analysis engine.

Your task is to convert a set of patent CLAIMS into a structured FEATURE TABLE.

You MUST follow these rules:
1. Only use information explicitly stated in the claims.
2. Do NOT infer, guess, or generalize beyond the text.
3. Split each claim into its atomic technical features — one technical element, step, structure, parameter, or relationship per feature.
4. Process ALL claims. For EVERY feature, record the number of the claim it comes from.
5. "evidence" MUST be the exact verbatim phrase from the claim that supports the feature — copy it, do not paraphrase.
6. Do not explain your reasoning.

FEATURE DEFINITION:
A feature is a concrete technical element, step, structure, parameter, or relationship.
Examples:
- physical component (e.g., "a sensor", "a valve", "a processor")
- method step (e.g., "detecting a signal", "transmitting data")
- parameter / constraint (e.g., "temperature above 50 deg C")
- relationship (e.g., "A connected to B")

IGNORE:
- legal boilerplate
- intended use
- advantages or effects unless structural/technical`,

  extractionUser: `Analyze the following claims according to the system instructions and return the feature table JSON only.

CLAIMS:
{{CLAIMS}}

Return JSON only:`,

  mappingSystem: `You are an EPO patent examiner assessing novelty. For a given technical feature, determine whether it is "directly and unambiguously derivable" from the prior-art document passages provided.

Verdict rules:
- Y = the feature is explicitly disclosed in the document passages.
- P = the feature is partially, implicitly, or ambiguously disclosed (some aspects present but not all, or requires interpretation).
- N = the feature is NOT disclosed. Do NOT invent or guess — if no passage matches, answer N.

Citation rules:
- For Y or P verdicts, you MUST provide at least one citation with the exact passage label and a verbatim quote copied from the passage text.
- Use the EXACT label provided (e.g. "[0023]", "claim 3"). Do NOT invent labels.
- The quote must be copied verbatim from the passage — do not paraphrase.
- For N verdicts, citations must be an empty array.`,

  mappingUser: `Assess this feature against the prior-art passages below.

Feature {{FEATURE_ID}}: {{FEATURE}}
{{DEPENDENCY}}
Prior-art passages:
{{PASSAGES}}

Return JSON only:`,
};

export const MODES = ['local', 'manual', 'mock'];
const DEFAULT_MODE = 'local';

/** How much of each prior-art document is shown to the model during Step 2
 *  mapping:
 *   'retrieval' — only the passages most lexically similar to the feature
 *                 (fast; small context; can miss paraphrased disclosure).
 *   'full'      — the entire description + claims (best recall regardless of
 *                 wording; needs a large-context model and is slower). */
export const MAPPING_CONTEXTS = ['retrieval', 'full'];
const DEFAULT_MAPPING_CONTEXT = 'retrieval';

/** How many features are assessed per model call in Step 2:
 *   'feature' — one feature per call (most reliable; slowest).
 *   'claim'   — all features of a claim in one call (claims are self-consistent;
 *               good speed/reliability balance — the default).
 *   'all'     — the entire feature table in a single call (fastest; needs a
 *               capable, large-context model or it may drop/garble features). */
export const MAPPING_BATCHES = ['feature', 'claim', 'all'];
const DEFAULT_MAPPING_BATCH = 'claim';

/** In-memory state, hydrated from localStorage on first access. */
let state = null;
const subs = new Set();

/** Safe localStorage read (returns null under node or if blocked). */
function readStorage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

/** Safe localStorage write. */
function writeStorage() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (_) { /* ignore quota / privacy-mode errors */ }
}

/** Hydrate state, merging stored values over defaults. */
function ensure() {
  if (state) return state;
  const stored = readStorage() || {};
  state = {
    mode: MODES.includes(stored.mode) ? stored.mode : DEFAULT_MODE,
    mappingContext: MAPPING_CONTEXTS.includes(stored.mappingContext) ? stored.mappingContext : DEFAULT_MAPPING_CONTEXT,
    mappingBatch: MAPPING_BATCHES.includes(stored.mappingBatch) ? stored.mappingBatch : DEFAULT_MAPPING_BATCH,
    prompts: { ...DEFAULT_PROMPTS, ...(stored.prompts || {}) },
  };
  return state;
}

/** Notify subscribers of any change. */
function emit() {
  for (const fn of subs) { try { fn(state); } catch (_) { /* ignore */ } }
}

export const settings = {
  // --- mode ---
  getMode() { return ensure().mode; },
  setMode(mode) {
    if (!MODES.includes(mode)) return;
    ensure().mode = mode;
    writeStorage();
    emit();
  },

  // --- mapping context (how much of each document to show during Step 2) ---
  getMappingContext() { return ensure().mappingContext; },
  setMappingContext(ctx) {
    if (!MAPPING_CONTEXTS.includes(ctx)) return;
    ensure().mappingContext = ctx;
    writeStorage();
    emit();
  },

  // --- mapping batch (how many features per model call in Step 2) ---
  getMappingBatch() { return ensure().mappingBatch; },
  setMappingBatch(b) {
    if (!MAPPING_BATCHES.includes(b)) return;
    ensure().mappingBatch = b;
    writeStorage();
    emit();
  },

  // --- prompts ---
  /** @param {keyof DEFAULT_PROMPTS} key */
  getPrompt(key) {
    const p = ensure().prompts;
    return p[key] != null ? p[key] : (DEFAULT_PROMPTS[key] || '');
  },
  /** @param {keyof DEFAULT_PROMPTS} key */
  setPrompt(key, value) {
    if (!(key in DEFAULT_PROMPTS)) return;
    ensure().prompts[key] = String(value);
    writeStorage();
    emit();
  },
  /** Reset a single editable prompt back to its default. */
  resetPrompt(key) {
    if (!(key in DEFAULT_PROMPTS)) return;
    ensure().prompts[key] = DEFAULT_PROMPTS[key];
    writeStorage();
    emit();
  },
  /** Reset all editable prompts. */
  resetAllPrompts() {
    ensure().prompts = { ...DEFAULT_PROMPTS };
    writeStorage();
    emit();
  },

  /** Subscribe to settings changes; returns an unsubscribe fn. */
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
};
