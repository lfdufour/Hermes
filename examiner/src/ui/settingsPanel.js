/**
 * ui/settingsPanel.js — Settings drawer: execution mode + editable prompts.
 *
 * Lets the examiner switch between local / copy-paste / mock modes and tune the
 * prompt text without touching code. Only the EDITABLE parts are exposed; the
 * fixed JSON "structure" block is shown read-only so it's clear what the app
 * relies on for parsing.
 */

import { STRUCTURE, PLACEHOLDERS, MODES } from '../store/settings.js';

const MODE_INFO = {
  local: { label: 'Local LLM', desc: 'Run the in-browser model. Nothing leaves the device.' },
  manual: { label: 'Copy-paste', desc: 'The app shows each prompt; you paste it into any external AI and paste the answer back.' },
  mock: { label: 'Debug (no AI)', desc: 'No model is called — canned output to test the workflow, fetching and UI quickly.' },
};

const PROMPT_FIELDS = [
  { key: 'extractionSystem', label: 'Step 1 — Extraction system prompt', kind: 'system', structure: STRUCTURE.extraction },
  { key: 'extractionUser', label: 'Step 1 — Extraction user template', kind: 'user', placeholders: PLACEHOLDERS.extraction },
  { key: 'mappingSystem', label: 'Step 2 — Mapping system prompt', kind: 'system', structure: STRUCTURE.mapping },
  { key: 'mappingUser', label: 'Step 2 — Mapping user template', kind: 'user', placeholders: PLACEHOLDERS.mapping },
];

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
    .set-toggle { margin-left: 8px; background: var(--surface-raised); color: var(--text-muted);
      border: 1px solid var(--border); border-radius: var(--radius); padding: 5px 12px;
      font-size: 0.78rem; font-weight: 500; cursor: pointer; white-space: nowrap; }
    .set-toggle:hover { color: var(--primary); border-color: var(--primary); }
    .set-toggle.active { background: var(--primary-light); color: var(--primary); border-color: var(--primary); }
    .set-drawer { position: fixed; top: 0; right: 0; height: 100vh; width: 560px; max-width: 96vw;
      background: var(--surface-raised); border-left: 1px solid var(--border);
      box-shadow: -6px 0 24px rgba(0,0,0,0.10); display: flex; flex-direction: column;
      transform: translateX(100%); transition: transform 0.22s ease; z-index: 1100; }
    .set-drawer.open { transform: translateX(0); }
    @media (prefers-reduced-motion: reduce) { .set-drawer { transition: none; } }
    .set-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px;
      border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .set-head h3 { font-family: var(--font-serif); font-size: 1rem; color: var(--primary); margin: 0; flex: 1; }
    .set-body { flex: 1; overflow-y: auto; padding: 14px 16px; }
    .set-section-title { font-family: var(--font-serif); color: var(--primary); font-size: 0.95rem;
      margin: 18px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--border-light); }
    .set-section-title:first-child { margin-top: 0; }
    .set-modes { display: flex; flex-direction: column; gap: 8px; }
    .set-mode { display: flex; gap: 10px; padding: 10px 12px; border: 1px solid var(--border);
      border-radius: var(--radius); cursor: pointer; background: var(--surface); }
    .set-mode:hover { border-color: var(--primary); }
    .set-mode.active { border-color: var(--primary); background: var(--primary-lighter); }
    .set-mode input { margin-top: 3px; }
    .set-mode .mlabel { font-weight: 600; color: var(--text); font-size: 0.86rem; }
    .set-mode .mdesc { color: var(--text-muted); font-size: 0.76rem; margin-top: 2px; }
    .set-field { margin-bottom: 16px; }
    .set-field-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .set-field-head label { font-size: 0.8rem; font-weight: 600; color: var(--text); flex: 1; }
    .set-field textarea { width: 100%; min-height: 130px; font-family: var(--font-mono); font-size: 0.74rem;
      line-height: 1.5; border: 1px solid var(--border); border-radius: 4px; padding: 9px; resize: vertical; }
    .set-hint { font-size: 0.72rem; color: var(--text-muted); margin-top: 4px; }
    .set-hint code { background: var(--primary-lighter); color: var(--primary); padding: 1px 5px;
      border-radius: 3px; font-size: 0.72rem; }
    .set-locked { margin-top: 6px; }
    .set-locked summary { font-size: 0.72rem; color: var(--text-muted); cursor: pointer; }
    .set-locked pre { background: #1e1e2e; color: #cdd6f4; padding: 8px 10px; border-radius: 4px;
      font-family: var(--font-mono); font-size: 0.7rem; line-height: 1.45; white-space: pre-wrap;
      word-break: break-word; margin: 5px 0 0; }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

/**
 * Create the settings drawer + toggle button.
 *
 * @param {{ settings: import('../store/settings.js').settings, onModeChange?:(mode:string)=>void }} opts
 * @returns {{ toggleButton: HTMLButtonElement }}
 */
