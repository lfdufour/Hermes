/**
 * ui/debugPanel.js — Model I/O inspector for Hermes Patent Examiner.
 *
 * `createDebugLog()` is a tiny pub/sub buffer that `engine/infer.js` writes to
 * (one record per model call: the prompt sent and the output received).
 * `createDebugPanel()` renders a slide-in drawer (toggled from the top bar)
 * that lists those records live, each expandable to show the system prompt,
 * user prompt, the exact rendered prompt, and the raw model output.
 */

/**
 * Create an in-memory debug log with subscription.
 * @returns {{ record:(rec:object)=>void, subscribe:(fn:Function)=>()=>void,
 *            clear:()=>void, getEntries:()=>object[] }}
 */
export function createDebugLog() {
  const entries = [];
  const subs = new Set();
  return {
    record(rec) {
      const entry = { id: entries.length + 1, ...rec };
      entries.push(entry);
      for (const fn of subs) { try { fn(entry); } catch (_) { /* ignore */ } }
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    clear() {
      entries.length = 0;
      for (const fn of subs) { try { fn(null); } catch (_) { /* ignore */ } }
    },
    getEntries() { return entries.slice(); },
  };
}

let stylesInjected = false;

/** Inject the drawer styles once. */
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
    .dbg-toggle { margin-left: 10px; background: var(--surface-raised); color: var(--text-muted);
      border: 1px solid var(--border); border-radius: var(--radius); padding: 5px 12px;
      font-size: 0.78rem; font-weight: 500; cursor: pointer; white-space: nowrap; }
    .dbg-toggle:hover { color: var(--primary); border-color: var(--primary); }
    .dbg-toggle.active { background: var(--primary-light); color: var(--primary); border-color: var(--primary); }
    .dbg-drawer { position: fixed; top: 0; right: 0; height: 100vh; width: 460px; max-width: 92vw;
      background: var(--surface-raised); border-left: 1px solid var(--border);
      box-shadow: -6px 0 24px rgba(0,0,0,0.10); display: flex; flex-direction: column;
      transform: translateX(100%); transition: transform 0.22s ease; z-index: 1000; }
    .dbg-drawer.open { transform: translateX(0); }
    @media (prefers-reduced-motion: reduce) { .dbg-drawer { transition: none; } }
    .dbg-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px;
      border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .dbg-head h3 { font-family: var(--font-serif); font-size: 1rem; color: var(--primary); margin: 0; flex: 1; }
    .dbg-body { flex: 1; overflow-y: auto; padding: 10px 12px; }
    .dbg-empty { color: var(--text-faint); font-size: 0.82rem; padding: 24px 8px; text-align: center; }
    .dbg-entry { border: 1px solid var(--border-light); border-radius: var(--radius);
      margin-bottom: 8px; background: var(--surface); overflow: hidden; }
    .dbg-entry > summary { cursor: pointer; padding: 8px 12px; font-size: 0.78rem; user-select: none;
      display: flex; align-items: center; gap: 8px; list-style: none; }
    .dbg-entry > summary::-webkit-details-marker { display: none; }
    .dbg-entry > summary:hover { background: var(--primary-lighter); }
    .dbg-num { font-family: var(--font-mono); color: var(--text-faint); font-size: 0.72rem; }
    .dbg-badge { padding: 1px 7px; border-radius: 8px; font-size: 0.65rem; font-weight: 700; }
    .dbg-ok { background: var(--verdict-y-bg); color: var(--verdict-y); }
    .dbg-err { background: var(--verdict-n-bg); color: var(--verdict-n); }
    .dbg-ms { margin-left: auto; color: var(--text-muted); font-size: 0.72rem; white-space: nowrap; }
    .dbg-preview { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; max-width: 200px; }
    .dbg-sections { padding: 4px 12px 12px; }
    .dbg-sec { margin-top: 8px; }
    .dbg-sec h5 { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em;
      color: var(--text-muted); margin: 0 0 3px; }
    .dbg-pre { background: #1e1e2e; color: #cdd6f4; padding: 8px 10px; border-radius: 4px;
      font-family: var(--font-mono); font-size: 0.72rem; line-height: 1.5; white-space: pre-wrap;
      word-break: break-word; max-height: 260px; overflow-y: auto; margin: 0; }
    .dbg-pre.out { background: #0f2417; color: #c6f6d5; }
    .dbg-pre.errtext { background: #2a1414; color: #fecaca; }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}

/** HTML-escape a string for safe insertion. */
function esc(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

/**
 * Create the debug inspector: a toggle button (to place in the top bar) and a
 * slide-in drawer (appended to <body>) that lists model I/O records live.
 *
 * @param {{ debugLog: ReturnType<typeof createDebugLog> }} opts
 * @returns {{ toggleButton: HTMLButtonElement }}
 */
export function createDebugPanel({ debugLog }) {
  injectStyles();

  const toggleButton = document.createElement('button');
  toggleButton.className = 'dbg-toggle';
  toggleButton.type = 'button';
  toggleButton.textContent = 'Debug I/O';
  toggleButton.title = 'Show what is sent to / received from the model';

  const drawer = document.createElement('aside');
  drawer.className = 'dbg-drawer';
  drawer.setAttribute('aria-label', 'Model I/O debug');
  drawer.innerHTML = `
    <div class="dbg-head">
      <h3>Model I/O</h3>
      <button class="btn btn-secondary btn-xs" id="dbg-clear">Clear</button>
      <button class="btn-icon" id="dbg-close" aria-label="Close" style="font-size:1.2rem">&times;</button>
    </div>
    <div class="dbg-body"><div class="dbg-empty">No model calls yet. Run an analysis or mapping.</div></div>
  `;
  document.body.appendChild(drawer);

  const body = drawer.querySelector('.dbg-body');
  const clearBtn = drawer.querySelector('#dbg-clear');
  const closeBtn = drawer.querySelector('#dbg-close');

  function setOpen(open) {
    drawer.classList.toggle('open', open);
    toggleButton.classList.toggle('active', open);
  }
  toggleButton.addEventListener('click', () => setOpen(!drawer.classList.contains('open')));
  if (closeBtn) closeBtn.addEventListener('click', () => setOpen(false));
  if (clearBtn) clearBtn.addEventListener('click', () => debugLog.clear());

  /** Build the DOM for one debug entry. */
  function renderEntry(e) {
    const el = document.createElement('details');
    el.className = 'dbg-entry';
    const preview = esc((e.output || e.error || '').slice(0, 80).replace(/\s+/g, ' '));
    const ms = e.ms != null ? `${e.ms} ms` : '';
    const tok = e.stats && e.stats.tokens != null ? ` · ${e.stats.tokens} tok` : '';
    el.innerHTML = `
      <summary>
        <span class="dbg-num">#${e.id}</span>
        <span class="dbg-badge ${e.ok ? 'dbg-ok' : 'dbg-err'}">${e.ok ? 'OK' : 'ERR'}</span>
        <span class="dbg-preview">${preview || '(empty)'}</span>
        <span class="dbg-ms">${ms}${tok}</span>
      </summary>
      <div class="dbg-sections">
        ${e.system ? `<div class="dbg-sec"><h5>System prompt</h5><pre class="dbg-pre">${esc(e.system)}</pre></div>` : ''}
        ${e.user ? `<div class="dbg-sec"><h5>User prompt</h5><pre class="dbg-pre">${esc(e.user)}</pre></div>` : ''}
        ${e.rendered ? `<div class="dbg-sec"><h5>Rendered prompt (sent to model)</h5><pre class="dbg-pre">${esc(e.rendered)}</pre></div>` : ''}
        ${e.ok
          ? `<div class="dbg-sec"><h5>Model output (received)</h5><pre class="dbg-pre out">${esc(e.output)}</pre></div>`
          : `<div class="dbg-sec"><h5>Error</h5><pre class="dbg-pre errtext">${esc(e.error)}</pre></div>`}
      </div>
    `;
    return el;
  }

  // Live subscription: prepend new entries; on clear (null) reset.
  debugLog.subscribe((entry) => {
    if (!body) return;
    if (entry === null) {
      body.innerHTML = '<div class="dbg-empty">No model calls yet. Run an analysis or mapping.</div>';
      return;
    }
    const emptyEl = body.querySelector('.dbg-empty');
    if (emptyEl) emptyEl.remove();
    body.insertBefore(renderEntry(entry), body.firstChild);
  });

  return { toggleButton };
}
