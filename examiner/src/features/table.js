/**
 * features/table.js — FeatureTable helpers: numbering, dependency context,
 * validation, and claims splitting.
 *
 * All functions are PURE (no I/O, no model calls) — fully node-testable.
 * These support the EPO examiner-style feature table construction.
 */

/**
 * Split a claims text blob into individual claims.
 *
 * Heuristic: each claim starts with a number followed by a period or
 * closing parenthesis at the beginning of a line (or after a double newline).
 * Handles "1. A device..." and "1) A device..." patterns, as well as
 * claims that start with "Claim 1:" or "Claim 1." style.
 *
 * @param {string} claimsText
 * @returns {{ num: number, text: string }[]}
 */
export function splitClaimsIntoUnits(claimsText) {
  if (!claimsText || typeof claimsText !== 'string') return [];
  const trimmed = claimsText.trim();
  if (!trimmed) return [];

  // NOTE: We try multiple claim-numbering patterns commonly found in patents:
  // "1." / "1)" / "Claim 1." / "Claim 1:" — all at the start of a line,
  // possibly after whitespace.
  const claimPattern = /(?:^|\n)\s*(?:claim\s+)?(\d+)\s*[.):\s]/gi;
  const matches = [];
  let m;
  while ((m = claimPattern.exec(trimmed)) !== null) {
    matches.push({ num: parseInt(m[1], 10), index: m.index });
  }

  if (matches.length === 0) {
    // Fallback: treat entire text as claim 1
    return [{ num: 1, text: trimmed }];
  }

  // Deduplicate: if the same claim number appears multiple times, keep only the first.
  // Also ensure we only take ascending claim numbers to avoid spurious matches.
  const seen = new Set();
  const deduped = [];
  for (const match of matches) {
    if (!seen.has(match.num)) {
      seen.add(match.num);
      deduped.push(match);
    }
  }

  const claims = [];
  for (let i = 0; i < deduped.length; i++) {
    const start = deduped[i].index;
    const end = i + 1 < deduped.length ? deduped[i + 1].index : trimmed.length;
    let text = trimmed.slice(start, end).trim();
    // Strip leading claim number prefix: "1. " or "Claim 1. " etc.
    text = text.replace(/^(?:claim\s+)?\d+\s*[.):\s]\s*/i, '').trim();
    claims.push({ num: deduped[i].num, text });
  }

  return claims;
}

/**
 * Assign EPO-style N.M identifiers to features, grouped by claim number.
 * Features within the same claim are numbered sequentially: 1.1, 1.2, ...
 *
 * @param {import('../types.js').Feature[]} features
 * @returns {import('../types.js').Feature[]}
 */
export function renumber(features) {
  if (!Array.isArray(features)) return [];

  // Group features by claim to assign sequential sub-numbers.
  const counters = {};
  return features.map(f => {
    const claim = f.claim || 1;
    counters[claim] = (counters[claim] || 0) + 1;
    return { ...f, id: `${claim}.${counters[claim]}` };
  });
}

/**
 * Build a dependency-context string for a feature: the texts of all inherited
 * features from the independent claim(s) that this feature's claim depends on.
 *
 * For an independent-claim feature, returns '' (no inherited context).
 * For a dependent-claim feature, returns the texts of features from each
 * claim in the dependency chain, so the mapping model understands what
 * the dependent feature builds upon.
 *
 * @param {import('../types.js').Feature} feature
 * @param {import('../types.js').FeatureTable} table
 * @returns {string}
 */
export function dependencyContext(feature, table) {
  if (!feature || !table || !Array.isArray(table.features)) return '';
  if (feature.type !== 'dependent' || !feature.dependsOn || feature.dependsOn.length === 0) {
    return '';
  }

  // Collect all claim numbers in the dependency chain (transitive).
  const allDeps = collectTransitiveDeps(feature.dependsOn, table.claims || []);

  // Gather features from those claims, ordered by their id.
  const inherited = table.features
    .filter(f => allDeps.has(f.claim))
    .sort((a, b) => {
      if (a.claim !== b.claim) return a.claim - b.claim;
      return (a.id || '').localeCompare(b.id || '', undefined, { numeric: true });
    });

  if (inherited.length === 0) return '';

  return inherited.map(f => `[${f.id}] ${f.text}`).join('\n');
}

/**
 * Collect transitive dependency claim numbers.
 * E.g., if claim 3 depends on claim 2 which depends on claim 1,
 * returns {1, 2} for claim 3.
 *
 * @param {number[]} directDeps
 * @param {import('../types.js').ClaimMeta[]} claims
 * @returns {Set<number>}
 */
function collectTransitiveDeps(directDeps, claims) {
  const result = new Set();
  const claimMap = new Map(claims.map(c => [c.num, c]));
  const queue = [...directDeps];
  while (queue.length > 0) {
    const num = queue.shift();
    if (result.has(num)) continue;
    result.add(num);
    const meta = claimMap.get(num);
    if (meta && meta.dependsOn) {
      for (const dep of meta.dependsOn) {
        if (!result.has(dep)) queue.push(dep);
      }
    }
  }
  return result;
}

