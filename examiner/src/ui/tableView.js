/**
 * ui/tableView.js — Editable feature-table grid.
 *
 * Columns: Feature ID, Claim, Type, Depends on, Portion (preamble/characterizing),
 * Ref signs, Feature text, Note.
 * Supports inline editing, add/delete/reorder rows, re-numbering, and
 * "Freeze & continue to mapping".
 */

import { renumber, validateTable } from '../features/table.js';

/**
 * Render an editable feature table.
 *
 * @param {HTMLElement} container
 * @param {{
 *   table: import('../types.js').FeatureTable,
 *   frozen: boolean,
 *   onTableChanged: (table: import('../types.js').FeatureTable) => void,
 *   onFreeze: (table: import('../types.js').FeatureTable) => void,
 * }} opts
 */
export function renderTableView(container, { table, frozen, onTableChanged, onFreeze }) {
  if (!container) return;

  /** @type {import('../types.js').Feature[]} */
  let features = table && table.features ? [...table.features] : [];
  let claims = table && table.claims ? [...table.claims] : [];
  let isFrozen = !!frozen;

  /** Build the full HTML. */
  function render() {
    container.innerHTML = '';

    // Toolbar
    if (!isFrozen) {
      const toolbar = document.createElement('div');
      toolbar.className = 'toolbar mt-8';
      toolbar.innerHTML = `
        <button class="btn btn-secondary btn-sm" id="tv-add-row">+ Add Row</button>
        <button class="btn btn-secondary btn-sm" id="tv-renumber">Re-number</button>
        <div class="toolbar-spacer"></div>
        <button class="btn btn-primary btn-sm" id="tv-freeze">Freeze &amp; continue to mapping</button>
      `;
      container.appendChild(toolbar);

      toolbar.querySelector('#tv-add-row')?.addEventListener('click', addRow);
      toolbar.querySelector('#tv-renumber')?.addEventListener('click', doRenumber);
      toolbar.querySelector('#tv-freeze')?.addEventListener('click', doFreeze);
    }

    // Legend
    const legend = document.createElement('div');
    legend.className = 'legend mb-8';
    legend.innerHTML = `
      <dl style="display:flex;flex-wrap:wrap;gap:4px 0;">
        <dt>Feature ID:</dt><dd>Claim.Feature (e.g. 1.3 = claim 1, feature 3)</dd>
        <dt>Type:</dt><dd>independent / dependent</dd>
        <dt>Portion:</dt><dd>
          <span class="portion-badge portion-preamble">preamble</span> = known prior art (Rule 43(1) EPC);
          <span class="portion-badge portion-characterizing">characterizing</span> = asserted contribution
        </dd>
        <dt>Ref signs:</dt><dd>Reference numerals from drawings (Rule 43(7)), non-limiting</dd>
      </dl>
    `;
    container.appendChild(legend);

    // Table
    const wrap = document.createElement('div');
    wrap.className = 'feature-table-wrap';

    const tbl = document.createElement('table');
    tbl.className = 'feature-table';
    tbl.setAttribute('role', 'grid');

    // Header
    const thead = document.createElement('thead');
    thead.innerHTML = `<tr>
      <th>ID</th>
      <th>Claim</th>
      <th>Type</th>
      <th>Depends on</th>
      <th>Portion</th>
      <th>Ref Signs</th>
      <th style="min-width:250px">Feature Text</th>
      <th>Note</th>
      ${!isFrozen ? '<th style="width:80px">Actions</th>' : ''}
    </tr>`;
    tbl.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    features.forEach((f, idx) => {
      const tr = document.createElement('tr');
      tr.setAttribute('data-idx', String(idx));

      const editable = isFrozen ? '' : 'contenteditable="true"';
      const portionHtml = renderPortion(f.portion);
      const dependsStr = Array.isArray(f.dependsOn) ? f.dependsOn.join(', ') : '';
      const refStr = Array.isArray(f.refSigns) ? f.refSigns.join(', ') : '';

      tr.innerHTML = `
        <td class="ft-id" ${editable}>${escapeHtml(f.id || '')}</td>
        <td class="ft-claim" ${editable}>${f.claim != null ? f.claim : ''}</td>
        <td class="ft-type" ${editable}>${escapeHtml(f.type || '')}</td>
        <td class="ft-depends" ${editable}>${escapeHtml(dependsStr)}</td>
        <td class="ft-portion">${isFrozen ? portionHtml :
          `<select class="ft-portion-select" style="font-size:0.78rem;padding:2px 4px;">
            <option value="" ${!f.portion ? 'selected' : ''}>--</option>
            <option value="preamble" ${f.portion === 'preamble' ? 'selected' : ''}>preamble</option>
            <option value="characterizing" ${f.portion === 'characterizing' ? 'selected' : ''}>characterizing</option>
          </select>`}
        </td>
        <td class="ft-refs" ${editable}>${escapeHtml(refStr)}</td>
        <td class="ft-text" ${editable}>${escapeHtml(f.text || '')}</td>
        <td class="ft-note" ${editable}>${escapeHtml(f.note || '')}</td>
        ${!isFrozen ? `<td>
          <button class="btn-icon tv-move-up" title="Move up" ${idx === 0 ? 'disabled' : ''}>&#x25B2;</button>
          <button class="btn-icon tv-move-down" title="Move down" ${idx === features.length - 1 ? 'disabled' : ''}>&#x25BC;</button>
          <button class="btn-icon tv-delete" title="Delete row" style="color:var(--danger)">&#x2715;</button>
        </td>` : ''}
      `;
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    container.appendChild(wrap);

    // Attach edit listeners
    if (!isFrozen) {
      attachEditListeners(tbody);
    }
  }

  /** Attach inline edit + action listeners to tbody rows. */
  function attachEditListeners(tbody) {
    if (!tbody) return;

    // Contenteditable blur → commit changes
    tbody.querySelectorAll('td[contenteditable="true"]').forEach(td => {
      td.addEventListener('blur', () => {
        commitEditsFromDOM(tbody);
      });
    });

    // Portion selects
    tbody.querySelectorAll('.ft-portion-select').forEach(sel => {
      sel.addEventListener('change', () => {
        commitEditsFromDOM(tbody);
      });
    });

    // Action buttons
    tbody.querySelectorAll('.tv-move-up').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = getRowIndex(e.target);
        if (idx > 0) {
          [features[idx - 1], features[idx]] = [features[idx], features[idx - 1]];
          notifyChanged();
          render();
        }
      });
    });

    tbody.querySelectorAll('.tv-move-down').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = getRowIndex(e.target);
        if (idx < features.length - 1) {
          [features[idx], features[idx + 1]] = [features[idx + 1], features[idx]];
          notifyChanged();
          render();
        }
      });
    });

    tbody.querySelectorAll('.tv-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = getRowIndex(e.target);
        if (idx >= 0 && idx < features.length) {
          features.splice(idx, 1);
          notifyChanged();
          render();
        }
      });
    });
  }

  /** Read current cell values from the DOM and commit to the features array. */
  function commitEditsFromDOM(tbody) {
    if (!tbody) return;
    const rows = tbody.querySelectorAll('tr');
    rows.forEach((tr, idx) => {
      if (idx >= features.length) return;
      const f = features[idx];

      const id = tr.querySelector('.ft-id');
      const claim = tr.querySelector('.ft-claim');
      const type = tr.querySelector('.ft-type');
      const depends = tr.querySelector('.ft-depends');
      const portionSel = tr.querySelector('.ft-portion-select');
      const refs = tr.querySelector('.ft-refs');
      const text = tr.querySelector('.ft-text');
      const note = tr.querySelector('.ft-note');

      if (id) f.id = id.textContent.trim();
      if (claim) f.claim = parseInt(claim.textContent.trim(), 10) || 0;
      if (type) f.type = type.textContent.trim();
      if (depends) {
        const raw = depends.textContent.trim();
        f.dependsOn = raw ? raw.split(/[,;\s]+/).map(Number).filter(n => !isNaN(n)) : [];
      }
      if (portionSel) {
        f.portion = portionSel.value || null;
      }
      if (refs) {
        const raw = refs.textContent.trim();
        f.refSigns = raw ? raw.split(/[,;\s]+/).filter(Boolean) : [];
      }
      if (text) f.text = text.textContent.trim();
      if (note) f.note = note.textContent.trim();
    });
    notifyChanged();
  }

  /** Get the row index from a button click event. */
  function getRowIndex(el) {
    const tr = el.closest('tr');
    if (!tr) return -1;
    return parseInt(tr.getAttribute('data-idx'), 10);
  }

  /** Add a blank row at the end. */
  function addRow() {
    // Determine claim number from the last feature, or default to 1
    const lastClaim = features.length > 0 ? features[features.length - 1].claim : 1;
    features.push({
      id: '',
      claim: lastClaim,
      type: 'independent',
      dependsOn: [],
      text: '',
      portion: null,
      refSigns: [],
      category: null,
      note: '',
    });
    notifyChanged();
    render();
  }

  /** Re-number features using the standard EPO-style numbering. */
  function doRenumber() {
    try {
      features = renumber(features);
      notifyChanged();
      render();
    } catch (err) {
      console.error('[Hermes] Renumber failed:', err);
      alert('Re-number failed: ' + err.message);
    }
  }

  /** Freeze the table and continue to mapping. */
  function doFreeze() {
    // Validate first
    const currentTable = { claims, features };
    try {
      const result = validateTable(currentTable);
      if (result && !result.ok && result.errors && result.errors.length > 0) {
        const msg = 'Table validation warnings:\n' + result.errors.join('\n') + '\n\nFreeze anyway?';
        if (!confirm(msg)) return;
      }
    } catch (err) {
      // NOTE: validateTable may not be implemented yet; proceed gracefully
      console.warn('[Hermes] Validation check skipped:', err.message);
    }

    isFrozen = true;
    render();
    if (onFreeze) onFreeze({ claims, features });
  }

  /** Notify parent that the table has changed. */
  function notifyChanged() {
    if (onTableChanged) onTableChanged({ claims, features });
  }

  // Initial render
  render();
}

/** Render a portion badge. */
function renderPortion(portion) {
  if (!portion) return '<span style="color:var(--text-faint)">--</span>';
  if (portion === 'preamble') return '<span class="portion-badge portion-preamble">preamble</span>';
  if (portion === 'characterizing') return '<span class="portion-badge portion-characterizing">characterizing</span>';
  return escapeHtml(portion);
}

/** Escape HTML entities. */
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
