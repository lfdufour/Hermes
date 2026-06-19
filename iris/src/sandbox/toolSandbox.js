/**
 * sandbox/toolSandbox.js -- Sandboxed executor for user-authored tool code.
 *
 * Custom tools created in the Tools panel are arbitrary JS. We run them inside a
 * dedicated Web Worker spun up from a Blob, which:
 *   - has NO access to the page DOM or the app's modules/state (worker global
 *     scope only), and
 *   - is subject to a wall-clock timeout; a hung tool (e.g. infinite loop) is
 *     killed by terminating the worker, which is then respawned lazily.
 *
 * The dynamic-code construction (`new AsyncFunction`) lives INSIDE the worker,
 * so the main application bundle stays free of eval/Function -- matching the
 * project's no-eval rule for app logic while still allowing user tools.
 *
 * Exports: createToolSandbox
 */

// Worker source. The user's tool body runs as the body of an async function
// that receives a single `args` object and may `return` a JSON-serializable
// value (or a Promise of one). Errors are reported back as strings.
const WORKER_SRC = `
self.onmessage = async (e) => {
  const { id, code, args } = e.data;
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction('args', code);
    const value = await fn(args ?? {});
    // Ensure the result is structured-cloneable; fall back to a string.
    let safe;
    try { safe = JSON.parse(JSON.stringify(value ?? null)); }
    catch (_) { safe = String(value); }
    self.postMessage({ id, ok: true, value: safe });
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err && err.message) ? err.message : String(err) });
  }
};
`;

/**
 * Create a tool sandbox.
 *
 * @returns {{ run: (code:string, args:object, opts?:{timeoutMs?:number}) => Promise<any>,
 *            dispose: () => void }}
 */
export function createToolSandbox() {
  let worker = null;
  let url = null;
  const pending = new Map();
  let nextId = 1;

  function spawn() {
    const blob = new Blob([WORKER_SRC], { type: 'application/javascript' });
    url = URL.createObjectURL(blob);
    worker = new Worker(url);
    worker.onmessage = (e) => {
      const { id, ok, value, error } = e.data || {};
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      if (ok) p.resolve(value);
      else p.reject(new Error(error || 'Tool error'));
    };
    worker.onerror = (e) => {
      // A worker-level error rejects all in-flight calls; respawn on next run.
      const msg = e.message || 'Sandbox worker crashed';
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(msg)); }
      pending.clear();
      kill();
    };
  }

  function kill() {
    if (worker) { try { worker.terminate(); } catch (_) { /* ignore */ } worker = null; }
    if (url) { try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ } url = null; }
  }

  /**
   * Run user `code` (an async function body) with `args`.
   * @param {string} code
   * @param {object} args
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<any>}
   */
  function run(code, args, { timeoutMs = 5000 } = {}) {
    if (!worker) spawn();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // Kill the hung worker so it can't keep running; respawn lazily.
        kill();
        reject(new Error(`Tool timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, code, args: args ?? {} });
    });
  }

  function dispose() {
    for (const [, p] of pending) { clearTimeout(p.timer); }
    pending.clear();
    kill();
  }

  return { run, dispose };
}