export function createSettingsPanel({ settings, onModeChange }) {
  injectStyles();

  const toggleButton = document.createElement('button');
  toggleButton.className = 'set-toggle';
  toggleButton.type = 'button';
  toggleButton.textContent = 'Settings';
  toggleButton.title = 'Execution mode and editable prompts';

  const drawer = document.createElement('aside');
  drawer.className = 'set-drawer';
  drawer.setAttribute('aria-label', 'Settings');
  drawer.innerHTML = `
    <div class="set-head">
      <h3>Settings</h3>
      <button class="btn-icon" id="set-close" aria-label="Close" style="font-size:1.2rem">&times;</button>
    </div>
    <div class="set-body">
      <div class="set-section-title">Execution mode</div>
      <div class="set-modes" id="set-modes">
        ${MODES.map(m => `
          <label class="set-mode" data-mode="${m}">
            <input type="radio" name="set-mode" value="${m}">
            <span>
              <span class="mlabel">${esc(MODE_INFO[m].label)}</span>
              <span class="mdesc">${esc(MODE_INFO[m].desc)}</span>
            </span>
          </label>`).join('')}
      </div>

      <div class="set-section-title">Prompts</div>
      <p class="set-hint" style="margin-bottom:10px;">
        Edit the instruction text freely. The fixed JSON output structure (shown locked under each
        system prompt) is always appended by the app so parsing keeps working — don't reproduce it here.
      </p>
      <div id="set-fields"></div>
      <button class="btn btn-secondary btn-sm" id="set-reset-all">Reset all prompts to defaults</button>
    </div>
  `;
  document.body.appendChild(drawer);

  const closeBtn = drawer.querySelector('#set-close');
  const modesEl = drawer.querySelector('#set-modes');
  const fieldsEl = drawer.querySelector('#set-fields');
  const resetAllBtn = drawer.querySelector('#set-reset-all');

  function setOpen(open) {
    drawer.classList.toggle('open', open);
    toggleButton.classList.toggle('active', open);
  }
  toggleButton.addEventListener('click', () => setOpen(!drawer.classList.contains('open')));
  if (closeBtn) closeBtn.addEventListener('click', () => setOpen(false));

  // --- Mode radios ---
  function syncModeUI() {
    const mode = settings.getMode();
    modesEl.querySelectorAll('.set-mode').forEach(el => {
      const m = el.getAttribute('data-mode');
      el.classList.toggle('active', m === mode);
      const input = el.querySelector('input');
      if (input) input.checked = m === mode;
    });
  }
  modesEl.querySelectorAll('input[name="set-mode"]').forEach(input => {
    input.addEventListener('change', () => {
      if (input.checked) {
        settings.setMode(input.value);
        syncModeUI();
        if (onModeChange) onModeChange(input.value);
      }
    });
  });

  // --- Prompt fields ---
  for (const field of PROMPT_FIELDS) {
    const wrap = document.createElement('div');
    wrap.className = 'set-field';
    const placeholderHint = field.kind === 'user' && field.placeholders
      ? `<div class="set-hint">Placeholders: ${field.placeholders.map(p => `<code>${esc(p)}</code>`).join(' ')}</div>`
      : '';
    const lockedBlock = field.kind === 'system' && field.structure
      ? `<details class="set-locked"><summary>Locked output structure (always appended)</summary><pre>${esc(field.structure)}</pre></details>`
      : '';
    wrap.innerHTML = `
      <div class="set-field-head">
        <label for="set-${field.key}">${esc(field.label)}</label>
        <button class="btn btn-secondary btn-xs" data-reset="${field.key}">Reset</button>
      </div>
      <textarea id="set-${field.key}" spellcheck="false"></textarea>
      ${placeholderHint}
      ${lockedBlock}
    `;
    fieldsEl.appendChild(wrap);

    const ta = wrap.querySelector('textarea');
    ta.value = settings.getPrompt(field.key);
    ta.addEventListener('change', () => settings.setPrompt(field.key, ta.value));
    ta.addEventListener('blur', () => settings.setPrompt(field.key, ta.value));
    wrap.querySelector(`[data-reset="${field.key}"]`).addEventListener('click', () => {
      settings.resetPrompt(field.key);
      ta.value = settings.getPrompt(field.key);
    });
  }

  if (resetAllBtn) {
    resetAllBtn.addEventListener('click', () => {
      if (!confirm('Reset all four prompts to their defaults?')) return;
      settings.resetAllPrompts();
      for (const field of PROMPT_FIELDS) {
        const ta = drawer.querySelector(`#set-${field.key}`);
        if (ta) ta.value = settings.getPrompt(field.key);
      }
    });
  }

  // Keep mode UI in sync if mode is changed elsewhere (e.g. the model bar).
  settings.subscribe(() => syncModeUI());
  syncModeUI();

  return { toggleButton };
}
