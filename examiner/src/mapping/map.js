/**
 * mapping/map.js — Step 2: per feature x document -> CellResult; per-doc summary.
 *
 * Implements the EPO novelty mapping: for each (feature, document) pair,
 * retrieves the most relevant passages, asks the model to assess disclosure
 * using the "directly and unambiguously derivable" standard, and returns
 * a CellResult with verdict, citations, and explanation.
 *
 * Never throws from mapFeature — returns a CellResult with status:'error'
 * on any failure, so the mapping matrix can always be displayed.
 */

// NOTE: topPassages is imported lazily inside mapFeature to avoid a hard
// dependency on ../patent/retrieve.js at module load time. That module is
// built by a sibling agent and may not exist yet during testing. The
// summarize() export (pure logic) must remain importable without it.
import { mappingPrompt, mappingPromptBatch } from '../features/prompts.js';
import { dependencyContext } from '../features/table.js';
import { settings } from '../store/settings.js';

/**
 * Choose how much of a document to show the model for a given set of features.
 *  - 'full': the ENTIRE document (all passages) so paraphrased/synonymous
 *    disclosure isn't missed by keyword matching. Needs a large-context model.
 *  - 'retrieval' (default): the lexically most-similar passages. When several
 *    features share a call (batching) we send the UNION of each feature's top
 *    passages so every feature has its relevant context.
 *
 * @param {import('../types.js').Feature[]} features
 * @param {import('../types.js').PriorArtDoc} doc
 */
async function selectContext(features, doc) {
  const allPassages = doc.passages || [];
  if (settings.getMappingContext() === 'full') {
    return { passages: allPassages, perPassageChars: 4000, totalChars: 120000 };
  }
  // Dynamic import to avoid a hard dependency at module load time.
  const { topPassages } = await import('../patent/retrieve.js');
  const perFeatureK = features.length > 1 ? 4 : 6; // fewer each when batching
  const seen = new Set();
  const union = [];
  for (const f of features) {
    for (const p of topPassages(f.text, allPassages, { k: perFeatureK })) {
      if (!seen.has(p.index)) { seen.add(p.index); union.push(p); }
    }
  }
  union.sort((a, b) => a.index - b.index);
  return { passages: union, perPassageChars: 600, totalChars: Infinity };
}

/** Combined dependency context for a group: union of the inherited-feature
 *  lines across the group, so the model sees what dependent features build on. */
function groupDependencyContext(features, table) {
  const lines = new Set();
  for (const f of features) {
    const c = dependencyContext(f, table);
    if (c) for (const line of c.split('\n')) { if (line.trim()) lines.add(line); }
  }
  return [...lines].join('\n');
}

/**
 * Map a single feature against a prior-art document.
 *
 * @param {{
 *   infer: { completeJSON: Function },
 *   feature: import('../types.js').Feature,
 *   table: import('../types.js').FeatureTable,
 *   doc: import('../types.js').PriorArtDoc,
 *   signal?: AbortSignal
 * }} opts
 * @returns {Promise<import('../types.js').CellResult>}
 */
export async function mapFeature({ infer, feature, table, doc, signal }) {
  try {
    const { passages, perPassageChars, totalChars } = await selectContext([feature], doc);
    const depCtx = dependencyContext(feature, table);

    const prompt = mappingPrompt({
      feature,
      dependencyContext: depCtx,
      passages,
      perPassageChars,
      totalChars,
    });

    const result = await infer.completeJSON({
      system: prompt.system,
      user: prompt.user,
      schemaHint: '{"verdict":"Y"|"N"|"P","citations":[{"label":str,"quote":str}],"explanation":str}',
      signal,
    });

    return normalizeCellResult(feature.id, result);
  } catch (err) {
    // NOTE: We never throw from mapFeature. If the model fails, signal
    // is aborted, or any other error occurs, we return an error CellResult
    // so the mapping matrix remains displayable.
    return errorCell(feature.id, err.message || 'Unknown mapping error');
  }
}

/**
 * Map a GROUP of features against one document in a single model call.
 * Returns one CellResult per input feature (a feature missing from the model's
 * response becomes an error cell). Never throws.
 *
 * @param {{
 *   infer: { completeJSON: Function },
 *   features: import('../types.js').Feature[],
 *   table: import('../types.js').FeatureTable,
 *   doc: import('../types.js').PriorArtDoc,
 *   signal?: AbortSignal
 * }} opts
 * @returns {Promise<import('../types.js').CellResult[]>}
 */
