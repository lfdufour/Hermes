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
 * Build the system+user prompt for extracting features from a single claim.
 *
 * The model should decompose the claim into atomic technical features following
 * EPO methodology: two-part form detection (Rule 43(1) EPC), reference signs
 * (Rule 43(7)), claim category, and dependency detection.
 *
 * @param {{ claimText: string, claimNumber: number, allClaimsContext?: string }}
 * @returns {{ system: string, user: string }}
 */
export function extractionPrompt({ claimText, claimNumber, allClaimsContext }) {
  // NOTE: We include allClaimsContext (trimmed) so the model can resolve
  // "according to claim X" references and understand dependent claim numbering,
  // but extraction focuses on the single claim to keep prompts short.
  const contextBlock = allClaimsContext
    ? `\nAll claims (for reference only — analyze ONLY claim ${claimNumber}):\n${allClaimsContext.slice(0, 2000)}\n`
    : '';

  const system = `You are an EPO patent examiner assistant. You decompose patent claims into atomic technical features following EPO Guidelines for Examination.

Rules:
- Split the claim into atomic technical features (one technical limitation each).
- Detect two-part form (Rule 43(1) EPC): if the claim contains "characterized in that", "characterized by", or "the improvement comprising", features before that phrase are "preamble" (known from prior art), features after are "characterizing" (the contribution). If no such phrase exists, set portion to null and twoPart to false.
- Detect dependency: if the claim says "according to claim X", "of claim X", "as claimed in claim X", "claim X wherein", it is dependent. Extract the referenced claim numbers into dependsOn. Otherwise it is independent with dependsOn=[].
- Extract reference signs (Rule 43(7)): parenthetical numerals like (12), (3a), (100) go into refSigns array. They are non-limiting — include them in refSigns but keep them in the feature text as-is.
- Classify claim category: "product" for apparatus/device/system/composition claims, "process" for method/process/step claims, "use" for use claims. Null if unclear.
- Output STRICT JSON ONLY. No prose, no markdown fences, no commentary.`;

  const user = `Analyze claim ${claimNumber} and return a JSON object with this exact shape:
{"twoPart":false,"category":"product","type":"independent","dependsOn":[],"features":[{"text":"A widget (10) for processing data","portion":null,"refSigns":["10"]}]}
${contextBlock}
Claim ${claimNumber}:
${claimText}

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
