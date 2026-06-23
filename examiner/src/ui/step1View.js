/**
 * ui/step1View.js — Step 1: Build Feature Table.
 *
 * Provides claims textarea (required), collapsible description textarea,
 * "Analyze claims -> feature table" button with per-claim progress,
 * then renders the editable tableView.
 * Allows saving the case (with title prompt) via casesStore.
 */

import { extractFeatureTable } from '../features/extract.js';
import { renderTableView } from './tableView.js';

/**
 * Render Step 1 view.
 *
 * @param {HTMLElement} container
 * @param {{
 *   infer: object,
 *   casesStore: object,
 *   currentCase: import('../types.js').Case|null,
 *   modelLoaded: boolean,
 *   tableReady?: boolean,
 *   onCaseUpdated: (c: import('../types.js').Case) => void,
 *   onFreezeAndContinue: (c: import('../types.js').Case) => void,
 * }} opts
 */
export function renderStep1View(container, {
  infer, casesStore, currentCase, modelLoaded, tableReady,
  registerModelHook, onCaseUpdated, onFreezeAndContinue,
}) {
  if (!container) return;

  let abortController = null;
  let analyzing = false;
  // Live mirror of model-loaded state: the model may finish loading AFTER this
  // view is rendered, so we update the Analyze button reactively via the hook.
  let liveModelLoaded = modelLoaded;

  // Determine if we already have a table to show
  const hasTable = currentCase && currentCase.table &&
    currentCase.table.features && currentCase.table.features.length > 0;

  container.innerHTML = `
    <h1>Step 1: Build Feature Table</h1>
    ${currentCase && currentCase.title ? `<p style="color:var(--text-muted);margin-bottom:12px;">Case: <strong>${escapeHtml(currentCase.title)}</strong></p>` : ''}

    <div class="card mb-16" id="s1-input-card">
      <h3>Patent Claims</h3>
      <p style="font-size:0.82rem;color:var(--text-muted);margin-bottom:8px;">
        Paste the full claims text below. Each claim should be numbered (e.g., "1. A device comprising...").
      </p>
      <textarea id="s1-claims" rows="10" placeholder="1. A device comprising a first component (12) connected to a second component (14)...">${hasTable && currentCase.source ? escapeHtml(currentCase.source.claims) : ''}</textarea>

      <details class="collapsible mt-12">
        <summary>Description (optional, improves analysis)</summary>
        <div style="margin-top:8px;">
          <textarea id="s1-description" rows="6" placeholder="Paste the patent description here (optional)...">${hasTable && currentCase.source ? escapeHtml(currentCase.source.description) : ''}</textarea>
        </div>
      </details>

      <div class="toolbar mt-12">
        <button id="s1-analyze-btn" class="btn btn-primary" ${!modelLoaded ? 'disabled title="Load a model first"' : ''}>
          Analyze claims &#x2192; feature table
        </button>
        <button id="s1-cancel-btn" class="btn btn-secondary" style="display:none">Cancel</button>
        <div class="toolbar-spacer"></div>
        <button id="s1-save-btn" class="btn btn-secondary btn-sm" ${!hasTable ? 'disabled' : ''}>Save Case</button>
      </div>

      <div id="s1-progress" class="progress-status" style="display:none"></div>
    </div>

    <div id="s1-table-container"></div>
  `;

  const claimsEl = container.querySelector('#s1-claims');
  const descEl = container.querySelector('#s1-description');
  const analyzeBtn = container.querySelector('#s1-analyze-btn');
  const cancelBtn = container.querySelector('#s1-cancel-btn');
  const saveBtn = container.querySelector('#s1-save-btn');
  const progressEl = container.querySelector('#s1-progress');
  const tableContainer = container.querySelector('#s1-table-container');

  // If we already have a table, render it
  if (hasTable) {
    renderTable(currentCase.table, tableReady);
  }

  // React to the model becoming (un)loaded while this view is on screen.
  if (registerModelHook) {
    registerModelHook((loaded) => {
      liveModelLoaded = loaded;
      if (analyzeBtn && !analyzing) {
        analyzeBtn.disabled = !loaded;
        analyzeBtn.title = loaded ? '' : 'Load a model first';
      }
    });
  }

  // Analyze button
  if (analyzeBtn) {
    analyzeBtn.addEventListener('click', async () => {
      if (analyzing) return;
      const claims = claimsEl ? claimsEl.value.trim() : '';
      if (!claims) {
        alert('Please paste claims text before analyzing.');
        return;
      }

      const description = descEl ? descEl.value.trim() : '';

      analyzing = true;
      analyzeBtn.disabled = true;
      if (cancelBtn) cancelBtn.style.display = 'inline-block';
      if (progressEl) {
        progressEl.style.display = 'block';
        progressEl.textContent = 'Starting analysis…';
      }

      abortController = new AbortController();

      try {
        const table = await extractFeatureTable({
          infer,
          claims,
          description,
          signal: abortController.signal,
          onProgress: ({ claim, total }) => {
            if (progressEl) {
              progressEl.textContent = `Analyzing claim ${claim} of ${total}…`;
            }
          },
        });

        if (progressEl) progressEl.textContent = `Analysis complete: ${table.features.length} features extracted.`;

        // Update current case
        if (currentCase) {
          currentCase.source = { claims, description };
          currentCase.table = table;
          onCaseUpdated(currentCase);
        }

        // Render the table
        renderTable(table, false);
        if (saveBtn) saveBtn.disabled = false;

      } catch (err) {
        if (err.name === 'AbortError') {
          if (progressEl) progressEl.textContent = 'Analysis cancelled.';
        } else {
          console.error('[Hermes] Extraction failed:', err);
          if (progressEl) progressEl.textContent = 'Error: ' + err.message;
        }
      } finally {
        analyzing = false;
        if (analyzeBtn) analyzeBtn.disabled = !liveModelLoaded;
        if (cancelBtn) cancelBtn.style.display = 'none';
        abortController = null;
      }
    });
  }

  // Cancel button
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (abortController) {
        abortController.abort();
      }
    });
  }

  // Save button
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      if (!currentCase) return;

      // Prompt for title if untitled
      let title = currentCase.title;
      if (!title || title === 'Untitled Case') {
        const input = prompt('Enter a title for this case:', title || '');
        if (input === null) return; // cancelled
        title = input.trim() || 'Untitled Case';
      }
      currentCase.title = title;

      // Save source text too
      if (claimsEl || descEl) {
        currentCase.source = {
          claims: claimsEl ? claimsEl.value : '',
          description: descEl ? descEl.value : '',
        };
      }

      try {
        await casesStore.save(currentCase);
        onCaseUpdated(currentCase);
        if (progressEl) {
          progressEl.style.display = 'block';
          progressEl.textContent = `Case "${title}" saved.`;
        }
      } catch (err) {
        console.error('[Hermes] Save failed:', err);
        alert('Failed to save: ' + err.message);
      }
    });
  }

  /**
   * Render the feature table (editable or frozen).
   * @param {import('../types.js').FeatureTable} table
   * @param {boolean} [frozenMode]
   */
  function renderTable(table, frozenMode) {
    if (!tableContainer) return;
    tableContainer.innerHTML = '';

    renderTableView(tableContainer, {
      table,
      frozen: !!frozenMode,
      onTableChanged: (updatedTable) => {
        if (currentCase) {
          currentCase.table = updatedTable;
          onCaseUpdated(currentCase);
        }
      },
      onFreeze: async (frozenTable) => {
        if (currentCase) {
          currentCase.table = frozenTable;

          // Save source text
          if (claimsEl || descEl) {
            currentCase.source = {
              claims: claimsEl ? claimsEl.value : '',
              description: descEl ? descEl.value : '',
            };
          }

          // Prompt for title if untitled
          let title = currentCase.title;
          if (!title || title === 'Untitled Case') {
            const input = prompt('Enter a title for this case:', title || '');
            if (input !== null) {
              title = input.trim() || 'Untitled Case';
            }
          }
          currentCase.title = title;

          // Initialize documents/mappings arrays if needed
          if (!currentCase.documents) currentCase.documents = [];
          if (!currentCase.mappings) currentCase.mappings = {};
          if (!currentCase.summaries) currentCase.summaries = {};

          try {
            await casesStore.save(currentCase);
          } catch (err) {
            console.error('[Hermes] Save before freeze failed:', err);
          }

          onFreezeAndContinue(currentCase);
        }
      },
    });
  }
}

/** Escape HTML entities. */
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