export async function mapFeatureGroup({ infer, features, table, doc, signal }) {
  try {
    const { passages, perPassageChars, totalChars } = await selectContext(features, doc);
    const depCtx = groupDependencyContext(features, table);

    const prompt = mappingPromptBatch({
      features,
      dependencyContext: depCtx,
      passages,
      perPassageChars,
      totalChars,
    });

    const result = await infer.completeJSON({
      system: prompt.system,
      user: prompt.user,
      schemaHint: '{"results":[{"featureId":str,"verdict":"Y"|"N"|"P","citations":[{"label":str,"quote":str}],"explanation":str}]}',
      // Room for one result object per feature; early-stops once JSON is complete.
      genConfig: { max_new_tokens: Math.min(4096, 512 + features.length * 220) },
      signal,
    });

    // Index results by featureId (accept a bare array too, for lenient models).
    const arr = result && Array.isArray(result.results) ? result.results
      : (Array.isArray(result) ? result : []);
    const byId = new Map();
    for (const r of arr) {
      if (r && r.featureId != null) byId.set(String(r.featureId).trim(), r);
    }

    return features.map(f => {
      const raw = byId.get(f.id);
      if (!raw) return errorCell(f.id, 'No verdict returned for this feature in the batch response.');
      return normalizeCellResult(f.id, raw);
    });
  } catch (err) {
    // Never throw — surface the failure as error cells so the matrix still renders.
    return features.map(f => errorCell(f.id, err.message || 'Batch mapping error'));
  }
}

/** Build an error CellResult. */
function errorCell(featureId, error) {
  return { featureId, verdict: 'N', citations: [], explanation: '', status: 'error', error };
}

/**
 * Resolve the effective batch granularity. When the "auto" setting is on, pick
 * it from the loaded model's context window: a very large context (≈Gemma 4's
 * 256K) → whole-table; a mid context (≈Qwen/Llama) → per-claim; tiny/unknown →
 * per-feature. Otherwise use the manual selection.
 * @param {{ getModelContext?: () => number }} infer
 * @returns {'feature'|'claim'|'all'}
 */
export function resolveBatch(infer) {
  if (!settings.getMappingBatchAuto()) return settings.getMappingBatch();
  const ctx = (infer && typeof infer.getModelContext === 'function') ? infer.getModelContext() : 0;
  if (ctx >= 200000) return 'all';
  if (ctx >= 16000) return 'claim';
  return 'feature';
}

/**
 * Partition features into model-call groups per the mapping-batch setting.
 * @param {import('../types.js').Feature[]} features
 * @param {'feature'|'claim'|'all'} batch
 * @returns {import('../types.js').Feature[][]}
 */
function groupFeatures(features, batch) {
  const list = Array.isArray(features) ? features : [];
  if (batch === 'all') return list.length ? [list.slice()] : [];
  if (batch === 'claim') {
    const byClaim = new Map();
    for (const f of list) {
      const key = f.claim != null ? f.claim : 0;
      if (!byClaim.has(key)) byClaim.set(key, []);
      byClaim.get(key).push(f);
    }
    return [...byClaim.values()];
  }
  return list.map(f => [f]); // 'feature'
}

/**
 * Map all features in the table against a single prior-art document.
 * Features are grouped per the mapping-batch setting (feature / claim / all) so
 * fewer model calls are made. Emits onCell(cellResult) progressively.
 *
 * @param {{
 *   infer: { completeJSON: Function },
 *   table: import('../types.js').FeatureTable,
 *   doc: import('../types.js').PriorArtDoc,
 *   onCell?: (cell: import('../types.js').CellResult) => void,
 *   signal?: AbortSignal
 * }} opts
 * @returns {Promise<{ cells: import('../types.js').CellResult[], summary: import('../types.js').DocSummary }>}
 */
export async function mapDocument({ infer, table, doc, onCell, signal }) {
  /** @type {import('../types.js').CellResult[]} */
  const cells = [];
  const batch = resolveBatch(infer);
  const groups = groupFeatures(table.features || [], batch);

  for (const group of groups) {
    if (signal?.aborted) {
      for (const f of group) {
        const cell = errorCell(f.id, 'Aborted');
        cells.push(cell);
        if (onCell) onCell(cell);
      }
      continue;
    }

    const groupCells = batch === 'feature'
      ? [await mapFeature({ infer, feature: group[0], table, doc, signal })]
      : await mapFeatureGroup({ infer, features: group, table, doc, signal });

    for (const cell of groupCells) {
      cells.push(cell);
      if (onCell) onCell(cell);
    }
  }

  const summary = summarize(table, cells);
  return { cells, summary };
}

