/**
 * exportReport.js — Export Case data as CSV or Markdown examiner search-report tables.
 *
 * Builds a features x documents matrix:
 *   Left columns: Feature ID, Claim, Type, Portion, Feature Text
 *   Per document: 3-column group (Verdict, Citations, Explanation)
 *   Footer: per-document DocSummary row/section
 *
 * Pure functions — no browser dependencies, fully node-testable.
 */

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/**
 * Escape a value for CSV (RFC 4180).
 * Wraps in double-quotes if the value contains commas, quotes, or newlines.
 * Internal double-quotes are doubled.
 * @param {string} val
 * @returns {string}
 */
function csvEscape(val) {
  const s = String(val ?? '');
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Join an array of values into a single CSV row string.
 * @param {string[]} cells
 * @returns {string}
 */
function csvRow(cells) {
  return cells.map(csvEscape).join(',');
}

// ---------------------------------------------------------------------------
// Shared matrix construction
// ---------------------------------------------------------------------------

/**
 * Format citations array into a human-readable string.
 * @param {import('../types.js').Citation[]} citations
 * @returns {string}
 */
function formatCitations(citations) {
  if (!citations || citations.length === 0) return '';
  return citations
    .map((c) => `${c.label}: "${c.quote}"`)
    .join('; ');
}

/**
 * Build the ordered list of documents that have mapping data or are loaded.
 * Uses the case.documents array order (insertion order from fetch).
 * @param {import('../types.js').Case} caseObj
 * @returns {import('../types.js').PriorArtDoc[]}
 */
function getRelevantDocs(caseObj) {
  // NOTE: Include all documents in the case, even if no mappings exist yet,
  // so the report reflects the full set of prior art considered.
  return caseObj.documents || [];
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

/**
 * Export the case's feature-mapping matrix as a CSV string.
 *
 * Layout:
 *   Feature ID | Claim | Type | Portion | Feature Text | [Doc1] Verdict | [Doc1] Citations | [Doc1] Explanation | ...
 *   (one row per feature)
 *   (blank separator row)
 *   Summary | | | | | [Doc1] Disclosed | [Doc1] Category | [Doc1] Verdict narrative | ...
 *
 * @param {import('../types.js').Case} caseObj
 * @returns {string}
 */
export function toCSV(caseObj) {
  const features = caseObj.table?.features || [];
  const docs = getRelevantDocs(caseObj);
  const rows = [];

  // -- Header row --
  const header = ['Feature ID', 'Claim', 'Type', 'Portion', 'Feature Text'];
  for (const doc of docs) {
    const label = doc.id || doc.number;
    header.push(`${label} Verdict`, `${label} Citations`, `${label} Explanation`);
  }
  rows.push(csvRow(header));

  // -- Feature rows --
  for (const f of features) {
    const cells = [
      f.id,
      String(f.claim),
      f.type || '',
      f.portion || '',
      f.text || '',
    ];
    for (const doc of docs) {
      const cell = caseObj.mappings?.[doc.id]?.[f.id];
      if (cell) {
        cells.push(cell.verdict || '', formatCitations(cell.citations), cell.explanation || '');
      } else {
        cells.push('', '', '');
      }
    }
    rows.push(csvRow(cells));
  }

  // -- Summary section --
  if (docs.length > 0) {
    // Blank separator
    rows.push('');

    // Summary header
    const summaryHeader = ['Summary', '', '', '', ''];
    for (const doc of docs) {
      const label = doc.id || doc.number;
      summaryHeader.push(`${label} Score`, `${label} Category`, `${label} Verdict`);
    }
    rows.push(csvRow(summaryHeader));

    // Summary data row
    const summaryData = ['', '', '', '', ''];
    for (const doc of docs) {
      const summary = caseObj.summaries?.[doc.id];
      if (summary) {
        summaryData.push(
          `${summary.disclosedCount}/${summary.totalCount} disclosed, ${summary.partialCount} partial`,
          summary.suggestedCategory || '',
          summary.noveltyVerdict || ''
        );
      } else {
        summaryData.push('', '', '');
      }
    }
    rows.push(csvRow(summaryData));

    // Independent claim disclosure row
    const indepRow = ['Independent claims fully disclosed?', '', '', '', ''];
    for (const doc of docs) {
      const summary = caseObj.summaries?.[doc.id];
      indepRow.push(
        summary ? (summary.independentFullyDisclosed ? 'Yes' : 'No') : '',
        '',
        ''
      );
    }
    rows.push(csvRow(indepRow));
  }

  return rows.join('\n');
}

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

/**
 * Escape pipe characters for Markdown table cells.
 * Also collapses newlines to spaces for table compatibility.
 * @param {string} val
 * @returns {string}
 */
function mdEscape(val) {
  return String(val ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * Export the case's feature-mapping matrix as a Markdown string.
 *
 * Renders an EPO examiner search-report style table with:
 *   - Title + metadata header
 *   - Feature matrix table
 *   - Per-document summary sections
 *
 * @param {import('../types.js').Case} caseObj
 * @returns {string}
 */
export function toMarkdown(caseObj) {
  const features = caseObj.table?.features || [];
  const docs = getRelevantDocs(caseObj);
  const lines = [];

  // -- Title --
  lines.push(`# Patent Examiner Search Report: ${caseObj.title || 'Untitled'}`);
  lines.push('');

  // -- Metadata --
  if (caseObj.meta?.applicant) {
    lines.push(`**Applicant:** ${caseObj.meta.applicant}`);
  }
  if (caseObj.meta?.applicationNo) {
    lines.push(`**Application No:** ${caseObj.meta.applicationNo}`);
  }
  if (caseObj.meta?.applicant || caseObj.meta?.applicationNo) {
    lines.push('');
  }

  // -- Documents legend --
  if (docs.length > 0) {
    lines.push('## Prior Art Documents');
    lines.push('');
    for (const doc of docs) {
      const cat = caseObj.summaries?.[doc.id]?.suggestedCategory;
      const catLabel = cat ? ` (Category ${cat})` : '';
      lines.push(`- **${doc.id}**${doc.title ? ': ' + doc.title : ''}${catLabel}`);
    }
    lines.push('');
  }

  // -- Matrix table --
  // NOTE: For readability in Markdown, we limit per-document columns to Verdict only
  // in the main table, then provide detailed citation/explanation sections below.
  // A single wide table with 3 columns per doc would be unreadable in Markdown renderers.
  if (features.length > 0) {
    lines.push('## Feature Mapping Matrix');
    lines.push('');

    // Header
    const hdrCells = ['Feature ID', 'Claim', 'Type', 'Portion', 'Feature Text'];
    for (const doc of docs) {
      hdrCells.push(`${doc.id}`);
    }
    lines.push('| ' + hdrCells.map(mdEscape).join(' | ') + ' |');

    // Separator — left-align feature text, center verdicts
    const seps = ['---', '---', '---', '---', '---'];
    for (let i = 0; i < docs.length; i++) {
      seps.push(':---:');
    }
    lines.push('| ' + seps.join(' | ') + ' |');

    // Feature rows (verdict only in table for readability)
    for (const f of features) {
      const row = [
        f.id,
        String(f.claim),
        f.type || '',
        f.portion || '',
        f.text || '',
      ];
      for (const doc of docs) {
        const cell = caseObj.mappings?.[doc.id]?.[f.id];
        row.push(cell ? cell.verdict : '');
      }
      lines.push('| ' + row.map(mdEscape).join(' | ') + ' |');
    }
    lines.push('');
  }

  // -- Per-document summary + detailed citations --
  for (const doc of docs) {
    const summary = caseObj.summaries?.[doc.id];
    lines.push(`## ${doc.id}${doc.title ? ' — ' + doc.title : ''}`);
    lines.push('');

    if (summary) {
      lines.push(`- **Disclosed:** ${summary.disclosedCount}/${summary.totalCount}`);
      lines.push(`- **Partial:** ${summary.partialCount}`);
      lines.push(`- **Independent claims fully disclosed:** ${summary.independentFullyDisclosed ? 'Yes' : 'No'}`);
      lines.push(`- **Suggested category:** ${summary.suggestedCategory}`);
      lines.push(`- **Novelty verdict:** ${summary.noveltyVerdict}`);
      lines.push('');
    }

    // Detailed feature citations for this document
    const docMappings = caseObj.mappings?.[doc.id];
    if (docMappings && features.length > 0) {
      lines.push('### Feature Details');
      lines.push('');
      lines.push('| Feature | Verdict | Citations | Explanation |');
      lines.push('| --- | :---: | --- | --- |');
      for (const f of features) {
        const cell = docMappings[f.id];
        if (cell) {
          lines.push(
            '| ' +
            [
              mdEscape(f.id),
              mdEscape(cell.verdict),
              mdEscape(formatCitations(cell.citations)),
              mdEscape(cell.explanation),
            ].join(' | ') +
            ' |'
          );
        }
      }
      lines.push('');
    }
  }

  // -- Footer --
  lines.push('---');
  lines.push(`*Generated by Hermes Patent Examiner on ${new Date().toISOString().slice(0, 10)}*`);
  lines.push('');

  return lines.join('\n');
}
