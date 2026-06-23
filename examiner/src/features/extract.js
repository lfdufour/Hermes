/**
 * features/extract.js — Step 1: Claims(+description) -> FeatureTable.
 *
 * Orchestrates per-claim extraction via infer.completeJSON, assembles the
 * features into a FeatureTable, classifies independent/dependent + dependsOn,
 * detects two-part form, then renumbers.
 *
 * Each claim is sent to the model individually (small prompts for reliability
 * with local models). The model returns structured JSON per claim, which is
 * validated and normalized before assembly.
 */

import { extractionPrompt } from './prompts.js';
import {
  splitClaimsIntoUnits,
  renumber,
  detectDependency,
  detectTwoPart,
  detectCategory,
  extractRefSigns,
} from './table.js';

/**
 * Extract a FeatureTable from patent claims text (and optional description).
 *
 * @param {{
 *   infer: { completeJSON: Function },
 *   claims: string,
 *   description?: string,
 *   onProgress?: (p: { claim: number, total: number }) => void,
 *   signal?: AbortSignal
 * }} opts
 * @returns {Promise<import('../types.js').FeatureTable>}
 */
export async function extractFeatureTable({ infer, claims, description, onProgress, signal }) {
  const units = splitClaimsIntoUnits(claims);
  if (units.length === 0) {
    throw new Error('No claims could be parsed from the input text');
  }

  // NOTE: allClaimsContext is passed to the prompt so the model can resolve
  // dependency references, but we cap it to avoid bloating the prompt.
  const allClaimsContext = claims.slice(0, 3000);

  /** @type {import('../types.js').Feature[]} */
  const allFeatures = [];
  /** @type {import('../types.js').ClaimMeta[]} */
  const claimsMeta = [];

  for (const unit of units) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const prompt = extractionPrompt({
      claimText: unit.text,
      claimNumber: unit.num,
      allClaimsContext,
    });

    // NOTE: schemaHint gives the model a terse reminder of the expected shape,
    // on top of the example already in the user prompt.
    let result;
    try {
      result = await infer.completeJSON({
        system: prompt.system,
        user: prompt.user,
        schemaHint: '{"twoPart":bool,"category":str|null,"type":str,"dependsOn":int[],"features":[{"text":str,"portion":str|null,"refSigns":str[]}]}',
        signal,
      });
    } catch (err) {
      // If the model fails for one claim, continue with fallback
      // rather than aborting the entire extraction.
      console.warn(`Feature extraction failed for claim ${unit.num}:`, err.message);
      result = null;
    }

    // --- Normalize and validate model output ---
    const parsed = normalizeClaimResult(result, unit);

    // Build ClaimMeta
    claimsMeta.push({
      num: unit.num,
      type: parsed.type,
      dependsOn: parsed.dependsOn,
      category: parsed.category,
      twoPart: parsed.twoPart,
    });

    // Build Feature entries (without ids — renumber assigns those)
    for (const rawFeature of parsed.features) {
      allFeatures.push({
        id: '', // will be assigned by renumber
        claim: unit.num,
        type: parsed.type,
        dependsOn: parsed.dependsOn,
        text: rawFeature.text || '',
        portion: rawFeature.portion || null,
        refSigns: rawFeature.refSigns || [],
        category: parsed.category,
      });
    }

    if (onProgress) {
      onProgress({ claim: unit.num, total: units.length });
    }
  }

  // Assign EPO-style N.M ids
  const numberedFeatures = renumber(allFeatures);

  return { claims: claimsMeta, features: numberedFeatures };
}

/**
 * Normalize the raw model output for a single claim into a safe structure.
 * Guards against missing fields, wrong types, and model hallucinations.
 *
 * Falls back to heuristic detection (from table.js helpers) when the model
 * output is unreliable.
 *
 * @param {any} result - Raw parsed JSON from the model
 * @param {{ num: number, text: string }} unit - The claim unit
 * @returns {{ type: 'independent'|'dependent', dependsOn: number[], category: import('../types.js').ClaimCategory, twoPart: boolean, features: { text: string, portion: 'preamble'|'characterizing'|null, refSigns: string[] }[] }}
 */
function normalizeClaimResult(result, unit) {
  // --- Dependency detection: trust model if sensible, fall back to heuristic ---
  const heuristicDeps = detectDependency(unit.text);
  let dependsOn = [];
  if (result && Array.isArray(result.dependsOn) && result.dependsOn.length > 0) {
    dependsOn = result.dependsOn.map(n => parseInt(n, 10)).filter(n => !isNaN(n) && n > 0);
  }
  if (dependsOn.length === 0 && heuristicDeps.length > 0) {
    dependsOn = heuristicDeps;
  }
  const type = dependsOn.length > 0 ? 'dependent' : 'independent';

  // --- Two-part form: trust model, fall back to heuristic ---
  const heuristicTwoPart = detectTwoPart(unit.text);
  let twoPart = heuristicTwoPart; // prefer heuristic — it's reliable
  if (result && typeof result.twoPart === 'boolean') {
    // NOTE: Use model output only if it agrees OR heuristic didn't detect.
    // The heuristic is regex-based and very reliable for "characterized in that/by".
    twoPart = result.twoPart || heuristicTwoPart;
  }

  // --- Category ---
  const heuristicCat = detectCategory(unit.text);
  let category = heuristicCat;
  if (result && result.category && ['product', 'process', 'use'].includes(result.category)) {
    category = result.category;
  }

  // --- Features ---
  let features = [];
  if (result && Array.isArray(result.features)) {
    features = result.features
      .filter(f => f && typeof f.text === 'string' && f.text.trim())
      .map(f => ({
        text: f.text.trim(),
        portion: normalizePortion(f.portion, twoPart),
        refSigns: normalizeRefSigns(f.refSigns, f.text),
      }));
  }

  // Fallback: if model returned no features, create one feature from the whole claim text
  if (features.length === 0) {
    features = [{
      text: unit.text.trim(),
      portion: null,
      refSigns: extractRefSigns(unit.text),
    }];
  }

  return { type, dependsOn, category, twoPart, features };
}

/**
 * Normalize a portion value to the allowed enum.
 * @param {any} portion
 * @param {boolean} twoPart
 * @returns {'preamble'|'characterizing'|null}
 */
function normalizePortion(portion, twoPart) {
  if (!twoPart) return null;
  if (portion === 'preamble' || portion === 'characterizing') return portion;
  return null;
}

/**
 * Normalize refSigns from model output, falling back to extraction from text.
 * @param {any} modelRefSigns
 * @param {string} text
 * @returns {string[]}
 */
function normalizeRefSigns(modelRefSigns, text) {
  if (Array.isArray(modelRefSigns) && modelRefSigns.length > 0) {
    return modelRefSigns.map(s => String(s)).filter(Boolean);
  }
  return extractRefSigns(text || '');
}
