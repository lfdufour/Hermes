/**
 * ui/app.js — Top-level UI controller for Hermes Patent Examiner.
 *
 * Owns the DOM, renders the model bar (pick model, load with progress,
 * device indicator), and routes between three views: Cases, Step 1
 * (Build Table), and Step 2 (Mapping).
 */

import { MODELS, DEFAULT_MODEL_ID, getModel } from '../engine/models.js';
import { renderCasesView } from './casesView.js';
import { renderStep1View } from './step1View.js';
import { renderStep2View } from './step2View.js';
import { createDebugPanel } from './debugPanel.js';
import { createSettingsPanel } from './settingsPanel.js';

/**
 * Initialize the application UI.
 *
 * @param {{ engine: object, infer: object, casesStore: object, settings: object }} deps
 */
export function initApp({ engine, infer, casesStore, debugLog, settings }) {
  const navContainer = document.getElementById('nav-tabs');
  const modelBar = document.getElementById('model-bar');
  const mainContent = document.getElementById('main-content');

  // -- App state --
  let currentView = 'cases'; // 'cases' | 'step1' | 'step2'
  /** @type {import('../types.js').Case|null} */
  let currentCase = null;
  let modelLoaded = false; // tracks the LOCAL provider's loaded model
  let modelLoading = false;
  // The currently-rendered view can register a hook here so it is notified live
  // when readiness changes (its action buttons gate on this).
  let modelStateHook = null;
  // Set by renderModelBar so other code can re-sync the mode selector + control
  // visibility in place, without a disruptive full re-render of the model bar.
  let modeBarSync = null;

  // Readiness is mode-aware: local mode needs a loaded model; manual/mock are
  // always ready (no model). Cognition gating uses this, not modelLoaded.
  const ready = () => infer.isReady();
  const getMode = () => (settings ? settings.getMode() : 'local');

  /** Recompute readiness and push it into nav state + the live view's hook. */
  function refreshReady() {
    updateNavState();
    if (modelStateHook) modelStateHook(ready());
  }

  // ===== Model Bar =====
  /** Render the model selection + load controls. */
  function renderModelBar() {
    if (!modelBar) return;
    modelBar.innerHTML = `
      <div class="mm-row">
        <select id="mm-mode" class="mm-select" aria-label="Execution mode" title="How model calls are fulfilled">
          <option value="local">Mode: Local LLM</option>
          <option value="manual">Mode: Copy-paste</option>
          <option value="mock">Mode: Debug (no AI)</option>
        </select>
        <span id="mm-modelctrls" class="mm-modelctrls">
          <select id="mm-select" class="mm-select" aria-label="Select model">
            ${MODELS.map(m => `<option value="${m.id}" ${m.id === DEFAULT_MODEL_ID ? 'selected' : ''}>${m.label}</option>`).join('')}
          </select>
          <button id="mm-load-btn" class="btn btn-primary btn-sm">Load</button>
          <button id="mm-unload-btn" class="btn btn-danger btn-sm" style="display:none">Unload</button>
        </span>
        <span id="mm-status" class="mm-status">Idle</span>
        <span id="mm-device" class="mm-device-badge" style="display:none"></span>
      </div>
      <div id="mm-progress" class="mm-progress-wrap" style="display:none">
        <progress id="mm-progress-bar" max="100" value="0"></progress>
        <span id="mm-progress-text" class="mm-progress-text"></span>
      </div>
    `;

    const modeEl = modelBar.querySelector('#mm-mode');
    const modelCtrls = modelBar.querySelector('#mm-modelctrls');
    const selectEl = modelBar.querySelector('#mm-select');
    const loadBtn = modelBar.querySelector('#mm-load-btn');
    const unloadBtn = modelBar.querySelector('#mm-unload-btn');
    const statusEl = modelBar.querySelector('#mm-status');
    const deviceEl = modelBar.querySelector('#mm-device');
    const progressWrap = modelBar.querySelector('#mm-progress');
    const progressBar = modelBar.querySelector('#mm-progress-bar');
    const progressText = modelBar.querySelector('#mm-progress-text');

    // --- Execution mode ---
    /** Reflect the active mode: hide model load controls unless in local mode. */
    function applyMode() {
      const mode = getMode();
      if (modeEl) modeEl.value = mode;
      if (modelCtrls) modelCtrls.style.display = mode === 'local' ? '' : 'none';
      if (deviceEl && mode !== 'local') deviceEl.style.display = 'none';
      if (statusEl) {
        if (mode === 'manual') statusEl.textContent = 'Copy-paste mode — no local model needed';
        else if (mode === 'mock') statusEl.textContent = 'Debug mode — no AI is called';
        else statusEl.textContent = modelLoaded ? statusEl.textContent : 'Idle';
      }
    }
    if (modeEl) {
      modeEl.addEventListener('change', () => {
        if (settings) settings.setMode(modeEl.value); // emits → syncs everything
        applyMode();
        refreshReady();
      });
    }
    applyMode();
    // Expose in-place sync so settings changes elsewhere don't force a full
    // re-render (which would lose the loaded-model button state).
    modeBarSync = applyMode;

    if (loadBtn) {
      loadBtn.addEventListener('click', async () => {
        if (modelLoading || modelLoaded) return;
        const preset = getModel(selectEl ? selectEl.value : DEFAULT_MODEL_ID);
        if (!preset) return;

        modelLoading = true;
        loadBtn.disabled = true;
        if (selectEl) selectEl.disabled = true;
        if (statusEl) statusEl.textContent = 'Loading…';
        if (progressWrap) progressWrap.style.display = 'flex';
        if (progressBar) progressBar.value = 0;
        if (progressText) progressText.textContent = 'Starting download…';

        try {
          const res = await engine.load({
            repo: preset.repo,
            dtype: preset.dtype,
            device: 'auto',
            onProgress: ({ file, loaded: loadedBytes, total, pct }) => {
              if (progressBar) progressBar.value = pct;
              if (progressText) {
                const lMB = (loadedBytes / 1024 / 1024).toFixed(1);
                const tMB = (total / 1024 / 1024).toFixed(1);
                progressText.textContent = `${file}: ${lMB}/${tMB} MB (${Math.round(pct)}%)`;
              }
            },
          });

          modelLoaded = true;
          infer.setModelLoaded(true);

          const backend = (res && res.device) ? res.device : 'unknown';
          if (statusEl) statusEl.textContent = `Loaded: ${preset.label}`;
          if (deviceEl) {
            deviceEl.textContent = backend;
            deviceEl.style.display = 'inline-block';
          }
          if (loadBtn) loadBtn.style.display = 'none';
          if (unloadBtn) unloadBtn.style.display = 'inline-block';
          if (progressWrap) progressWrap.style.display = 'none';
          // Notify nav + the live view so its (already-rendered) action button enables.
          refreshReady();
        } catch (err) {
          if (statusEl) statusEl.textContent = 'Error: ' + err.message;
          console.error('[Hermes] Model load failed:', err);
        } finally {
          modelLoading = false;
          if (loadBtn) loadBtn.disabled = false;
          if (selectEl) selectEl.disabled = false;
        }
      });
    }

    if (unloadBtn) {
      unloadBtn.addEventListener('click', async () => {
        if (!modelLoaded) return;
        try {
          await engine.unload();
        } catch (err) {
          console.error('[Hermes] Unload failed:', err);
        }
        modelLoaded = false;
        infer.setModelLoaded(false);
        if (statusEl) statusEl.textContent = 'Idle';
        if (deviceEl) deviceEl.style.display = 'none';
        if (unloadBtn) unloadBtn.style.display = 'none';
        if (loadBtn) loadBtn.style.display = 'inline-block';
        refreshReady();
      });
    }
  }

  // ===== Navigation Tabs =====
  const TABS = [
    { id: 'cases', label: 'Cases', alwaysEnabled: true },
    { id: 'step1', label: 'Step 1: Build Table', alwaysEnabled: false },
    { id: 'step2', label: 'Step 2: Mapping', alwaysEnabled: false },
  ];

  /** Render the navigation tabs. */
  function renderNav() {
    if (!navContainer) return;
    navContainer.innerHTML = TABS.map(tab =>
      `<button class="nav-tab${tab.id === currentView ? ' active' : ''}" data-view="${tab.id}">${tab.label}</button>`
    ).join('');

    navContainer.querySelectorAll('.nav-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const view = btn.getAttribute('data-view');
        if (view) navigateTo(view);
      });
    });
    updateNavState();
  }

  /** Update which tabs are enabled based on current app state. */
  function updateNavState() {
    if (!navContainer) return;
    navContainer.querySelectorAll('.nav-tab').forEach(btn => {
      const view = btn.getAttribute('data-view');
      const tab = TABS.find(t => t.id === view);
      if (!tab) return;

      if (tab.alwaysEnabled) {
        btn.disabled = false;
      } else if (view === 'step1') {
        // Step 1 requires readiness (model loaded, or manual/mock mode) OR an
        // existing case already loaded.
        btn.disabled = !ready() && !currentCase;
      } else if (view === 'step2') {
        // Step 2 requires readiness + a frozen table in the current case.
        btn.disabled = !ready() || !currentCase || !currentCase.table ||
                       !currentCase.table.features || currentCase.table.features.length === 0;
      }

      // Highlight active
      btn.classList.toggle('active', view === currentView);
    });
  }

  /**
   * Navigate to a view.
   * @param {string} view - 'cases' | 'step1' | 'step2'
   * @param {object} [opts] - Optional context (e.g., case to open)
   */
  function navigateTo(view, opts) {
    currentView = view;
    renderNav();
    renderView(opts);
  }

  /** Render the current view into the main content area. */
  function renderView(opts) {
    if (!mainContent) return;
    mainContent.innerHTML = '';
    // Drop any hook registered by the previous view before rendering the next.
    modelStateHook = null;

    const container = document.createElement('div');
    container.className = 'view-container';
    mainContent.appendChild(container);

    switch (currentView) {
      case 'cases':
        renderCasesView(container, {
          casesStore,
          onOpenCase: (caseObj) => {
            currentCase = caseObj;
            // If the case has a table with features, go to step 2 if it has mappings, else step 1
            if (caseObj.table && caseObj.table.features && caseObj.table.features.length > 0) {
              // If there are documents/mappings, go to step2
              if (caseObj.documents && caseObj.documents.length > 0) {
                navigateTo('step2');
              } else {
                navigateTo('step1', { tableReady: true });
              }
            } else {
              navigateTo('step1');
            }
          },
          onNewCase: () => {
            currentCase = casesStore.newCase({ title: 'Untitled Case' });
            navigateTo('step1');
          },
        });
        break;

      case 'step1':
        renderStep1View(container, {
          infer,
          casesStore,
          currentCase,
          modelLoaded: ready(),
          registerModelHook: (fn) => { modelStateHook = fn; },
          tableReady: opts && opts.tableReady,
          onCaseUpdated: (updatedCase) => {
            currentCase = updatedCase;
            updateNavState();
          },
          onFreezeAndContinue: (frozenCase) => {
            currentCase = frozenCase;
            navigateTo('step2');
          },
        });
        break;

      case 'step2':
        renderStep2View(container, {
          infer,
          casesStore,
          currentCase,
          modelLoaded: ready(),
          registerModelHook: (fn) => { modelStateHook = fn; },
          onCaseUpdated: (updatedCase) => {
            currentCase = updatedCase;
          },
        });
        break;

      default:
        container.innerHTML = '<p>Unknown view.</p>';
    }
  }

  // ===== Boot =====
  renderModelBar();
  renderNav();
  renderView();

  const topBar = document.querySelector('.top-bar');

  // Settings drawer: execution mode + editable prompts.
  if (settings) {
    const { toggleButton } = createSettingsPanel({ settings });
    if (topBar && toggleButton) topBar.appendChild(toggleButton);
    // Mode can change from either the model bar or the settings drawer; a single
    // subscription keeps the model bar selector + nav gating in sync in place.
    settings.subscribe(() => {
      if (modeBarSync) modeBarSync();
      refreshReady();
    });
  }

  // Debug inspector: toggle button in the top bar + slide-in drawer.
  if (debugLog) {
    const { toggleButton } = createDebugPanel({ debugLog });
    if (topBar && toggleButton) topBar.appendChild(toggleButton);
  }
}
