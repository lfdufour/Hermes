/**
 * features/prompts.js — Prompt assembly for feature extraction and mapping.
 *
 * The EDITABLE parts (system instructions + user template) live in the settings
 * store so they can be tuned at runtime without code changes. This module reads
 * those parts, substitutes the live data into the user template's placeholders,
 * and appends the FIXED output-structure block (the exact JSON shape the app
 * parses) to the system prompt — so edits can never break parsing.
 *
 * Prompts are designed for small local models:
 *   - Demand strict JSON only (no prose, no fences).
 *   - Include a compact shape example so the model knows the target.
 *   - For mapping: present passages with labels, instruct verbatim quoting.
 */

import { settings, STRUCTURE } from '../store/settings.js';

/** Substitute {{TOKEN}} placeholders; tokens absent from the template are
 *  ignored, and any provided value whose token is missing is dropped silently. */
function fill(template, values) {
  let out = String(template == null ? '' : template);
  for (const [token, value] of Object.entries(values)) {
    out = out.split(token).join(value == null ? '' : String(value));
  }
  return out;
}

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
 * @param {{ claimsText: string }}
 * @returns {{ system: string, user: string }}
 */
export function extractionPrompt({ claimsText }) {
  const editableSystem = settings.getPrompt('extractionSystem');
  const system = `${editableSystem}\n\n${STRUCTURE.extraction}`;

  let user = fill(settings.getPrompt('extractionUser'), { '{{CLAIMS}}': claimsText });
  // Safety net: if the user removed the {{CLAIMS}} placeholder, append the
  // claims so the model still receives them.
  if (!user.includes(claimsText)) {
    user += `\n\nCLAIMS:\n${claimsText}`;
  }

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
  const passageBlock = (passages || []).map(p =>
    `${p.label}: ${p.text.slice(0, 600)}`
  ).join('\n\n');

  const depBlock = dependencyContext
    ? `Dependency context (features this feature builds upon from the independent claim):\n${dependencyContext}\n`
    : '';

  const editableSystem = settings.getPrompt('mappingSystem');
  const system = `${editableSystem}\n\n${STRUCTURE.mapping}`;

  const user = fill(settings.getPrompt('mappingUser'), {
    '{{FEATURE_ID}}': feature.id,
    '{{FEATURE}}': feature.text,
    '{{DEPENDENCY}}': depBlock,
    '{{PASSAGES}}': passageBlock,
  });

  return { system, user };
}
