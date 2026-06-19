/**
 * modelManager.js -- Model picker for Iris.
 *
 * Renders a model selector (E2B default, E4B), Load/Unload buttons,
 * download progress bar, and loaded/idle status indicator.
 *
 * Exports: createModelManager
 */

import { MODELS } from '../types.js';

/**
 * Create the model manager UI.
 *
 * @param {HTMLElement} container - The DOM element to render into.
 * @param {{ engine: import('../engine/client.js').EngineClient }} deps
 * @returns {{ getSelectedModel: () => ModelPreset|null, isLoaded: () => boolean,
 *            onLoadStateChange: (fn: (loaded:boolean) => void) => void }}
 */
export function createModelManager(container, { engine }) {
  let loaded = false;
  let loading = false;
  let currentModelId = null;
  const listeners = [];

  if (!container) {
    return {
      getSelectedModel: () => MODELS[0],
      isLoaded: () => false,
      onLoadStateChange: () => {},
    };
  }

  container.innerHTML = `
    <div class="model-manager">
      <div class="model-manager-row">
        <select id="mm-model-select" class="mm-select" aria-label="Select model"></select>
        <button id="mm-load-btn" class="btn-primary btn-sm">Load</button>
        <button id="mm-unload-btn" class="btn-danger btn-sm" style="display:none">Unload</button>
        <span id="mm-status" class="mm-status">Idle</span>
      </div>
      <div id="mm-progress-row" class="mm-progress-row" style="display:none">
        <progress id="mm-progress-bar" max="100" value="0"></progress>
        <span id="mm-progress-text" class="mm-progress-text"></span>
      </div>
    </div>
  `;

  const selectEl = container.querySelector('#mm-model-select');
  const loadBtn = container.querySelector('#mm-load-btn');
  const unloadBtn = container.querySelector('#mm-unload-btn');
  const statusEl = container.querySelector('#mm-status');
  const progressRow = container.querySelector('#mm-progress-row');
  const progressBar = container.querySelector('#mm-progress-bar');
  const progressText = container.querySelector('#mm-progress-text');

  // Populate model options
  MODELS.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    if (selectEl) selectEl.appendChild(opt);
  });
  if (selectEl) selectEl.value = 'E2B';

  function notifyListeners() {
    for (const fn of listeners) {
      try { fn(loaded); } catch (_) { /* ignore */ }
    }
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function showProgress(show) {
    if (progressRow) progressRow.style.display = show ? 'flex' : 'none';
  }

  // Load
  if (loadBtn) {
    loadBtn.addEventListener('click', async () => {
      if (loading || loaded) return;

      const preset = MODELS.find(m => selectEl && m.id === selectEl.value);
      if (!preset) return;

      loading = true;
      loadBtn.disabled = true;
      if (selectEl) selectEl.disabled = true;
      setStatus('Loading...');
      showProgress(true);
      if (progressBar) progressBar.value = 0;
      if (progressText) progressText.textContent = 'Starting download...';

      try {
        await engine.load({
          repo: preset.repo,
          dtype: preset.dtype,
          device: 'webgpu',
          onProgress: ({ file, loaded: loadedBytes, total, pct }) => {
            if (progressBar) progressBar.value = pct;
            if (progressText) {
              const lMB = (loadedBytes / 1024 / 1024).toFixed(1);
              const tMB = (total / 1024 / 1024).toFixed(1);
              progressText.textContent = `${file}: ${lMB}/${tMB} MB (${Math.round(pct)}%)`;
            }
          },
        });

        loaded = true;
        currentModelId = preset.id;
        setStatus(`Loaded: ${preset.label}`);
        loadBtn.style.display = 'none';
        if (unloadBtn) unloadBtn.style.display = 'inline-block';
        showProgress(false);
        notifyListeners();
      } catch (e) {
        setStatus('Error: ' + e.message);
        console.error('Model load failed:', e);
      } finally {
        loading = false;
        loadBtn.disabled = false;
        if (selectEl) selectEl.disabled = false;
      }
    });
  }

  // Unload
  if (unloadBtn) {
    unloadBtn.addEventListener('click', async () => {
      if (!loaded) return;

      try {
        await engine.unload();
      } catch (e) {
        console.error('Unload failed:', e);
      }

      loaded = false;
      currentModelId = null;
      setStatus('Idle');
      if (unloadBtn) unloadBtn.style.display = 'none';
      if (loadBtn) loadBtn.style.display = 'inline-block';
      notifyListeners();
    });
  }

  return {
    getSelectedModel() {
      if (selectEl) {
        return MODELS.find(m => m.id === selectEl.value) || null;
      }
      return MODELS[0];
    },
    isLoaded() {
      return loaded;
    },
    onLoadStateChange(fn) {
      listeners.push(fn);
    },
  };
}
