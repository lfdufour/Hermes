/**
 * main.js — Bootstrap for Hermes Patent Examiner.
 *
 * Instantiates the reused Iris EngineClient, creates the inference facade,
 * initializes the IndexedDB case store, and hands everything to the UI app
 * controller.
 */

import { EngineClient } from '../../iris/src/engine/client.js';
import { createInference } from './engine/infer.js';
import { casesStore } from './store/cases.js';
import { initApp } from './ui/app.js';
import { createDebugLog } from './ui/debugPanel.js';

async function boot() {
  // NOTE: EngineClient spawns a Web Worker internally; it must be constructed
  // in the browser (not at import time) so import.meta.url resolves correctly.
  const engine = new EngineClient();
  // Debug log captures every model call (prompt sent + output received) for the
  // inspector drawer; wired into inference here.
  const debugLog = createDebugLog();
  const infer = createInference({ engine, onDebug: debugLog.record });

  // Initialize IndexedDB store before rendering
  try {
    await casesStore.init();
  } catch (err) {
    console.error('[Hermes] Failed to initialize case store:', err);
    // Continue — the UI can still work without persistence, just with warnings
  }

  initApp({ engine, infer, casesStore, debugLog });
}

boot().catch((err) => {
  console.error('[Hermes] Bootstrap failed:', err);
  const el = document.getElementById('main-content');
  if (el) {
    el.innerHTML = `<div class="card" style="margin:40px auto;max-width:600px;text-align:center;">
      <h2 style="color:var(--danger)">Failed to start</h2>
      <p style="margin-top:8px;">${err.message || 'Unknown error'}</p>
      <p style="margin-top:12px;font-size:0.82rem;color:var(--text-muted)">
        Hermes requires a modern browser with WebGPU or WASM support, served over HTTP(S) (not file://).
      </p>
    </div>`;
  }
});
