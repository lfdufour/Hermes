/**
 * toolsPanel.js -- Tools manager UI for Iris.
 *
 * Lets the user:
 *   - see every registered tool (builtins + custom) and enable/disable each
 *     (disabled tools are not offered to the model),
 *   - create / edit / delete custom tools whose JS body runs in the sandbox
 *     (see sandbox/toolSandbox.js).
 *
 * Custom tool definitions persist in localStorage and are re-registered on load.
 *
 * Exports: createToolsPanel
 */

const CUSTOM_KEY = 'iris.customTools';   // [{name, description, parameters, code}]
const ENABLED_KEY = 'iris.toolEnabled';  // { name: boolean }

const DEFAULT_CODE = `// Tool body. Receives "args" (per your parameters) and returns a value.
// Runs in a sandboxed Web Worker: no DOM/app access, ~5s time limit.
return { echo: args };`;

const DEFAULT_PARAMS = JSON.stringify(
  { type: 'object', properties: { text: { type: 'string', description: 'example arg' } }, required: [] },
  null, 2,
);

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch (_) { return fallback; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* ignore */ }
}

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * @param {HTMLElement} container
 * @param {{ registry: import('../tools/registry.js').ToolRegistry,
 *           sandbox: { run: Function }, onChange?: () => void }} deps
 */
