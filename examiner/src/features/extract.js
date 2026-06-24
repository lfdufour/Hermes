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
  detectCategory,
  extractRefSigns,
} from './table.js';

/**
 * Extract a FeatureTable from patent claims text (and optional description).
 *
 * Strategy: ONE model call over the full set of claims (not claim-by-claim) so
 * the model can resolve cross-claim references and so we don't pay per-claim
 * latency. The model returns a flat list of atomic features, each tagged with
 * its source claim number and a verbatim "evidence" phrase. Everything else —
 * N.M numbering, independent/dependent classification, dependency chains — is
 * derived deterministically by the app, not asked of the (small) model.
 *
 * @param {{
 *   infer: { completeJSON: Function },
 *   claims: string,
 *   description?: string,
 *   onProgress?: (p: { phase: string }) => void,
 *   signal?: AbortSignal
 * }} opts
 * @returns {Promise<import('../types.js').FeatureTable>}
 */
export async function extractFeatureTable({ infer, claims, description, onProgress, signal }) {
  const units = splitClaimsIntoUnits(claims);
  if (units.length === 0) {
    throw new Error('No claims could be parsed from the input text');
  }

  // Deterministic per-claim metadata (no model burden): dependency + category.
  /** @type {import('../types.js').ClaimMeta[]} */
  const claimsMeta = units.map(u => {
    const dependsOn = detectDependency(u.text);
    return {
      num: u.num,
      type: dependsOn.length > 0 ? 'dependent' : 'independent',
      dependsOn,
      category: detectCategory(u.text),
      twoPart: false,
    };
  });
  const metaByNum = new Map(claimsMeta.map(c => [c.num, c]));
  const validClaimNums = new Set(units.map(u => u.num));

  if (onProgress) onProgress({ phase: 'analyzing' });
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  // Single pass over ALL claims.
  const prompt = extractionPrompt({ claimsText: claims });
  let result;
  // Live progress: report a streamed-character tally (throttled) so a slow
  // generation never looks frozen.
  const startedAt = Date.now();
  let lastReport = 0;
  const onToken = (_payload, acc) => {
    const now = Date.now();
    if (onProgress && now - lastReport > 200) {
      lastReport = now;
      onProgress({ phase: 'analyzing', chars: (acc || '').length, ms: now - startedAt });
    }
  };
  try {
    result = await infer.completeJSON({
      system: prompt.system,
      user: prompt.user,
      schemaHint: '{"features":[{"claim":int,"feature":str,"evidence":str,"type":str}]}',
      // Each claim yields several features, each with a verbatim "evidence"
      // string, so the output grows with claim count. Scale the ceiling so a
      // large claim set isn't truncated mid-JSON. Generation early-stops once a
      // complete JSON value is produced, so a high ceiling costs nothing when
      // the output is short.
      genConfig: { max_new_tokens: Math.min(8192, 1536 + units.length * 384) },
      signal,
      onToken,
    });
  } catch (err) {
    // A user cancel must propagate — never fabricate a fallback table from a
    // deliberate abort (that previously produced a confusing one-feature-per-
    // claim result). Only genuine model errors fall through to the fallback.
    if (err && err.name === 'AbortError') throw err;
    console.warn('Feature extraction failed:', err.message);
    result = null;
  }

  if (onProgress) onProgress({ phase: 'assembling' });

  /** @type {import('../types.js').Feature[]} */
  const allFeatures = [];
  const rawFeatures = result && Array.isArray(result.features) ? result.features : [];
  for (const rf of rawFeatures) {
    if (!rf) continue;
    const text = typeof rf.feature === 'string' ? rf.feature.trim()
      : typeof rf.text === 'string' ? rf.text.trim() : '';
    if (!text) continue;

    // Resolve the owning claim; fall back to the first claim if the model
    // emitted a claim number we don't recognize.
    let claimNum = parseInt(rf.claim, 10);
    if (isNaN(claimNum) || !validClaimNums.has(claimNum)) claimNum = units[0].num;
    const meta = metaByNum.get(claimNum) || claimsMeta[0];

    allFeatures.push({
      id: '', // assigned by renumber
      claim: claimNum,
      type: meta.type,
      dependsOn: meta.dependsOn,
      text,
      evidence: typeof rf.evidence === 'string' ? rf.evidence.trim() : '',
      portion: null,
      refSigns: extractRefSigns(text),
      category: meta.category,
    });
  }

  // Fallback: if the model returned nothing usable, seed one feature per claim
  // from the claim text so the examiner has something to edit.
  if (allFeatures.length === 0) {
    for (const u of units) {
      const meta = metaByNum.get(u.num);
      allFeatures.push({
        id: '',
        claim: u.num,
        type: meta.type,
        dependsOn: meta.dependsOn,
        text: u.text.trim(),
        evidence: u.text.trim(),
        portion: null,
        refSigns: extractRefSigns(u.text),
        category: meta.category,
      });
    }
  }

  // Group features by claim (stable within a claim) so N.M numbering runs
  // cleanly: claim 1 features first (1.1, 1.2, …), then claim 2, etc.
  const ordered = allFeatures
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (a.f.claim - b.f.claim) || (a.i - b.i))
    .map(s => s.f);

  if (onProgress) onProgress({ phase: 'done' });

  const numberedFeatures = renumber(ordered);
  return { claims: claimsMeta, features: numberedFeatures };
}
