/**
 * protocol/gemma.js — Gemma-4 prompt shaping + output parsing.
 *
 * Encoding is handled by the tokenizer's apply_chat_template (in the worker).
 * This module only:
 *   (a) shapes messages/tools and applies the multi-turn thought rule, and
 *   (b) parses model output (streaming + non-streaming).
 *
 * VERIFY: All marker strings below are PROVISIONAL and must be confirmed
 * against the model's real tokenizer_config.json special tokens map.
 */

// ---------- Provisional marker tokens ----------
// VERIFY: these must be confirmed against the model's tokenizer_config.json
const THOUGHT_OPEN  = '<|channel>thought\n';
const THOUGHT_CLOSE = '<channel|>';
const TOOL_OPEN     = '<|tool_call>';
const TOOL_CLOSE    = '<tool_call|>';

// ---------- buildMessagesForPrompt ----------

/**
 * Apply the multi-turn thought rule and return a shaped copy of messages
 * suitable for passing to the worker's applyChatTemplate.
 *
 * Rule: drop `thoughts` from completed prior assistant turns, BUT keep
 * thoughts within a turn that also has tool_calls.
 *
 * @param {Message[]} messages
 * @param {{thinking: boolean}} opts
 * @returns {Message[]}
 */
export function buildMessagesForPrompt(messages, { thinking = false } = {}) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = { ...messages[i] };

    if (msg.role === 'assistant') {
      // Determine if this is a "completed prior" assistant turn:
      // all assistant turns except the very last one in the array are prior.
      const isLastAssistant = !messages.slice(i + 1).some(m => m.role === 'assistant');

      if (!isLastAssistant) {
        // Prior completed turn — drop thoughts UNLESS the turn has tool_calls
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Keep thoughts within a turn that issues tool calls
        } else {
          // Drop thoughts from completed prior turns
          delete msg.thoughts;
        }
      }
      // The last assistant turn keeps thoughts as-is (it may be in progress)
    }

    out.push(msg);
  }
  return out;
}

// ---------- toolSpecsToTemplate ----------

/**
 * Shape tool specs for the tokenizer's apply_chat_template.
 * Currently a pass-through that ensures each tool has the expected shape.
 *
 * @param {ToolSpec[]} tools
 * @returns {ToolSpec[]}
 */
export function toolSpecsToTemplate(tools) {
  if (!tools || tools.length === 0) return [];
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters || {},
  }));
}

// ---------- JSON repair ----------

/**
 * Best-effort repair of JSON-ish strings: single quotes → double quotes,
 * trailing commas before } or ], and unquoted keys.
 *
 * @param {string} raw
 * @returns {object}
 */
function repairAndParseJSON(raw) {
  // First try as-is
  try {
    return JSON.parse(raw);
  } catch (_) { /* fall through */ }

  let s = raw;

  // Replace single-quoted strings with double-quoted strings.
  // Strategy: walk character by character to handle escaping properly.
  s = replaceSingleQuotes(s);

  // Remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(s);
  } catch (_) { /* fall through */ }

  // Last resort: try to fix unquoted keys like {key: "value"}
  s = s.replace(/(?<=\{|,)\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '"$1":');

  return JSON.parse(s); // let it throw if still broken
}

/**
 * Replace single-quoted strings with double-quoted strings in a JSON-like string.
 */
function replaceSingleQuotes(s) {
  const chars = [...s];
  const out = [];
  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const prev = i > 0 ? chars[i - 1] : '';

    if (c === '"' && !inSingle && prev !== '\\') {
      inDouble = !inDouble;
      out.push(c);
    } else if (c === "'" && !inDouble && prev !== '\\') {
      if (inSingle) {
        inSingle = false;
        out.push('"');
      } else {
        inSingle = true;
        out.push('"');
      }
    } else {
      // Inside single-quoted strings, escape any unescaped double quotes
      if (inSingle && c === '"' && prev !== '\\') {
        out.push('\\"');
      } else {
        out.push(c);
      }
    }
  }
  return out.join('');
}

// ---------- parseToolCall ----------

/**
 * Parse a single raw tool call string into a ToolCall.
 * Expected format (VERIFY): call:NAME{ ...json... }
 * Tolerant: handles single quotes, trailing commas, etc.
 *
 * @param {string} raw  — the text between <|tool_call> and <tool_call|>
 * @returns {ToolCall}
 */