export function createToolsPanel(container, { registry, sandbox, onChange }) {
  if (!container) return { refresh: () => {} };

  const notify = () => { try { onChange && onChange(); } catch (_) { /* ignore */ } };

  // Build the run() for a custom tool from its (current) code.
  function makeRun(code) {
    return async (args) => sandbox.run(code, args, { timeoutMs: 5000 });
  }

  // --- Register persisted custom tools + apply persisted enabled state. ---
  function bootstrap() {
    const customs = loadJSON(CUSTOM_KEY, []);
    for (const def of customs) {
      if (!def || !NAME_RE.test(def.name || '') || registry.has(def.name)) continue;
      try {
        registry.register({
          name: def.name,
          description: def.description || '',
          parameters: def.parameters || { type: 'object', properties: {} },
          code: def.code || '',
          custom: true,
          run: makeRun(def.code || ''),
        });
      } catch (_) { /* skip bad defs */ }
    }
    const enabled = loadJSON(ENABLED_KEY, {});
    for (const [name, on] of Object.entries(enabled)) {
      if (registry.has(name)) registry.setEnabled(name, on);
    }
  }

  function persistCustoms() {
    const defs = registry.listAll()
      .filter(t => t.custom)
      .map(t => ({ name: t.name, description: t.description, parameters: t.parameters, code: t.code }));
    saveJSON(CUSTOM_KEY, defs);
  }
  function persistEnabled() {
    const map = {};
    for (const t of registry.listAll()) map[t.name] = t.enabled;
    saveJSON(ENABLED_KEY, map);
  }

  container.innerHTML = `
    <div class="tools-panel">
      <h3 class="panel-title">Tools</h3>
      <div id="tp-list" class="tp-list"></div>
      <button id="tp-new-btn" class="btn-primary btn-sm" style="width:100%">+ New tool</button>
      <div id="tp-editor" class="tp-editor" style="display:none"></div>
    </div>
  `;
  const listEl = container.querySelector('#tp-list');
  const newBtn = container.querySelector('#tp-new-btn');
  const editorEl = container.querySelector('#tp-editor');

  // ---------- List rendering ----------
  function renderList() {
    const tools = registry.listAll().sort((a, b) => {
      if (a.custom !== b.custom) return a.custom ? 1 : -1; // builtins first
      return a.name.localeCompare(b.name);
    });
    listEl.innerHTML = '';
    for (const t of tools) {
      const row = document.createElement('div');
      row.className = 'tp-row';
      row.innerHTML = `
        <label class="tp-toggle" title="${t.enabled ? 'Enabled' : 'Disabled'} — offered to the model when on">
          <input type="checkbox" ${t.enabled ? 'checked' : ''}>
        </label>
        <span class="tp-name">${escapeHtml(t.name)}</span>
        <span class="tp-badge ${t.custom ? 'tp-badge-custom' : ''}">${t.custom ? 'custom' : 'builtin'}</span>
      `;
      const cb = row.querySelector('input');
      cb.addEventListener('change', () => {
        registry.setEnabled(t.name, cb.checked);
        persistEnabled();
        notify();
        renderList();
      });
      if (t.custom) {
        const actions = document.createElement('span');
        actions.className = 'tp-actions';
        const edit = document.createElement('button');
        edit.className = 'btn-sm tp-link';
        edit.textContent = 'Edit';
        edit.addEventListener('click', () => openEditor(t));
        const del = document.createElement('button');
        del.className = 'btn-sm tp-link tp-danger';
        del.textContent = 'Delete';
        del.addEventListener('click', () => {
          if (!confirm(`Delete custom tool "${t.name}"?`)) return;
          registry.unregister(t.name);
          persistCustoms();
          persistEnabled();
          notify();
          renderList();
        });
        actions.appendChild(edit);
        actions.appendChild(del);
        row.appendChild(actions);
      }
      const desc = document.createElement('div');
      desc.className = 'tp-desc';
      desc.textContent = t.description || '';
      const wrap = document.createElement('div');
      wrap.className = 'tp-item';
      wrap.appendChild(row);
      if (t.description) wrap.appendChild(desc);
      listEl.appendChild(wrap);
    }
  }

  // ---------- Editor ----------
  function openEditor(existing) {
    const isEdit = !!existing;
    editorEl.style.display = 'block';
    newBtn.style.display = 'none';
    editorEl.innerHTML = `
      <div class="tp-field"><label>Name
        <input id="tp-e-name" class="mm-input" spellcheck="false" value="${existing ? escapeAttr(existing.name) : ''}"
          ${isEdit ? 'readonly' : ''} placeholder="my_tool">
      </label></div>
      <div class="tp-field"><label>Description
        <input id="tp-e-desc" class="mm-input" spellcheck="false" value="${existing ? escapeAttr(existing.description || '') : ''}"
          placeholder="What the model uses this for">
      </label></div>
      <div class="tp-field"><label>Parameters (JSON Schema)
        <textarea id="tp-e-params" class="tp-code" spellcheck="false" rows="6"></textarea>
      </label></div>
      <div class="tp-field"><label>Code (JS function body; gets <code>args</code>, may <code>return</code>)
        <textarea id="tp-e-code" class="tp-code" spellcheck="false" rows="8"></textarea>
      </label></div>
      <div id="tp-e-err" class="tp-err"></div>
      <div class="tp-e-buttons">
        <button id="tp-e-save" class="btn-primary btn-sm">${isEdit ? 'Save' : 'Create'}</button>
        <button id="tp-e-cancel" class="btn-sm tp-link">Cancel</button>
      </div>
    `;
    const nameEl = editorEl.querySelector('#tp-e-name');
    const descEl = editorEl.querySelector('#tp-e-desc');
    const paramsEl = editorEl.querySelector('#tp-e-params');
    const codeEl = editorEl.querySelector('#tp-e-code');
    const errEl = editorEl.querySelector('#tp-e-err');
    paramsEl.value = existing ? JSON.stringify(existing.parameters || {}, null, 2) : DEFAULT_PARAMS;
    codeEl.value = existing ? (existing.code || '') : DEFAULT_CODE;

    editorEl.querySelector('#tp-e-cancel').addEventListener('click', closeEditor);
    editorEl.querySelector('#tp-e-save').addEventListener('click', () => {
      errEl.textContent = '';
      const name = nameEl.value.trim();
      if (!NAME_RE.test(name)) { errEl.textContent = 'Name must match [a-zA-Z_][a-zA-Z0-9_]*'; return; }
      if (!isEdit && registry.has(name)) { errEl.textContent = `A tool named "${name}" already exists.`; return; }
      let parameters;
      try { parameters = JSON.parse(paramsEl.value); }
      catch (e) { errEl.textContent = 'Parameters must be valid JSON: ' + e.message; return; }
      const description = descEl.value.trim();
      const code = codeEl.value;

      // For an edit, replace the existing registration.
      if (isEdit) registry.unregister(name);
      try {
        registry.register({ name, description, parameters, code, custom: true, run: makeRun(code) });
      } catch (e) {
        errEl.textContent = 'Could not register tool: ' + e.message;
        return;
      }
      persistCustoms();
      persistEnabled();
      notify();
      closeEditor();
      renderList();
    });
  }

  function closeEditor() {
    editorEl.style.display = 'none';
    editorEl.innerHTML = '';
    newBtn.style.display = '';
  }

  newBtn.addEventListener('click', () => openEditor(null));

  bootstrap();
  renderList();

  return { refresh: renderList };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function escapeAttr(s) { return escapeHtml(s); }
