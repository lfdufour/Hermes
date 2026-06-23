/**
 * ui/casesView.js — Saved-cases browser.
 *
 * Lists saved cases (title + updatedAt), with open / delete / new actions.
 */

/**
 * Render the cases list view.
 *
 * @param {HTMLElement} container
 * @param {{ casesStore: object, onOpenCase: Function, onNewCase: Function }} deps
 */
export function renderCasesView(container, { casesStore, onOpenCase, onNewCase }) {
  if (!container) return;

  container.innerHTML = `
    <h1>Patent Examination Cases</h1>
    <div class="toolbar">
      <button id="cv-new-btn" class="btn btn-primary">+ New Case</button>
      <div class="toolbar-spacer"></div>
      <button id="cv-import-btn" class="btn btn-secondary btn-sm">Import JSON</button>
      <input type="file" id="cv-import-file" accept=".json" style="display:none">
    </div>
    <div id="cv-list" class="case-list"></div>
    <div id="cv-empty" style="display:none;text-align:center;padding:40px 0;">
      <p style="color:var(--text-muted);font-size:0.9rem;">No saved cases yet.</p>
      <p style="color:var(--text-faint);font-size:0.8rem;margin-top:4px;">
        Create a new case to begin examining patent claims.
      </p>
    </div>
  `;

  const listEl = container.querySelector('#cv-list');
  const emptyEl = container.querySelector('#cv-empty');
  const newBtn = container.querySelector('#cv-new-btn');
  const importBtn = container.querySelector('#cv-import-btn');
  const importFile = container.querySelector('#cv-import-file');

  /** Format a date string for display. */
  function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch (_) {
      return dateStr;
    }
  }

  /** Load and render the case list. */
  async function loadList() {
    if (!listEl || !emptyEl) return;
    try {
      const cases = await casesStore.list();
      if (!cases || cases.length === 0) {
        listEl.style.display = 'none';
        emptyEl.style.display = 'block';
        return;
      }

      listEl.style.display = 'flex';
      emptyEl.style.display = 'none';

      // Sort by updatedAt descending
      cases.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

      listEl.innerHTML = cases.map(c => `
        <div class="case-item" data-id="${c.id}">
          <span class="case-title">${escapeHtml(c.title || 'Untitled')}</span>
          <span class="case-date">${formatDate(c.updatedAt)}</span>
          <button class="btn btn-secondary btn-xs cv-open-btn" data-id="${c.id}">Open</button>
          <button class="btn btn-danger btn-xs cv-delete-btn" data-id="${c.id}" title="Delete case">&#x2715;</button>
        </div>
      `).join('');

      // Attach open handlers
      listEl.querySelectorAll('.cv-open-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = btn.getAttribute('data-id');
          if (!id) return;
          const caseObj = await casesStore.get(id);
          if (caseObj && onOpenCase) onOpenCase(caseObj);
        });
      });

      // Clicking the row also opens
      listEl.querySelectorAll('.case-item').forEach(item => {
        item.addEventListener('click', async () => {
          const id = item.getAttribute('data-id');
          if (!id) return;
          const caseObj = await casesStore.get(id);
          if (caseObj && onOpenCase) onOpenCase(caseObj);
        });
      });

      // Attach delete handlers
      listEl.querySelectorAll('.cv-delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = btn.getAttribute('data-id');
          if (!id) return;
          // NOTE: Using confirm() for simplicity; a custom modal would be more polished
          // but adds complexity without clear benefit here.
          if (!confirm('Delete this case? This cannot be undone.')) return;
          await casesStore.remove(id);
          loadList();
        });
      });

    } catch (err) {
      console.error('[Hermes] Failed to load cases:', err);
      listEl.innerHTML = `<p style="color:var(--danger)">Failed to load cases: ${err.message}</p>`;
    }
  }

  // New case
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      if (onNewCase) onNewCase();
    });
  }

  // Import JSON
  if (importBtn && importFile) {
    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async () => {
      const file = importFile.files && importFile.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        await casesStore.importJSON(data);
        loadList();
      } catch (err) {
        alert('Failed to import: ' + err.message);
      }
      importFile.value = '';
    });
  }

  loadList();
}

/** Escape HTML entities to prevent XSS in dynamic content. */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