/**
 * Validate a FeatureTable for structural integrity.
 *
 * Checks:
 * - table has claims and features arrays
 * - every feature has required fields (id, claim, type, text)
 * - every feature's claim number corresponds to a ClaimMeta entry
 * - dependent features have non-empty dependsOn
 * - independent features have empty dependsOn
 * - feature ids follow N.M pattern
 * - no duplicate feature ids
 *
 * @param {import('../types.js').FeatureTable} table
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateTable(table) {
  const errors = [];

  if (!table) {
    return { ok: false, errors: ['Table is null or undefined'] };
  }
  if (!Array.isArray(table.claims)) {
    errors.push('Missing or invalid claims array');
  }
  if (!Array.isArray(table.features)) {
    errors.push('Missing or invalid features array');
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const claimNums = new Set(table.claims.map(c => c.num));
  const featureIds = new Set();

  for (const f of table.features) {
    if (!f.id) {
      errors.push(`Feature missing id (claim ${f.claim})`);
    } else if (featureIds.has(f.id)) {
      errors.push(`Duplicate feature id: ${f.id}`);
    } else {
      featureIds.add(f.id);
    }

    if (!/^\d+\.\d+$/.test(f.id || '')) {
      errors.push(`Feature id "${f.id}" does not follow N.M pattern`);
    }

    if (!f.text || typeof f.text !== 'string') {
      errors.push(`Feature ${f.id} has empty or missing text`);
    }

    if (!f.claim) {
      errors.push(`Feature ${f.id} missing claim number`);
    } else if (!claimNums.has(f.claim)) {
      errors.push(`Feature ${f.id} references claim ${f.claim} which is not in claims list`);
    }

    if (f.type === 'dependent' && (!f.dependsOn || f.dependsOn.length === 0)) {
      errors.push(`Dependent feature ${f.id} has empty dependsOn`);
    }

    if (f.type === 'independent' && f.dependsOn && f.dependsOn.length > 0) {
      errors.push(`Independent feature ${f.id} should have empty dependsOn`);
    }

    if (f.portion && !['preamble', 'characterizing'].includes(f.portion)) {
      errors.push(`Feature ${f.id} has invalid portion: ${f.portion}`);
    }
  }

  // Validate ClaimMeta entries
  for (const c of table.claims) {
    if (!c.num || typeof c.num !== 'number') {
      errors.push('Claim missing or invalid num');
    }
    if (!['independent', 'dependent'].includes(c.type)) {
      errors.push(`Claim ${c.num} has invalid type: ${c.type}`);
    }
    if (c.type === 'dependent' && (!c.dependsOn || c.dependsOn.length === 0)) {
      errors.push(`Dependent claim ${c.num} has empty dependsOn`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Detect whether claim text contains dependency references.
 * Returns the claim numbers referenced, or an empty array if independent.
 *
 * @param {string} claimText
 * @returns {number[]}
 */
export function detectDependency(claimText) {
  if (!claimText) return [];
  const patterns = [
    /(?:according to|of|as claimed in|as defined in|as set forth in)\s+claims?\s+(\d+(?:\s*(?:,|or|and|to)\s*\d+)*)/gi,
    /claims?\s+(\d+(?:\s*(?:,|or|and|to)\s*\d+)*)\s*,?\s*(?:wherein|where|in which|further comprising|additionally)/gi,
  ];
  const nums = new Set();
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(claimText)) !== null) {
      // Parse "1, 2, or 3" or "1 to 3" style references
      const ref = m[1];
      const individualNums = ref.match(/\d+/g);
      if (individualNums) {
        // Check for "X to Y" range pattern
        const rangeMatch = ref.match(/(\d+)\s+to\s+(\d+)/);
        if (rangeMatch) {
          const from = parseInt(rangeMatch[1], 10);
          const to = parseInt(rangeMatch[2], 10);
          for (let i = from; i <= to; i++) nums.add(i);
        } else {
          for (const n of individualNums) nums.add(parseInt(n, 10));
        }
      }
    }
  }
  return [...nums].sort((a, b) => a - b);
}

/**
 * Detect whether a claim is in two-part form (Rule 43(1) EPC).
 * Returns true if the claim contains "characterized in that", "characterized by",
 * or "the improvement comprising".
 *
 * @param {string} claimText
 * @returns {boolean}
 */
export function detectTwoPart(claimText) {
  if (!claimText) return false;
  return /\bcharacteri[sz]ed\s+(?:in\s+that|by)\b/i.test(claimText) ||
         /\bthe\s+improvement\s+comprising\b/i.test(claimText);
}

/**
 * Detect the claim category from the claim text.
 *
 * @param {string} claimText
 * @returns {import('../types.js').ClaimCategory}
 */
export function detectCategory(claimText) {
  if (!claimText) return null;
  const lower = claimText.toLowerCase();
  // NOTE: Order matters — check "use" first since "use of" is quite specific;
  // then method/process, then product/apparatus (default for device-like claims).
  if (/\buse\s+of\b/.test(lower) || /^a?\s*use\b/.test(lower.trim())) return 'use';
  if (/\b(?:method|process|step of)\b/.test(lower) || /\bcomprising\s+(?:the\s+)?steps?\s+of\b/.test(lower)) return 'process';
  if (/\b(?:apparatus|device|system|machine|equipment|composition|compound|arrangement|assembly|circuit|module|sensor|unit|kit)\b/.test(lower)) return 'product';
  // Fallback heuristic: "A ... comprising" at start often indicates product
  if (/^a\s+\w+.*\bcomprising\b/i.test(claimText.trim())) return 'product';
  return null;
}

/**
 * Extract reference signs (Rule 43(7)) from feature text.
 * These are parenthetical numerals/letters like (12), (3a), (100).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractRefSigns(text) {
  if (!text) return [];
  const matches = text.match(/\((\d+[a-z]?)\)/g);
  if (!matches) return [];
  return [...new Set(matches.map(m => m.slice(1, -1)))];
}
