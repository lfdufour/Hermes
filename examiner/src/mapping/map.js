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
import { mappingPrompt } from '../features/prompts.js';
import { dependencyContext } from '../features/table.js';

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
    // Retrieve relevant passages using lexical overlap ranking
    // Dynamic import to avoid hard dependency at module load time.
    const { topPassages } = await import('../patent/retrieve.js');
    const passages = topPassages(feature.text, doc.passages || [], { k: 6 });

    // Build dependency context for dependent features
    const depCtx = dependencyContext(feature, table);

    // Build and send the mapping prompt
    const prompt = mappingPrompt({
      feature,
      dependencyContext: depCtx,
      passages,
    });

    const result = await infer.completeJSON({
      system: prompt.system,
      user: prompt.user,
      schemaHint: '{"verdict":"Y"|"N"|"P","citations":[{"label":str,"quote":str}],"explanation":str}',
      signal,
    });

    // Normalize the model output
    return normalizeCellResult(feature.id, result);
  } catch (err) {
    // NOTE: We never throw from mapFeature. If the model fails, signal
    // is aborted, or any other error occurs, we return an error CellResult
    // so the mapping matrix remains displayable.
    return {
      featureId: feature.id,
      verdict: 'N',
      citations: [],
      explanation: '',
      status: 'error',
      error: err.message || 'Unknown mapping error',
    };
  }
}

/**
 * Map all features in the table against a single prior-art document.
 * Emits onCell(cellResult) progressively as each feature completes.
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

  for (const feature of table.features) {
    if (signal?.aborted) {
      // Fill remaining features as errors
      cells.push({
        featureId: feature.id,
        verdict: 'N',
        citations: [],
        explanation: '',
        status: 'error',
        error: 'Aborted',
      });
      continue;
    }

    const cell = await mapFeature({ infer, feature, table, doc, signal });
    cells.push(cell);

    if (onCell) {
      onCell(cell);
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