/**
 * Summarize the mapping results for a document.
 *
 * EPO logic:
 * - If ALL independent-claim features have verdict Y → novelty-destroying (X).
 * - If many but not all features are disclosed (relevant in combination) → Y.
 * - Otherwise → background art (A).
 *
 * @param {import('../types.js').FeatureTable} table
 * @param {import('../types.js').CellResult[]} cells
 * @returns {import('../types.js').DocSummary}
 */
export function summarize(table, cells) {
  if (!table || !Array.isArray(cells) || !Array.isArray(table.features)) {
    return {
      disclosedCount: 0,
      partialCount: 0,
      totalCount: 0,
      independentFullyDisclosed: false,
      noveltyVerdict: 'No mapping data available.',
      suggestedCategory: 'A',
    };
  }

  const cellMap = new Map(cells.map(c => [c.featureId, c]));
  const total = table.features.length;

  let disclosed = 0;
  let partial = 0;

  for (const cell of cells) {
    if (cell.verdict === 'Y') disclosed++;
    else if (cell.verdict === 'P') partial++;
  }

  // Check if all independent-claim features are disclosed (verdict Y)
  const independentFeatures = table.features.filter(f => f.type === 'independent');
  const independentFullyDisclosed = independentFeatures.length > 0 &&
    independentFeatures.every(f => {
      const cell = cellMap.get(f.id);
      return cell && cell.verdict === 'Y';
    });

  // Determine suggested category
  let suggestedCategory = 'A';
  let noveltyVerdict = '';

  if (independentFullyDisclosed) {
    suggestedCategory = 'X';
    noveltyVerdict = `Novelty-destroying: all ${independentFeatures.length} independent-claim feature(s) are disclosed. ` +
      `The document anticipates the subject-matter of the independent claim(s).`;
  } else if (disclosed + partial > total / 2) {
    // NOTE: "many but not all" heuristic — if more than half of features
    // are at least partially disclosed, the document is relevant in combination (Y).
    suggestedCategory = 'Y';
    noveltyVerdict = `Relevant in combination: ${disclosed} feature(s) disclosed, ${partial} partially disclosed ` +
      `out of ${total} total. The document may be used in combination with other prior art.`;
  } else {
    suggestedCategory = 'A';
    noveltyVerdict = `Background art: ${disclosed} feature(s) disclosed, ${partial} partially disclosed ` +
      `out of ${total} total. The document provides technological background but does not anticipate ` +
      `or significantly contribute to an obviousness argument.`;
  }

  return {
    disclosedCount: disclosed,
    partialCount: partial,
    totalCount: total,
    independentFullyDisclosed,
    noveltyVerdict,
    suggestedCategory,
  };
}

/**
 * Normalize raw model output into a valid CellResult.
 * Guards against missing fields, coerces verdict to Y/N/P,
 * defaults citations to [], never throws.
 *
 * @param {string} featureId
 * @param {any} raw
 * @returns {import('../types.js').CellResult}
 */
function normalizeCellResult(featureId, raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      featureId,
      verdict: 'N',
      citations: [],
      explanation: 'Model returned invalid output.',
      status: 'done',
    };
  }

  // Coerce verdict to Y/N/P
  let verdict = 'N';
  if (typeof raw.verdict === 'string') {
    const v = raw.verdict.toUpperCase().trim();
    if (v === 'Y' || v === 'YES') verdict = 'Y';
    else if (v === 'P' || v === 'PARTIAL') verdict = 'P';
    else verdict = 'N';
  }

  // Normalize citations — must be an array of {label, quote}
  let citations = [];
  if (Array.isArray(raw.citations)) {
    citations = raw.citations
      .filter(c => c && typeof c === 'object')
      .map(c => ({
        label: String(c.label || ''),
        quote: String(c.quote || ''),
      }))
      .filter(c => c.label && c.quote);
  }

  // NOTE: For Y/P verdicts, citations should be present. If the model
  // returned none, we downgrade to a warning in the explanation but
  // do not change the verdict — the examiner can review.
  let explanation = typeof raw.explanation === 'string' ? raw.explanation : '';
  if ((verdict === 'Y' || verdict === 'P') && citations.length === 0) {
    explanation += ' [Warning: No citations provided for disclosure verdict.]';
  }

  return {
    featureId,
    verdict,
    citations,
    explanation: explanation.trim(),
    status: 'done',
  };
}