export function parseToolCall(raw) {
  const trimmed = raw.trim();

  // VERIFY: format is "call:NAME{json}" or "call:NAME {json}"
  const match = trimmed.match(/^call:([a-zA-Z_][a-zA-Z0-9_]*)\s*(\{[\s\S]*\})$/);
  if (!match) {
    // Fallback: try without the call: prefix
    const fallback = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*(\{[\s\S]*\})$/);
    if (!fallback) {
      throw new Error(`Cannot parse tool call: ${trimmed.slice(0, 100)}`);
    }
    const name = fallback[1];
    const args = repairAndParseJSON(fallback[2]);
    return { id: generateId(), name, args };
  }

  const name = match[1];
  const args = repairAndParseJSON(match[2]);
  return { id: generateId(), name, args };
}

/**
 * Generate a short unique-ish ID for a tool call.
 */
let _idCounter = 0;
function generateId() {
  return `tc_${Date.now().toString(36)}_${(++_idCounter).toString(36)}`;
}

// ---------- splitFinal ----------

/**
 * Non-streaming parse of a complete model output text.
 * Extracts thoughts, content, and tool_calls.
 *
 * @param {string} outputText
 * @returns {{thoughts: string, content: string, tool_calls: ToolCall[]}}
 */
export function splitFinal(outputText) {
  let thoughts = '';
  let remaining = outputText;

  // Extract thinking channel
  // VERIFY: thought markers
  const thoughtOpenIdx = remaining.indexOf(THOUGHT_OPEN);
  if (thoughtOpenIdx !== -1) {
    const afterOpen = thoughtOpenIdx + THOUGHT_OPEN.length;
    const thoughtCloseIdx = remaining.indexOf(THOUGHT_CLOSE, afterOpen);
    if (thoughtCloseIdx !== -1) {
      thoughts = remaining.substring(afterOpen, thoughtCloseIdx);
      // Remove the thought block from remaining text
      remaining = remaining.substring(0, thoughtOpenIdx) +
                  remaining.substring(thoughtCloseIdx + THOUGHT_CLOSE.length);
    }
  }

  // Extract tool calls
  // VERIFY: tool call markers
  const toolCalls = [];
  let searchStart = 0;
  while (true) {
    const openIdx = remaining.indexOf(TOOL_OPEN, searchStart);
    if (openIdx === -1) break;
    const afterOpen = openIdx + TOOL_OPEN.length;
    const closeIdx = remaining.indexOf(TOOL_CLOSE, afterOpen);
    if (closeIdx === -1) break;

    const rawCall = remaining.substring(afterOpen, closeIdx);
    try {
      toolCalls.push(parseToolCall(rawCall));
    } catch (_) {
      // NOTE: skip unparseable tool calls to be resilient
    }
    searchStart = closeIdx + TOOL_CLOSE.length;
  }

  // The content is whatever remains after removing all tool call blocks
  let content = remaining;
  // Remove tool call blocks from content
  while (true) {
    const openIdx = content.indexOf(TOOL_OPEN);
    if (openIdx === -1) break;
    const closeIdx = content.indexOf(TOOL_CLOSE, openIdx);
    if (closeIdx === -1) break;
    content = content.substring(0, openIdx) + content.substring(closeIdx + TOOL_CLOSE.length);
  }

  content = content.trim();

  return { thoughts, content, tool_calls: toolCalls };
}

// ---------- createStreamParser ----------

/**
 * Streaming parser for Gemma-4 output.
 *
 * push(textDelta) -> TraceEvent[]    — feed incoming text chunks
 * end()           -> TraceEvent[]    — flush remaining buffered content
 *
 * Robust to markers split across chunk boundaries.
 *
 * VERIFY: marker strings must match the model's actual output tokens.
 *
 * @returns {{push: (delta: string) => TraceEvent[], end: () => TraceEvent[]}}
 */
