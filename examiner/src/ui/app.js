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

/**
 * Initialize the application UI.
 *
 * @param {{ engine: object, infer: object, casesStore: object }} deps
 */
export function initApp({ engine, infer, casesStore, debugLog }) {
  const navContainer = document.getElementById('nav-tabs');
  const modelBar = document.getElementById('model-bar');
  const mainContent = document.getElementById('main-content');

  // -- App state --
  let currentView = 'cases'; // 'cases' | 'step1' | 'step2'
  /** @type {import('../types.js').Case|null} */
  let currentCase = null;
  let modelLoaded = false;
  let modelLoading = false;
  // The currently-rendered view can register a hook here so it is notified live
  // when the model finishes loading/unloading (its action buttons gate on this).
  let modelStateHook = null;

  // ===== Model Bar =====
  /** Render the model selection + load controls. */
  function renderModelBar() {
    if (!modelBar) return;
    modelBar.innerHTML = `
      <div class="mm-row">
        <select id="mm-select" class="mm-select" aria-label="Select model">
          ${MODELS.map(m => `<option value="${m.id}" ${m.id === DEFAULT_MODEL_ID ? 'selected' : ''}>${m.label}</option>`).join('')}
        </select>
        <button id="mm-load-btn" class="btn btn-primary btn-sm">Load</button>
        <button id="mm-unload-btn" class="btn btn-danger btn-sm" style="display:none">Unload</button>
        <span id="mm-status" class="mm-status">Idle</span>
        <span id="mm-device" class="mm-device-badge" style="display:none"></span>
      </div>
      <div id="mm-progress" class="mm-progress-wrap" style="display:none">
        <progress id="mm-progress-bar" max="100" value="0"></progress>
        <span id="mm-progress-text" class="mm-progress-text"></span>
      </div>
    `;

    const selectEl = modelBar.querySelector('#mm-select');
    const loadBtn = modelBar.querySelector('#mm-load-btn');
    const unloadBtn = modelBar.querySelector('#mm-unload-btn');
    const statusEl = modelBar.querySelector('#mm-status');
    const deviceEl = modelBar.querySelector('#mm-device');
    const progressWrap = modelBar.querySelector('#mm-progress');
    const progressBar = modelBar.querySelector('#mm-progress-bar');
    const progressText = modelBar.querySelector('#mm-progress-text');

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
          updateNavState();
          // Notify the live view so its (already-rendered) action button enables.
          if (modelStateHook) modelStateHook(true);
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
        updateNavState();
        if (modelStateHook) modelStateHook(false);
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
        // Step 1 requires a model loaded OR an existing case loaded
        btn.disabled = !modelLoaded && !currentCase;
      } else if (view === 'step2') {
        // Step 2 requires a frozen table in the current case + model loaded
        btn.disabled = !modelLoaded || !currentCase || !currentCase.table ||
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
          modelLoaded,
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
          modelLoaded,
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

  // Debug inspector: toggle button in the top bar + slide-in drawer.
  if (debugLog) {
    const { toggleButton } = createDebugPanel({ debugLog });
    const topBar = document.querySelector('.top-bar');
    if (topBar && toggleButton) topBar.appendChild(toggleButton);
  }
}
