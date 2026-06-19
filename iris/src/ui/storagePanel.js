/**
 * storagePanel.js -- Storage / cache management panel for Iris.
 *
 * Shows usage/quota (MB), a "Keep cached (persist)" button,
 * and a "Clear cache" button. Uses engine.storage() RPC.
 *
 * Exports: createStoragePanel
 */

/**
 * Create the storage panel UI.
 *
 * @param {HTMLElement} container - The DOM element to render into.
 * @param {{ engine: import('../engine/client.js').EngineClient }} deps
 * @returns {{ refresh: () => Promise<void> }}
 */
export function createStoragePanel(container, { engine }) {
  if (!container) {
    return { refresh: async () => {} };
  }

  container.innerHTML = `
    <div class="storage-panel">
      <h3 class="panel-title">Storage</h3>
      <div id="sp-info" class="sp-info">Loading...</div>
      <div class="sp-buttons">
        <button id="sp-persist-btn" class="btn-primary btn-sm">Keep cached (persist)</button>
        <button id="sp-clear-btn" class="btn-danger btn-sm">Clear cache</button>
      </div>
      <div id="sp-status" class="sp-status"></div>
    </div>
  `;

  const infoEl = container.querySelector('#sp-info');
  const persistBtn = container.querySelector('#sp-persist-btn');
  const clearBtn = container.querySelector('#sp-clear-btn');
  const statusEl = container.querySelector('#sp-status');

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  async function refresh() {
    try {
      const { result } = await engine.storage('estimate');
      if (infoEl && result) {
        const usageMB = ((result.usage || 0) / 1024 / 1024).toFixed(1);
        const quotaMB = ((result.quota || 0) / 1024 / 1024).toFixed(1);
        infoEl.textContent = `Usage: ${usageMB} MB / ${quotaMB} MB`;
      }
    } catch (e) {
      if (infoEl) infoEl.textContent = 'Unable to estimate storage.';
    }
  }

  // Persist
  if (persistBtn) {
    persistBtn.addEventListener('click', async () => {
      try {
        const { result } = await engine.storage('persist');
        setStatus(result ? 'Storage persisted.' : 'Persistence not available.');
      } catch (e) {
        setStatus('Persist failed: ' + e.message);
      }
    });
  }

  // Clear
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (!confirm('Clear all cached model data? You will need to re-download.')) return;
      try {
        await engine.storage('clear');
        setStatus('Cache cleared.');
        await refresh();
      } catch (e) {
        setStatus('Clear failed: ' + e.message);
      }
    });
  }

  // Initial load
  refresh();

  return { refresh };
}
