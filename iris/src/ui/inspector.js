/**
 * inspector.js -- Trace/debug timeline renderer for Iris.
 *
 * Renders TraceEvents inline under a turn in generation order:
 *   - Per-turn summary line counting tool calls
 *   - Collapsible Thinking block (streams thought_delta live)
 *   - One line per tool_call that expands to show args + result
 *   - Final answer streamed from content_delta
 *   - Debug toggle: prompt_built text, raw tokens, step_done timings
 *
 * Exports: createInspector
 */

/**
 * Create an Inspector instance bound to a container element.
 *
 * @param {HTMLElement} container - Where to render trace output for the current turn.
 * @param {{ debugEnabled: () => boolean }} opts
 * @returns {{ handleEvent: (ev: TraceEvent) => void, reset: () => void }}
 */
export function createInspector(container, opts = {}) {
  const debugEnabled = opts.debugEnabled || (() => false);

  // DOM nodes we update incrementally
  let summaryEl = null;      // "N tool calls" line
  let thinkingDetails = null; // <details> for thinking
  let thinkingPre = null;     // <pre> inside thinking
  let contentEl = null;       // final answer streaming area
  let debugSection = null;    // debug-only area
  let debugPromptPre = null;  // prompt_built text
  let debugRawPre = null;     // raw token stream
  let debugStepsPre = null;   // step_done timings

  // Counters
  let toolCallCount = 0;
  let rawTokens = '';

  // Map tool_call id -> DOM node, so we can attach results later
  const toolCallNodes = new Map();

  function ensureContainer() {
    if (!container) return false;
    return true;
  }

  function ensureSummary() {
    if (!ensureContainer()) return;
    if (!summaryEl) {
      summaryEl = document.createElement('div');
      summaryEl.className = 'inspector-summary';
      summaryEl.style.display = 'none';
      container.appendChild(summaryEl);
    }
  }

  function ensureThinking() {
    if (!ensureContainer()) return;
    if (!thinkingDetails) {
      thinkingDetails = document.createElement('details');
      thinkingDetails.className = 'inspector-thinking';
      const sum = document.createElement('summary');
      sum.textContent = 'Thinking...';
      thinkingDetails.appendChild(sum);
      thinkingPre = document.createElement('pre');
      thinkingPre.className = 'inspector-thinking-content';
      thinkingDetails.appendChild(thinkingPre);
      container.appendChild(thinkingDetails);
    }
  }

  function ensureContent() {
    if (!ensureContainer()) return;
    if (!contentEl) {
      contentEl = document.createElement('div');
      contentEl.className = 'inspector-content';
      container.appendChild(contentEl);
    }
  }

  function ensureDebugSection() {
    if (!ensureContainer()) return;
    if (!debugSection) {
      debugSection = document.createElement('div');
      debugSection.className = 'inspector-debug';
      // Only visible when debug is on
      debugSection.style.display = debugEnabled() ? 'block' : 'none';

      const promptLabel = document.createElement('h4');
      promptLabel.textContent = 'Rendered Prompt';
      debugSection.appendChild(promptLabel);
      debugPromptPre = document.createElement('pre');
      debugPromptPre.className = 'inspector-debug-pre';
      debugSection.appendChild(debugPromptPre);

      const rawLabel = document.createElement('h4');
      rawLabel.textContent = 'Raw Tokens';
      debugSection.appendChild(rawLabel);
      debugRawPre = document.createElement('pre');
      debugRawPre.className = 'inspector-debug-pre';
      debugSection.appendChild(debugRawPre);

      const stepsLabel = document.createElement('h4');
      stepsLabel.textContent = 'Step Timings';
      debugSection.appendChild(stepsLabel);
      debugStepsPre = document.createElement('pre');
      debugStepsPre.className = 'inspector-debug-pre';
      debugSection.appendChild(debugStepsPre);

      container.appendChild(debugSection);
    }
  }

  function updateSummaryText() {
    if (summaryEl) {
      if (toolCallCount > 0) {
        summaryEl.textContent = `${toolCallCount} tool call${toolCallCount !== 1 ? 's' : ''}`;
        summaryEl.style.display = 'block';
      } else {
        summaryEl.style.display = 'none';
      }
    }
  }

  function updateDebugVisibility() {
    if (debugSection) {
      debugSection.style.display = debugEnabled() ? 'block' : 'none';
    }
  }

  /**
   * Truncate text for preview display.
   * @param {string} text
   * @param {number} max
   * @returns {string}
   */
  function truncate(text, max = 200) {
    if (typeof text !== 'string') text = String(text);
    if (text.length <= max) return text;
    return text.slice(0, max) + '...';
  }

  /**
   * Render a tool_call line with expandable details.
   * @param {object} call - { id, name, args }
   */
  function renderToolCall(call) {
    if (!ensureContainer()) return;

    toolCallCount++;
    ensureSummary();
    updateSummaryText();

    const details = document.createElement('details');
    details.className = 'inspector-tool-call';

    const summary = document.createElement('summary');
    const argsPreview = truncate(JSON.stringify(call.args), 60);
    summary.textContent = `Used tool: ${call.name}(${argsPreview})`;
    details.appendChild(summary);

    const argsBlock = document.createElement('div');
    argsBlock.className = 'inspector-tool-args';

    const argsLabel = document.createElement('strong');
    argsLabel.textContent = 'Arguments:';
    argsBlock.appendChild(argsLabel);

    const argsPre = document.createElement('pre');
    argsPre.textContent = JSON.stringify(call.args, null, 2);
    argsBlock.appendChild(argsPre);

    // Placeholder for result
    const resultDiv = document.createElement('div');
    resultDiv.className = 'inspector-tool-result';
    resultDiv.textContent = 'Waiting for result...';
    argsBlock.appendChild(resultDiv);

    details.appendChild(argsBlock);
    container.appendChild(details);

    // Store reference so we can update when result arrives
    toolCallNodes.set(call.id, { details, resultDiv, name: call.name });
  }

  /**
   * Render a tool_result, attaching it to the matching tool_call node.
   * @param {object} result - ToolResult
   */
  function renderToolResult(result) {
    const node = toolCallNodes.get(result.tool_call_id);
    if (!node) return;

    const { resultDiv, name } = node;
    resultDiv.innerHTML = '';

    const statusChip = document.createElement('span');
    statusChip.className = result.ok ? 'chip chip-ok' : 'chip chip-err';
    statusChip.textContent = result.ok ? 'OK' : 'Error';
    resultDiv.appendChild(statusChip);

    const timeChip = document.createElement('span');
    timeChip.className = 'chip chip-time';
    timeChip.textContent = `${result.ms}ms`;
    resultDiv.appendChild(timeChip);

    // For file tools, show path + content preview
    const isFileTool = ['read_file', 'write_file', 'list_files'].includes(name);
    const resultContent = document.createElement('pre');
    resultContent.className = 'inspector-result-content';

    if (result.ok) {
      if (isFileTool) {
        const val = result.value;
        if (typeof val === 'string') {
          resultContent.textContent = truncate(val, 500);
        } else if (Array.isArray(val)) {
          // list_files returns array of file entries
          resultContent.textContent = val.map(f =>
            `${f.kind === 'directory' ? '[dir]' : '[file]'} ${f.path} (${f.size}B)`
          ).join('\n');
        } else {
          resultContent.textContent = truncate(JSON.stringify(val, null, 2), 500);
        }
      } else {
        resultContent.textContent = truncate(
          typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2),
          500
        );
      }
    } else {
      resultContent.textContent = result.error || 'Unknown error';
      resultContent.classList.add('inspector-error');
    }

    resultDiv.appendChild(resultContent);
  }

  /**
   * Handle a single TraceEvent. Called for each event as it arrives.
   * @param {TraceEvent} ev
   */
  function handleEvent(ev) {
    if (!ensureContainer()) return;

    switch (ev.type) {
      case 'prompt_built':
        ensureDebugSection();
        if (debugPromptPre) {
          debugPromptPre.textContent = ev.text;
        }
        updateDebugVisibility();
        break;

      case 'thought_delta':
        ensureThinking();
        if (thinkingPre) {
          thinkingPre.textContent += ev.delta;
        }
        // Also capture as raw tokens for debug
        rawTokens += ev.delta;
        if (debugRawPre) debugRawPre.textContent = rawTokens;
        break;

      case 'content_delta':
        ensureContent();
        if (contentEl) {
          contentEl.textContent += ev.delta;
        }
        // Also capture as raw tokens for debug
        rawTokens += ev.delta;
        if (debugRawPre) debugRawPre.textContent = rawTokens;
        break;

      case 'tool_call':
        renderToolCall(ev.call);
        break;

      case 'tool_result':
        renderToolResult(ev.result);
        break;

      case 'step_done':
        ensureDebugSection();
        if (debugStepsPre) {
          const line = `Step: ${ev.tokens} tokens, ${ev.ms}ms, ${ev.tokensPerSec.toFixed(1)} tok/s\n`;
          debugStepsPre.textContent += line;
        }
        updateDebugVisibility();
        break;

      case 'turn_done':
        // Mark thinking as complete
        if (thinkingDetails) {
          const sum = thinkingDetails.querySelector('summary');
          if (sum) sum.textContent = 'Thinking (done)';
        }
        break;

      case 'error':
        ensureContent();
        if (contentEl) {
          const errEl = document.createElement('div');
          errEl.className = 'inspector-error-msg';
          errEl.textContent = `Error: ${ev.message}`;
          contentEl.appendChild(errEl);
        }
        break;

      default:
        // Unknown event type — ignore
        break;
    }
  }

  /**
   * Reset the inspector for a new turn.
   */
  function reset() {
    if (container) container.innerHTML = '';
    summaryEl = null;
    thinkingDetails = null;
    thinkingPre = null;
    contentEl = null;
    debugSection = null;
    debugPromptPre = null;
    debugRawPre = null;
    debugStepsPre = null;
    toolCallCount = 0;
    rawTokens = '';
    toolCallNodes.clear();
  }

  /**
   * Force refresh debug visibility (called when debug toggle changes).
   */
  function refreshDebug() {
    updateDebugVisibility();
  }

  return { handleEvent, reset, refreshDebug };
}
