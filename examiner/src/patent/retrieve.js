/**
 * retrieve.js — Deterministic offline lexical passage retrieval.
 *
 * Exports: topPassages.
 *
 * Ranks passages by term-frequency overlap with a query (feature text).
 * No network, no model — pure tokenization + stopword filtering + scoring.
 * This feeds the mapping step small, relevant context so small local models
 * stay accurate and within context limits.
 */

/**
 * Retrieve the top-k most relevant passages for a given feature text,
 * ranked by lexical overlap (TF-based scoring with stopword filtering).
 *
 * Deterministic and offline — no randomness, no network.
 *
 * @param {string} featureText - the feature/limitation to find passages for
 * @param {import('../types.js').Passage[]} passages - all passages from a document
 * @param {Object} [opts]
 * @param {number} [opts.k=6] - number of top passages to return
 * @returns {import('../types.js').Passage[]} top passages, highest-score first
 */
export function topPassages(featureText, passages, { k = 6 } = {}) {
  if (!passages || passages.length === 0) return [];
  if (!featureText || !featureText.trim()) return passages.slice(0, k);

  const queryTerms = tokenize(featureText);
  if (queryTerms.length === 0) return passages.slice(0, k);

  // Build a query term-frequency map
  const queryTF = termFrequency(queryTerms);

  // Score each passage
  const scored = passages.map(passage => {
    const passageTerms = tokenize(passage.text);
    const passageTF = termFrequency(passageTerms);
    const score = overlapScore(queryTF, passageTF, passageTerms.length);
    return { passage, score };
  });

  // Sort by score descending, then by original index ascending (stable tiebreaker)
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.passage.index - b.passage.index;
  });

  return scored.slice(0, k).map(s => s.passage);
}

// --- Internal helpers ---

/**
 * Common English stopwords to filter out of queries and passages.
 * Keeps technical terms salient.
 *
 * NOTE: This is intentionally a compact set. We include common function
 * words but NOT technical connectors like "comprising", "wherein",
 * "configured" which carry meaning in patent claims.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
  'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
  'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'under', 'over',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than',
  'too', 'very', 'just', 'also',
  'it', 'its', 'this', 'that', 'these', 'those', 'which', 'what',
  'who', 'whom', 'whose', 'where', 'when', 'how', 'there', 'here',
  'about', 'up', 'out', 'if', 'then', 'because', 'while', 'although',
  'i', 'we', 'you', 'he', 'she', 'they', 'me', 'us', 'him', 'her', 'them',
  'my', 'our', 'your', 'his', 'their',
  'said', 'one', 'two', 'first', 'second',
]);

/**
 * Tokenize text into lowercase alpha-numeric terms, filtering stopwords.
 * @param {string} text
 * @returns {string[]} filtered tokens
 */
function tokenize(text) {
  // Split on non-alphanumeric, lowercase, filter stopwords and very short tokens
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Build a term-frequency map from tokens.
 * @param {string[]} tokens
 * @returns {Map<string, number>}
 */
function termFrequency(tokens) {
  const tf = new Map();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }
  return tf;
}

/**
 * Compute overlap score between a query and a passage.
 *
 * For each query term, if the passage contains it, add:
 *   queryTF(term) * passageTF(term) / passageLength
 *
 * This naturally rewards passages that:
 * - Contain more of the query terms (coverage)
 * - Contain those terms more frequently (density)
 * - Are not excessively long (normalized by passage length)
 *
 * @param {Map<string, number>} queryTF
 * @param {Map<string, number>} passageTF
 * @param {number} passageLen - total number of tokens in passage
 * @returns {number}
 */
function overlapScore(queryTF, passageTF, passageLen) {
  if (passageLen === 0) return 0;

  let score = 0;
  for (const [term, qCount] of queryTF) {
    const pCount = passageTF.get(term) || 0;
    if (pCount > 0) {
      score += qCount * pCount / passageLen;
    }
  }
  return score;
}
