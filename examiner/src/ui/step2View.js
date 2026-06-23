/**
 * ui/step2View.js — Step 2: Feature Mapping / Novelty Matrix.
 *
 * Patent-number chips input, fetch with per-patent status chips,
 * paste fallback for failed fetches, "Run feature mapping" button,
 * progressive matrix rendering with shimmer->fade-in cells,
 * expandable cell cards, per-document summary with editable search
 * category, and export (CSV, Markdown, Print).
 */

import { normalizeNumber, buildPatentUrl, fetchPatent, parsePasted } from '../patent/fetch.js';
import { parsePatentHtml } from '../patent/parse.js';
import { mapDocument } from '../mapping/map.js';
import { dependencyContext } from '../features/table.js';
import { toCSV, toMarkdown } from '../store/exportReport.js';

/**
 * Render Step 2 view.
 *
 * @param {HTMLElement} container
 * @param {{
 *   infer: object,
 *   casesStore: object,
 *   currentCase: import('../types.js').Case,
 *   modelLoaded: boolean,
 *   onCaseUpdated: (c: import('../types.js').Case) => void,
 * }} opts
 */
export function renderStep2View(container, { infer, casesStore, currentCase, modelLoaded, onCaseUpdated }) {
  if (!container || !currentCase) return;

  const table = currentCase.table;
  const features = table && table.features ? table.features : [];
  /** @type {import('../types.js').PriorArtDoc[]} */
  let documents = currentCase.documents || [];
  let mappings = currentCase.mappings || {};
  let summaries = currentCase.summaries || {};
  let abortController = null;
  let mapping = false;

  // Track patent numbers entered by the user (not yet fetched)
  let patentNumbers = [];
  // Track expanded cells: key = `${docId}:${featureId}`
  let expandedCells = new Set();

  container.innerHTML = `
    <h1>Step 2: Feature Mapping</h1>
    <p style="color:var(--text-muted);margin-bottom:16px;">
      Case: <strong>${escapeHtml(currentCase.title || 'Untitled')}</strong>
      &mdash; ${features.length} features frozen
    </p>

    <!-- Patent input section -->
    <div class="card mb-16" id="s2-patent-input">
      <h3>Prior Art Documents</h3>
      <p style="font-size:0.82rem;color:var(--text-muted);margin-bottom:8px;">
        Enter patent numbers (e.g., DE19728057C2, US6543210B1) and press Enter or comma.
      </p>
      <div class="chips-input-wrap" id="s2-chips-wrap">
        <input type="text" id="s2-patent-input-field" placeholder="Type a patent number…"
               aria-label="Patent number input">
      </div>
      <div class="toolbar mt-8">
        <button id="s2-fetch-btn" class="btn btn-primary btn-sm" ${!patentNumbers.length ? 'disabled' : ''}>
          Fetch Patents
        </button>
        <div class="toolbar-spacer"></div>
      </div>
      <div id="s2-doc-status" class="mt-8"></div>
    </div>

    <!-- Mapping section -->
    <div class="card mb-16" id="s2-mapping-section" ${documents.length === 0 ? 'style="display:none"' : ''}>
      <div class="toolbar">
        <button id="s2-map-btn" class="btn btn-primary"
          ${!modelLoaded ? 'disabled title="Load a model first"' : ''}>
          Run Feature Mapping
        </button>
        <button id="s2-cancel-btn" class="btn btn-secondary" style="display:none">Cancel</button>
        <div class="toolbar-spacer"></div>
        <button id="s2-export-csv" class="btn btn-secondary btn-sm">Export CSV</button>
        <button id="s2-export-md" class="btn btn-secondary btn-sm">Export Markdown</button>
        <button id="s2-print" class="btn btn-secondary btn-sm">Print</button>
      </div>
      <div id="s2-map-progress" class="progress-status" style="display:none"></div>
    </div>

    <!-- Matrix -->
    <div id="s2-matrix-container"></div>

    <!-- Doc summaries -->
    <div id="s2-summaries-container"></div>
  `;

  // DOM refs
  const chipsWrap = container.querySelector('#s2-chips-wrap');
  const inputField = container.querySelector('#s2-patent-input-field');
  const fetchBtn = container.querySelector('#s2-fetch-btn');
  const docStatusEl = container.querySelector('#s2-doc-status');
  const mappingSection = container.querySelector('#s2-mapping-section');
  const mapBtn = container.querySelector('#s2-map-btn');
  const cancelBtn = container.querySelector('#s2-cancel-btn');
  const mapProgressEl = container.querySelector('#s2-map-progress');
  const matrixContainer = container.querySelector('#s2-matrix-container');
  const summariesContainer = container.querySelector('#s2-summaries-container');
  const exportCsvBtn = container.querySelector('#s2-export-csv');
  const exportMdBtn = container.querySelector('#s2-export-md');
  const printBtn = container.querySelector('#s2-print');

  // ===== Chips Input =====
  /** Add a patent number chip. */
  function addChip(raw) {
    const num = normalizeNumber(raw);
    if (!num) return;
    // Avoid duplicates
    if (patentNumbers.includes(num)) return;
    if (documents.find(d => d.id === num)) return;

    patentNumbers.push(num);
    renderChips();
    if (fetchBtn) fetchBtn.disabled = false;
  }

  /** Remove a patent number chip. */
  function removeChip(num) {
    patentNumbers = patentNumbers.filter(n => n !== num);
    renderChips();
    if (fetchBtn) fetchBtn.disabled = patentNumbers.length === 0;
  }

  /** Render the chips inside the input wrap. */
  function renderChips() {
    if (!chipsWrap) return;
    // Remove existing chips (but keep the input)
    chipsWrap.querySelectorAll('.patent-chip').forEach(c => c.remove());
    patentNumbers.forEach(num => {
      const chip = document.createElement('span');
      chip.className = 'patent-chip';
      chip.innerHTML = `${escapeHtml(num)} <span class="chip-remove" data-num="${escapeHtml(num)}">&times;</span>`;
      chipsWrap.insertBefore(chip, inputField);
    });
    // Attach remove listeners
    chipsWrap.querySelectorAll('.chip-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeChip(btn.getAttribute('data-num'));
      });
    });
  }

  // Input field: Enter/comma adds a chip
  if (inputField) {
    inputField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const val = inputField.value.trim().replace(/,/g, '');
        if (val) {
          addChip(val);
          inputField.value = '';
        }
      }
      // Backspace removes last chip if input is empty
      if (e.key === 'Backspace' && !inputField.value && patentNumbers.length > 0) {
        removeChip(patentNumbers[patentNumbers.length - 1]);
      }
    });
    // Also handle paste with multiple numbers (separated by commas/spaces/newlines)
    inputField.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text');
      const nums = text.split(/[,;\s\n]+/).filter(Boolean);
      nums.forEach(n => addChip(n));
      inputField.value = '';
    });
  }

  // Click on chips-wrap focuses the input
  if (chipsWrap) {
    chipsWrap.addEventListener('click', () => {
      if (inputField) inputField.focus();
    });
  }

  // ===== Fetch Patents =====
  if (fetchBtn) {
    fetchBtn.addEventListener('click', async () => {
      if (patentNumbers.length === 0) return;
      fetchBtn.disabled = true;
      if (docStatusEl) docStatusEl.innerHTML = '';

      const numbersToFetch = [...patentNumbers];
      patentNumbers = [];
      renderChips();

      for (const num of numbersToFetch) {
        // Add a pending status chip
        renderDocStatus(num, 'pending', 'Fetching…');

        try {
          const result = await fetchPatent(num, {});

          if (result.ok && result.html) {
            // Parse the HTML into a PriorArtDoc
            const doc = parsePatentHtml(num, result.html);
            doc.url = result.url || buildPatentUrl(num);
            doc.status = 'loaded';
            doc.fetchedAt = new Date().toISOString();
            documents.push(doc);
            renderDocStatus(num, 'loaded', doc.title || 'Loaded');
          } else {
            // Create a failed doc placeholder, show paste fallback
            const failDoc = {
              id: num, number: num, url: buildPatentUrl(num),
              status: 'failed', description: '', claims: '', passages: [],
              error: result.error || 'Fetch failed',
            };
            documents.push(failDoc);
            renderDocStatus(num, 'failed', result.error || 'Fetch failed');
            renderPasteFallback(num);
          }
        } catch (err) {
          const failDoc = {
            id: num, number: num, url: buildPatentUrl(num),
            status: 'failed', description: '', claims: '', passages: [],
            error: err.message,
          };
          documents.push(failDoc);
          renderDocStatus(num, 'failed', err.message);
          renderPasteFallback(num);
        }
      }

      // Update case
      currentCase.documents = documents;
      onCaseUpdated(currentCase);
      saveCase();

      // Show mapping section if any docs loaded
      if (mappingSection && documents.some(d => d.status === 'loaded' || d.status === 'pasted')) {
        mappingSection.style.display = 'block';
      }

      // If we already have some mappings, re-render the matrix
      if (Object.keys(mappings).length > 0) {
        renderMatrix();
      }

      fetchBtn.disabled = false;
    });
  }

  /** Render a per-document status chip in the status area. */
  function renderDocStatus(num, status, label) {
    if (!docStatusEl) return;

    // Update existing or create new
    let el = docStatusEl.querySelector(`[data-doc="${num}"]`);
    if (!el) {
      el = document.createElement('span');
      el.setAttribute('data-doc', num);
      el.style.display = 'inline-block';
      el.style.marginRight = '8px';
      el.style.marginBottom = '4px';
      docStatusEl.appendChild(el);
    }

    const chipClass = status === 'loaded' ? 'chip-ok' :
                      status === 'pasted' ? 'chip-pasted' :
                      status === 'failed' ? 'chip-fail' : 'chip-pending';
    const icon = status === 'loaded' ? '&#x2713;' :
                 status === 'pasted' ? '&#x270E;' :
                 status === 'failed' ? '&#x2717;' : '&#x231B;';
    el.innerHTML = `<span class="chip ${chipClass}">${icon} ${escapeHtml(num)}: ${escapeHtml(label)}</span>`;
  }

  /** Render a paste-fallback textarea for a failed patent. */
  function renderPasteFallback(num) {
    if (!docStatusEl) return;
    const docEl = docStatusEl.querySelector(`[data-doc="${num}"]`);
    if (!docEl) return;

    const fallback = document.createElement('div');
    fallback.className = 'paste-fallback';
    fallback.innerHTML = `
      <p style="font-size:0.78rem;color:var(--text-muted);margin-bottom:4px;">
        Paste the patent text below (description + claims) to use this document:
      </p>
      <textarea class="paste-textarea" rows="4" placeholder="Paste patent text here…"></textarea>
      <button class="btn btn-secondary btn-xs mt-8 paste-submit-btn" data-num="${escapeHtml(num)}">Use Pasted Text</button>
    `;
    docEl.appendChild(fallback);

    fallback.querySelector('.paste-submit-btn')?.addEventListener('click', () => {
      const ta = fallback.querySelector('.paste-textarea');
      const text = ta ? ta.value.trim() : '';
      if (!text) return;

      // Replace the failed doc with a pasted doc
      const idx = documents.findIndex(d => d.id === num);
      if (idx >= 0) {
        const doc = parsePasted(num, text);
        doc.status = 'pasted';
        documents[idx] = doc;
        renderDocStatus(num, 'pasted', 'Pasted');
        fallback.remove();

        currentCase.documents = documents;
        onCaseUpdated(currentCase);
        saveCase();

        // Show mapping section
        if (mappingSection) mappingSection.style.display = 'block';
      }
    });
  }

  // ===== Run Feature Mapping =====
  if (mapBtn) {
    mapBtn.addEventListener('click', async () => {
      if (mapping) return;
      const loadedDocs = documents.filter(d => d.status === 'loaded' || d.status === 'pasted');
      if (loadedDocs.length === 0) {
        alert('No loaded documents to map against.');
        return;
      }

      mapping = true;
      mapBtn.disabled = true;
      if (cancelBtn) cancelBtn.style.display = 'inline-block';
      abortController = new AbortController();

      // Initialize pending cells in mappings
      for (const doc of loadedDocs) {
        if (!mappings[doc.id]) mappings[doc.id] = {};
        for (const f of features) {
          if (!mappings[doc.id][f.id]) {
            mappings[doc.id][f.id] = {
              featureId: f.id,
              verdict: 'N',
              citations: [],
              explanation: '',
              status: 'pending',
            };
          }
        }
      }
      currentCase.mappings = mappings;

      // Initial matrix render (all shimmer)
      renderMatrix();

      if (mapProgressEl) {
        mapProgressEl.style.display = 'block';
        mapProgressEl.textContent = 'Starting mapping…';
      }

      let totalProcessed = 0;
      const totalCells = loadedDocs.length * features.length;

      for (const doc of loadedDocs) {
        if (abortController.signal.aborted) break;

        // Mark all cells for this doc as running
        for (const f of features) {
          if (mappings[doc.id][f.id]) {
            mappings[doc.id][f.id].status = 'running';
          }
        }
        renderMatrix();

        try {
          const result = await mapDocument({
            infer,
            table,
            doc,
            signal: abortController.signal,
            onCell: (cellResult) => {
              // Progressive fill: update the specific cell
              if (mappings[doc.id]) {
                mappings[doc.id][cellResult.featureId] = cellResult;
              }
              totalProcessed++;
              if (mapProgressEl) {
                mapProgressEl.textContent = `Mapping: ${totalProcessed}/${totalCells} cells completed…`;
              }
              // Re-render the single cell in the matrix
              updateMatrixCell(doc.id, cellResult.featureId, cellResult);
            },
          });

          // Store summary
          if (result && result.summary) {
            summaries[doc.id] = result.summary;
          }

          // Ensure all cells are marked done
          if (result && result.cells) {
            for (const cell of result.cells) {
              if (mappings[doc.id]) {
                mappings[doc.id][cell.featureId] = cell;
              }
            }
          }

        } catch (err) {
          if (err.name === 'AbortError') {
            if (mapProgressEl) mapProgressEl.textContent = 'Mapping cancelled.';
            break;
          }
          console.error(`[Hermes] Mapping failed for ${doc.id}:`, err);
          // Mark remaining cells as error
          for (const f of features) {
            if (mappings[doc.id][f.id] && mappings[doc.id][f.id].status !== 'done') {
              mappings[doc.id][f.id].status = 'error';
              mappings[doc.id][f.id].error = err.message;
            }
          }
        }
      }

      // Save results
      currentCase.mappings = mappings;
      currentCase.summaries = summaries;
      onCaseUpdated(currentCase);
      saveCase();

      // Final render
      renderMatrix();
      renderSummaries();

      if (mapProgressEl && !abortController.signal.aborted) {
        mapProgressEl.textContent = `Mapping complete: ${totalProcessed} cells processed.`;
      }

      mapping = false;
      if (mapBtn) mapBtn.disabled = !modelLoaded;
      if (cancelBtn) cancelBtn.style.display = 'none';
      abortController = null;
    });
  }

  // Cancel mapping
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (abortController) abortController.abort();
    });
  }

  // ===== Export =====
  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', () => {
      try {
        const csv = toCSV(currentCase);
        downloadBlob(csv, `${currentCase.title || 'hermes-report'}.csv`, 'text/csv');
      } catch (err) {
        console.error('[Hermes] CSV export failed:', err);
        alert('Export failed: ' + err.message);
      }
    });
  }

  if (exportMdBtn) {
    exportMdBtn.addEventListener('click', () => {
      try {
        const md = toMarkdown(currentCase);
        downloadBlob(md, `${currentCase.title || 'hermes-report'}.md`, 'text/markdown');
      } catch (err) {
        console.error('[Hermes] Markdown export failed:', err);
        alert('Export failed: ' + err.message);
      }
    });
  }

  if (printBtn) {
    printBtn.addEventListener('click', () => window.print());
  }

  // ===== Matrix Rendering =====

  /** Render the full mapping matrix table. */
  function renderMatrix() {
    if (!matrixContainer) return;

    const loadedDocs = documents.filter(d => d.status === 'loaded' || d.status === 'pasted');
    if (loadedDocs.length === 0 || features.length === 0) {
      matrixContainer.innerHTML = '';
      return;
    }

    // Build the matrix HTML
    let html = '<div class="matrix-wrap"><table class="matrix-table">';

    // Header row 1: Feature column + doc group headers
    html += '<thead><tr>';
    html += '<th class="sticky-col" rowspan="2">Feature</th>';
    for (const doc of loadedDocs) {
      html += `<th class="doc-group-header" colspan="3">${escapeHtml(doc.id)}${doc.title ? ' - ' + escapeHtml(truncate(doc.title, 40)) : ''}</th>`;
    }
    html += '</tr>';

    // Header row 2: sub-headers per doc
    html += '<tr>';
    for (let di = 0; di < loadedDocs.length; di++) {
      html += `<th class="sub-header ${di === 0 ? 'doc-col-first' : 'doc-col'}">Verdict</th>`;
      html += '<th class="sub-header doc-col">Citations</th>';
      html += '<th class="sub-header doc-col">Explanation</th>';
    }
    html += '</tr></thead>';

    // Body
    html += '<tbody>';
    for (const f of features) {
      html += '<tr>';
      // Sticky feature column
      html += `<td class="sticky-col">
        <strong>${escapeHtml(f.id)}</strong>
        <span style="font-size:0.72rem;color:var(--text-muted);display:block;">${escapeHtml(truncate(f.text, 80))}</span>
      </td>`;

      for (let di = 0; di < loadedDocs.length; di++) {
        const doc = loadedDocs[di];
        const cell = (mappings[doc.id] && mappings[doc.id][f.id]) || null;
        const cellKey = `${doc.id}:${f.id}`;
        const isFirst = di === 0;

        if (!cell || cell.status === 'pending') {
          html += `<td class="${isFirst ? 'doc-col-first' : 'doc-col'}" colspan="3" data-cell="${cellKey}">
            <span style="color:var(--text-faint);font-size:0.75rem;">Pending</span>
          </td>`;
        } else if (cell.status === 'running') {
          html += `<td class="${isFirst ? 'doc-col-first' : 'doc-col'}" colspan="3" data-cell="${cellKey}">
            <div class="shimmer-cell" style="height:22px;"></div>
          </td>`;
        } else if (cell.status === 'error') {
          html += `<td class="${isFirst ? 'doc-col-first' : 'doc-col'}" colspan="3" data-cell="${cellKey}">
            <span style="color:var(--danger);font-size:0.75rem;">Error: ${escapeHtml(cell.error || 'unknown')}</span>
          </td>`;
        } else {
          // Done: render verdict + citations + explanation
          const verdictHtml = renderVerdict(cell.verdict);
          const citHtml = renderCitationsSummary(cell.citations);
          const explHtml = truncate(cell.explanation || '', 120);
          const expanded = expandedCells.has(cellKey);

          html += `<td class="${isFirst ? 'doc-col-first' : 'doc-col'} cell-fade-in" data-cell="${cellKey}" data-docid="${doc.id}" data-fid="${f.id}">
            <div class="verdict-cell verdict-${cell.verdict}" data-expand="${cellKey}">${verdictHtml}</div>
          </td>`;
          html += `<td class="doc-col cell-fade-in" data-cell="${cellKey}-cit">${citHtml}</td>`;
          html += `<td class="doc-col cell-fade-in" data-cell="${cellKey}-exp">
            <span style="font-size:0.75rem;">${escapeHtml(explHtml)}</span>
          </td>`;

          // If expanded, we'll add the card after the row
          // NOTE: Expansion is handled via a click listener below, not inline
        }
      }
      html += '</tr>';

      // Expansion row (for any expanded cells in this feature)
      for (const doc of loadedDocs) {
        const cellKey = `${doc.id}:${f.id}`;
        if (expandedCells.has(cellKey)) {
          const cell = mappings[doc.id] && mappings[doc.id][f.id];
          if (cell && cell.status === 'done') {
            html += `<tr><td colspan="${1 + loadedDocs.length * 3}">
              ${renderExpandedCard(f, doc, cell)}
            </td></tr>`;
          }
        }
      }
    }
    html += '</tbody></table></div>';

    matrixContainer.innerHTML = html;

    // Attach click-to-expand listeners on verdict cells
    matrixContainer.querySelectorAll('.verdict-cell[data-expand]').forEach(el => {
      el.addEventListener('click', () => {
        const key = el.getAttribute('data-expand');
        if (expandedCells.has(key)) {
          expandedCells.delete(key);
        } else {
          expandedCells.add(key);
        }
        renderMatrix();
      });
    });
  }

  /**
   * Update a single cell in the matrix (progressive fill).
   * Falls back to a full re-render if the specific cell is not found.
   *
   * @param {string} docId
   * @param {string} featureId
   * @param {import('../types.js').CellResult} cellResult
   */
  function updateMatrixCell(docId, featureId, cellResult) {
    if (!matrixContainer) return;

    const cellKey = `${docId}:${featureId}`;
    const cellEl = matrixContainer.querySelector(`[data-cell="${cellKey}"]`);
    const citEl = matrixContainer.querySelector(`[data-cell="${cellKey}-cit"]`);
    const expEl = matrixContainer.querySelector(`[data-cell="${cellKey}-exp"]`);

    if (cellEl && cellResult.status === 'done') {
      // Replace shimmer with verdict
      cellEl.className = cellEl.className.replace('shimmer-cell', '') + ' cell-fade-in';
      // NOTE: When the cell was a colspan=3 shimmer, we need a full re-render
      // to split it into three separate columns. This is a trade-off between
      // incremental DOM updates and correctness.
      renderMatrix();
    } else if (cellEl && cellResult.status === 'running') {
      cellEl.innerHTML = '<div class="shimmer-cell" style="height:22px;"></div>';
    } else {
      // Fallback: full re-render
      renderMatrix();
    }
  }

  /** Render summaries for each document. */
  function renderSummaries() {
    if (!summariesContainer) return;
    const loadedDocs = documents.filter(d => d.status === 'loaded' || d.status === 'pasted');

    if (loadedDocs.length === 0 || Object.keys(summaries).length === 0) {
      summariesContainer.innerHTML = '';
      return;
    }

    let html = '<h2 class="mt-16">Document Summaries</h2>';

    for (const doc of loadedDocs) {
      const s = summaries[doc.id];
      if (!s) continue;

      const docRef = documents.find(d => d.id === doc.id);
      const currentCategory = (docRef && docRef.searchCategory) || s.suggestedCategory || 'A';

      html += `
        <div class="doc-summary-footer" data-summary-doc="${doc.id}">
          <span class="stat"><strong>${escapeHtml(doc.id)}</strong></span>
          <span class="stat">Disclosed: <strong>${s.disclosedCount}</strong>/${s.totalCount}</span>
          <span class="stat">Partial: <strong>${s.partialCount}</strong></span>
          <span class="stat">
            ${s.independentFullyDisclosed
              ? '<span style="color:var(--verdict-n);font-weight:700;">Novelty-destroying</span>'
              : '<span style="color:var(--verdict-y);">Novelty preserved</span>'}
          </span>
          <span class="stat" style="flex:1;">${escapeHtml(s.noveltyVerdict || '')}</span>
          <label style="font-size:0.78rem;display:flex;align-items:center;gap:4px;">
            Category:
            <select class="category-select" data-doc="${doc.id}">
              <option value="X" ${currentCategory === 'X' ? 'selected' : ''}>X (novelty-destroying)</option>
              <option value="Y" ${currentCategory === 'Y' ? 'selected' : ''}>Y (relevant in combination)</option>
              <option value="A" ${currentCategory === 'A' ? 'selected' : ''}>A (background)</option>
            </select>
          </label>
        </div>
      `;
    }

    summariesContainer.innerHTML = html;

    // Attach category change listeners
    summariesContainer.querySelectorAll('.category-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const docId = sel.getAttribute('data-doc');
        const docRef = documents.find(d => d.id === docId);
        if (docRef) {
          docRef.searchCategory = sel.value;
          currentCase.documents = documents;
          onCaseUpdated(currentCase);
          saveCase();
        }
      });
    });
  }

  // ===== Render helpers =====

  /** Render a verdict with icon + text. Never color alone. */
  function renderVerdict(verdict) {
    switch (verdict) {
      case 'Y': return '&#x2713; Y';   // checkmark
      case 'P': return '&#x25D0; P';   // half circle
      case 'N': return '&#x2717; N';   // cross
      default: return escapeHtml(verdict || '?');
    }
  }

  /** Render a brief citations summary for the matrix cell. */
  function renderCitationsSummary(citations) {
    if (!citations || citations.length === 0) {
      return '<span style="color:var(--text-faint);font-size:0.72rem;">--</span>';
    }
    const labels = citations.slice(0, 3).map(c => escapeHtml(c.label || '')).join(', ');
    const more = citations.length > 3 ? ` +${citations.length - 3}` : '';
    return `<span style="font-size:0.72rem;">${labels}${more}</span>`;
  }

  /**
   * Render an expanded detail card for a cell.
   *
   * @param {import('../types.js').Feature} feature
   * @param {import('../types.js').PriorArtDoc} doc
   * @param {import('../types.js').CellResult} cell
   * @returns {string}
   */
  function renderExpandedCard(feature, doc, cell) {
    let depCtx = '';
    try {
      depCtx = dependencyContext(feature, table);
    } catch (_) {
      // NOTE: dependencyContext may not be implemented yet
    }

    let html = `<div class="cell-expanded">`;
    html += `<h4>${escapeHtml(feature.id)}: ${escapeHtml(truncate(feature.text, 100))} &mdash; ${escapeHtml(doc.id)}</h4>`;
    html += `<div style="margin-bottom:8px;">${renderVerdict(cell.verdict)}</div>`;

    // Citations
    if (cell.citations && cell.citations.length > 0) {
      html += '<div style="margin-bottom:8px;">';
      for (const cit of cell.citations) {
        html += `<div class="citation-block">
          <div class="citation-label">${escapeHtml(cit.label || 'Citation')}</div>
          <div class="citation-quote">"${escapeHtml(cit.quote || '')}"</div>
        </div>`;
      }
      html += '</div>';
    }

    // Explanation
    if (cell.explanation) {
      html += `<div class="explanation-text">${escapeHtml(cell.explanation)}</div>`;
    }

    // Dependency context
    if (depCtx) {
      html += `<div class="dep-context">
        <strong>Dependency Context</strong> (inherited features from independent claims):<br>
        ${escapeHtml(depCtx)}
      </div>`;
    }

    html += '</div>';
    return html;
  }

  /** Save the current case to IndexedDB. */
  async function saveCase() {
    try {
      await casesStore.save(currentCase);
    } catch (err) {
      console.error('[Hermes] Auto-save failed:', err);
    }
  }

  // ===== Initial state rendering =====
  // If the case already has documents/mappings, render them
  if (documents.length > 0) {
    documents.forEach(d => {
      renderDocStatus(d.id, d.status, d.title || d.status);
    });
    if (mappingSection) mappingSection.style.display = 'block';
  }
  if (Object.keys(mappings).length > 0) {
    renderMatrix();
    renderSummaries();
  }
}

// ===== Utility Functions =====

/** Truncate a string to maxLen, adding ellipsis. */
function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

/** Escape HTML entities. */
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** Download a string as a file via Blob. */
function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