export function createStreamParser() {
  let buffer = '';

  // State tracking
  // 'idle'     — not inside any special block
  // 'thought'  — inside <|channel>thought\n ... <channel|>
  // 'toolcall' — inside <|tool_call> ... <tool_call|>
  let state = 'idle';

  // The longest partial prefix of any opening/closing marker we need to check.
  // We need to buffer enough to detect partial markers at chunk boundaries.
  const ALL_MARKERS = [THOUGHT_OPEN, THOUGHT_CLOSE, TOOL_OPEN, TOOL_CLOSE];
  const MAX_MARKER_LEN = Math.max(...ALL_MARKERS.map(m => m.length));

  /**
   * Check if `text` ends with a prefix of any of the given markers.
   * Returns the length of the longest such partial match (0 if none).
   */
  function partialMarkerSuffixLen(text, markers) {
    let maxLen = 0;
    for (const marker of markers) {
      for (let len = 1; len < marker.length; len++) {
        if (text.endsWith(marker.substring(0, len))) {
          maxLen = Math.max(maxLen, len);
        }
      }
    }
    return maxLen;
  }

  function push(textDelta) {
    buffer += textDelta;
    const events = [];
    processBuffer(events);
    return events;
  }

  function end() {
    const events = [];
    // Flush whatever is left in the buffer
    flushBuffer(events);
    return events;
  }

  function processBuffer(events) {
    // Keep processing until we can't make progress
    let changed = true;
    while (changed) {
      changed = false;

      if (state === 'idle') {
        // Look for thought open or tool_call open
        const thoughtIdx = buffer.indexOf(THOUGHT_OPEN);
        const toolIdx = buffer.indexOf(TOOL_OPEN);

        // Determine which marker comes first
        let firstMarker = null;
        let firstIdx = -1;

        if (thoughtIdx !== -1 && (toolIdx === -1 || thoughtIdx <= toolIdx)) {
          firstMarker = 'thought';
          firstIdx = thoughtIdx;
        } else if (toolIdx !== -1) {
          firstMarker = 'toolcall';
          firstIdx = toolIdx;
        }

        if (firstMarker !== null) {
          // Emit content before the marker
          if (firstIdx > 0) {
            events.push({ type: 'content_delta', delta: buffer.substring(0, firstIdx) });
          }

          if (firstMarker === 'thought') {
            buffer = buffer.substring(firstIdx + THOUGHT_OPEN.length);
            state = 'thought';
          } else {
            buffer = buffer.substring(firstIdx + TOOL_OPEN.length);
            state = 'toolcall';
          }
          changed = true;
        } else {
          // No complete marker found. Emit content that can't be part of a marker prefix.
          const partialLen = partialMarkerSuffixLen(buffer, [THOUGHT_OPEN, TOOL_OPEN]);
          const safeLen = buffer.length - partialLen;
          if (safeLen > 0) {
            events.push({ type: 'content_delta', delta: buffer.substring(0, safeLen) });
            buffer = buffer.substring(safeLen);
          }
        }
      } else if (state === 'thought') {
        // Inside thought block, look for close marker
        const closeIdx = buffer.indexOf(THOUGHT_CLOSE);
        if (closeIdx !== -1) {
          // Emit thought content up to the close
          if (closeIdx > 0) {
            events.push({ type: 'thought_delta', delta: buffer.substring(0, closeIdx) });
          }
          buffer = buffer.substring(closeIdx + THOUGHT_CLOSE.length);
          state = 'idle';
          changed = true;
        } else {
          // No close marker yet. Emit thought content that can't be part of the close marker prefix.
          const partialLen = partialMarkerSuffixLen(buffer, [THOUGHT_CLOSE]);
          const safeLen = buffer.length - partialLen;
          if (safeLen > 0) {
            events.push({ type: 'thought_delta', delta: buffer.substring(0, safeLen) });
            buffer = buffer.substring(safeLen);
          }
        }
      } else if (state === 'toolcall') {
        // Inside tool call block, look for close marker
        const closeIdx = buffer.indexOf(TOOL_CLOSE);
        if (closeIdx !== -1) {
          // Parse the tool call
          const rawCall = buffer.substring(0, closeIdx);
          try {
            const call = parseToolCall(rawCall);
            events.push({ type: 'tool_call', call });
          } catch (_) {
            // NOTE: emit as content if unparseable
            events.push({ type: 'content_delta', delta: TOOL_OPEN + rawCall + TOOL_CLOSE });
          }
          buffer = buffer.substring(closeIdx + TOOL_CLOSE.length);
          state = 'idle';
          changed = true;
        }
        // If no close marker, just keep buffering (don't emit partial tool calls)
      }
    }
  }

  function flushBuffer(events) {
    if (buffer.length === 0) return;

    if (state === 'thought') {
      // Unclosed thought block — emit remainder as thought
      events.push({ type: 'thought_delta', delta: buffer });
    } else if (state === 'toolcall') {
      // Unclosed tool call — try to parse what we have, or emit as content
      try {
        const call = parseToolCall(buffer);
        events.push({ type: 'tool_call', call });
      } catch (_) {
        events.push({ type: 'content_delta', delta: buffer });
      }
    } else {
      // idle — emit as content
      events.push({ type: 'content_delta', delta: buffer });
    }

    buffer = '';
    state = 'idle';
  }

  return { push, end };
}
