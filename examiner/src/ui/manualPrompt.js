/**
 * ui/manualPrompt.js — Copy-paste ("manual") mode dialog.
 *
 * In manual mode the app does not call any AI. For each cognition step it pops
 * this modal: it shows the EXACT prompt to copy into an external AI, and a box
 * to paste the AI's answer back. `request()` resolves with the pasted text,
 * which then flows through the same JSON parsing as local mode.
 *
 * Calls are serialized: if a request arrives while another is open, it queues.
 */

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
    .mp-overlay { position: fixed; inset: 0; background: rgba(20,24,33,0.55);
      display: flex; align-items: center; justify-content: center; z-index: 1200; padding: 20px; }
    .mp-modal { background: var(--surface-raised); border: 1px solid var(--border);
      border-radius: var(--radius); box-shadow: 0 12px 40px rgba(0,0,0,0.28);
      width: 760px; max-width: 96vw; max-height: 92vh; display: flex; flex-direction: column; }
    .mp-head { padding: 14px 18px; border-bottom: 1px solid var(--border); }
    .mp-head h3 { font-family: var(--font-serif); color: var(--primary); margin: 0; font-size: 1.05rem; }
    .mp-head p { margin: 4px 0 0; font-size: 0.8rem; color: var(--text-muted); }
    .mp-body { padding: 14px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
    .mp-label { display: flex; align-items: center; gap: 8px; font-size: 0.72rem; text-transform: uppercase;
      letter-spacing: 0.04em; color: var(--text-muted); margin-top: 6px; }
    .mp-label .mp-spacer { flex: 1; }
    .mp-prompt { width: 100%; min-height: 150px; max-height: 32vh; font-family: var(--font-mono);
      font-size: 0.74rem; line-height: 1.5; background: #1e1e2e; color: #cdd6f4; border: 1px solid var(--border);
      border-radius: 4px; padding: 10px; resize: vertical; white-space: pre; overflow: auto; }
    .mp-answer { width: 100%; min-height: 120px; max-height: 28vh; font-family: var(--font-mono);
      font-size: 0.78rem; line-height: 1.45; border: 1px solid var(--border); border-radius: 4px; padding: 10px; resize: vertical; }
    .mp-foot { padding: 12px 18px; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 10px; }
    .mp-foot .mp-spacer { flex: 1; }
    .mp-count { font-size: 0.74rem; color: var(--text-faint); }
    .mp-copied { color: var(--verdict-y); font-size: 0.74rem; }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * Create the manual-prompt controller.
 * @returns {{ request: (p:{system?:string,user:string,rendered:string,signal?:AbortSignal})=>Promise<string> }}
 */
export function createManualPromptModal() {
  injectStyles();
  let queue = Promise.resolve();

  function open({ system, user, rendered, signal }) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }

      const overlay = document.createElement('div');
      overlay.className = 'mp-overlay';
      const promptText = rendered || synth(system, user);
      overlay.innerHTML = `
        <div class="mp-modal" role="dialog" aria-modal="true" aria-label="Copy-paste model call">
          <div class="mp-head">
            <h3>Copy-paste mode — call your AI</h3>
            <p>Copy the prompt below into any AI (ChatGPT, Claude, Gemini…), then paste its full answer back. It must return the JSON described in the prompt.</p>
          </div>
          <div class="mp-body">
            <div class="mp-label">Prompt to send
              <span class="mp-spacer"></span>
              <button class="btn btn-secondary btn-xs" id="mp-copy">Copy prompt</button>
              <span class="mp-copied" id="mp-copied" style="display:none">Copied ✓</span>
            </div>
            <textarea class="mp-prompt" id="mp-prompt" readonly spellcheck="false"></textarea>
            <div class="mp-label">Paste the AI's answer here</div>
            <textarea class="mp-answer" id="mp-answer" placeholder="Paste the model's reply (JSON)…" spellcheck="false"></textarea>
          </div>
          <div class="mp-foot">
            <span class="mp-count" id="mp-count">0 chars</span>
            <span class="mp-spacer"></span>
            <button class="btn btn-secondary btn-sm" id="mp-cancel">Cancel</button>
            <button class="btn btn-primary btn-sm" id="mp-submit">Submit answer</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const promptEl = overlay.querySelector('#mp-prompt');
      const answerEl = overlay.querySelector('#mp-answer');
      const countEl = overlay.querySelector('#mp-count');
      const copiedEl = overlay.querySelector('#mp-copied');
      promptEl.value = promptText;

      let settled = false;
      const cleanup = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        overlay.remove();
      };
      const done = (fn, arg) => { if (settled) return; settled = true; cleanup(); fn(arg); };
      const onAbort = () => done(reject, new DOMException('Aborted', 'AbortError'));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      overlay.querySelector('#mp-copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(promptText); }
        catch (_) { promptEl.select(); document.execCommand('copy'); }
        if (copiedEl) { copiedEl.style.display = 'inline'; setTimeout(() => { copiedEl.style.display = 'none'; }, 1500); }
      });
      answerEl.addEventListener('input', () => { if (countEl) countEl.textContent = `${answerEl.value.length} chars`; });
      overlay.querySelector('#mp-cancel').addEventListener('click', () => done(reject, new DOMException('Aborted', 'AbortError')));
      overlay.querySelector('#mp-submit').addEventListener('click', () => {
        const v = answerEl.value.trim();
        if (!v) { answerEl.focus(); return; }
        done(resolve, v);
      });

      answerEl.focus();
    });
  }

  // Serialize calls so multiple mapping cells don't stack modals.
  function request(p) {
    const run = () => open(p);
    const result = queue.then(run, run);
    queue = result.catch(() => {}); // keep the chain alive even if a call is cancelled
    return result;
  }

  return { request };
}

function synth(system, user) {
  const parts = [];
  if (system && system.trim()) parts.push(`### SYSTEM\n${system}`);
  parts.push(`### USER\n${user}`);
  return parts.join('\n\n');
}
