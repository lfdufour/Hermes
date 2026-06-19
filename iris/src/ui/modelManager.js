/**
 * modelManager.js -- Model picker for Iris.
 *
 * Renders a model selector (light UI-test models first, then Gemma 4), Load/Unload buttons,
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
      <details class="mm-advanced">
        <summary>Advanced</summary>
        <label class="mm-field">Repo
          <input id="mm-repo" type="text" class="mm-input" spellcheck="false">
        </label>
        <label class="mm-field">dtype (string or JSON map)
          <input id="mm-dtype" type="text" class="mm-input" spellcheck="false">
        </label>
        <label class="mm-field">Backend
          <select id="mm-device" class="mm-input">
            <option value="auto">Auto (WebGPU if f16-capable, else CPU)</option>
            <option value="webgpu">WebGPU (force)</option>
            <option value="wasm">WASM / CPU (force)</option>
          </select>
        </label>
        <div class="mm-hint">If a load fails with <code>Could not locate file …/onnx/NAME_DTYPE.onnx</code>,
          set NAME in the JSON above to a dtype that exists (e.g. <code>q2f16</code>, <code>q4f16</code>,
          <code>fp16</code>), then Load again. These weights are f16-only; on a GPU without the
          <code>shader-f16</code> feature WebGPU reports <code>does not support fp16</code> — Auto then
          falls back to the (slower) CPU backend.</div>
      </details>
    </div>
  `;

  const selectEl = container.querySelector('#mm-model-select');
  const loadBtn = container.querySelector('#mm-load-btn');
  const unloadBtn = container.querySelector('#mm-unload-btn');
  const statusEl = container.querySelector('#mm-status');
  const progressRow = container.querySelector('#mm-progress-row');
  const progressBar = container.querySelector('#mm-progress-bar');
  const progressText = container.querySelector('#mm-progress-text');
  const repoEl = container.querySelector('#mm-repo');
  const dtypeEl = container.querySelector('#mm-dtype');
  const deviceEl = container.querySelector('#mm-device');

  // Populate model options
  MODELS.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    if (selectEl) selectEl.appendChild(opt);
  });
  if (selectEl) selectEl.value = MODELS[0].id;

  // Sync the advanced repo/dtype fields from the selected preset.
  function syncAdvanced() {
    const preset = MODELS.find(m => selectEl && m.id === selectEl.value) || MODELS[0];
    if (!preset) return;
    if (repoEl) repoEl.value = preset.repo;
    if (dtypeEl) {
      dtypeEl.value = typeof preset.dtype === 'string'
        ? preset.dtype
        : JSON.stringify(preset.dtype);
    }
  }
  if (selectEl) selectEl.addEventListener('change', syncAdvanced);
  syncAdvanced();

  // Resolve the repo + dtype + backend to load from, preferring the advanced fields.
  function resolveLoadConfig(preset) {
    const repo = (repoEl && repoEl.value.trim()) || preset.repo;
    let dtype = preset.dtype;
    const raw = dtypeEl && dtypeEl.value.trim();
    if (raw) {
      try { dtype = raw.startsWith('{') ? JSON.parse(raw) : raw; }
      catch (_) { dtype = raw; } // fall back to the literal string
    }
    const device = (deviceEl && deviceEl.value) || 'auto';
    return { repo, dtype, device };
  }

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

      const { repo, dtype, device } = resolveLoadConfig(preset);

      try {
        const res = await engine.load({
          repo,
          dtype,
          device,
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
        const backend = res && res.device ? ` · ${res.device}` : '';
        setStatus(`Loaded: ${preset.label}${backend}`);
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
