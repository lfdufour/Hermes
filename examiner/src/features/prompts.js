/**
 * features/prompts.js — EPO-aligned prompt templates for feature extraction
 * and feature-to-document mapping.
 *
 * Prompts are designed for small local models:
 *   - Demand strict JSON only (no prose, no fences).
 *   - Include a compact shape example so the model knows the target.
 *   - Keep inputs small (one claim at a time for extraction).
 *   - For mapping: present passages with labels, instruct verbatim quoting.
 */

/**
 * Build the system+user prompt for extracting a feature table from the FULL set
 * of claims in one pass.
 *
 * Deliberately simple — local models get confused by EPO formalities (two-part
 * form, reference signs, categories), so we ask only for what's wanted: a flat
 * list of atomic features, each tagged with the claim number it comes from and
 * the verbatim claim phrase that supports it. The app handles N.M numbering and
 * dependency detection deterministically. Processing all claims together lets
 * the model resolve cross-claim references ("the engine of claim 1").
 *
 * Based on a system prompt that empirically worked well on small local models.
 *
 * @param {{ claimsText: string }}
 * @returns {{ system: string, user: string }}
 */
export function extractionPrompt({ claimsText }) {
  const system = `You are a patent analysis engine.

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
- parameter / constraint (e.g., "temperature above 50°C")
- relationship (e.g., "A connected to B")

IGNORE:
- legal boilerplate
- intended use
- advantages or effects unless structural/technical

OUTPUT FORMAT (STRICT):
Return ONLY a JSON object in this exact structure:
{"features":[{"claim":1,"feature":"a sensor detecting temperature","evidence":"a sensor configured to detect a temperature","type":"component"}]}

"type" is one of: component, method, parameter, relationship.
No extra text before or after the JSON.`;

  const user = `Analyze the following claims according to the system instructions and return the feature table JSON only.

CLAIMS:
${claimsText}

Return JSON only:`;

  return { system, user };
}

/**
 * Build the system+user prompt for mapping a single feature against a
 * prior-art document's relevant passages.
 *
 * The model must apply the EPO "directly and unambiguously derivable"
 * novelty standard and return a verdict with verbatim citations.
 *
 * @param {{ feature: import('../types.js').Feature, dependencyContext: string, passages: import('../types.js').Passage[] }}
 * @returns {{ system: string, user: string }}
 */
export function mappingPrompt({ feature, dependencyContext, passages }) {
  // NOTE: We limit passage text to keep the prompt within token budgets
  // for small models. Each passage is presented with its label so the model
  // can cite it verbatim.
  const passageBlock = passages.map(p =>
    `${p.label}: ${p.text.slice(0, 600)}`
  ).join('\n\n');

  const depBlock = dependencyContext
    ? `\nDependency context (features this feature builds upon from the independent claim):\n${dependencyContext}\n`
    : '';

  const system = `You are an EPO patent examiner assessing novelty. For a given technical feature, determine whether it is "directly and unambiguously derivable" from the prior-art document passages provided.

Verdict rules:
- Y = the feature is explicitly disclosed in the document passages.
- P = the feature is partially, implicitly, or ambiguously disclosed (some aspects present but not all, or requires interpretation).
- N = the feature is NOT disclosed. Do NOT invent or guess — if no passage matches, answer N.

Citation rules:
- For Y or P verdicts, you MUST provide at least one citation with the exact passage label and a verbatim quote copied from the passage text.
- Use the EXACT label provided (e.g. "[0023]", "claim 3"). Do NOT invent labels.
- The quote must be copied verbatim from the passage — do not paraphrase.
- For N verdicts, citations should be an empty array.

Output STRICT JSON ONLY. No prose, no markdown fences, no commentary.`;

  const user = `Assess this feature against the prior-art passages below.

Feature ${feature.id}: ${feature.text}
${depBlock}
Prior-art passages:
${passageBlock}

Return JSON with this exact shape:
{"verdict":"Y","citations":[{"label":"[0023]","quote":"exact text from passage"}],"explanation":"Brief reasoned mapping."}

Return JSON only:`;

  return { system, user };
}
