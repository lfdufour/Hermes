/**
 * loop.js — Tool-using agent generation loop for Iris.
 *
 * Orchestrates: prompt shaping -> tokenization -> generation (with streaming
 * trace events) -> output parsing -> tool invocation -> repeat until done or
 * maxSteps exceeded.
 *
 * Exports: runAgent
 */

/**
 * Run the agent loop.
 *
 * @param {object} opts
 * @param {EngineClient} opts.engine      — RPC client wrapping the model worker
 * @param {object}       opts.protocol    — gemma.js: buildMessagesForPrompt, createStreamParser, splitFinal
 * @param {ToolRegistry} opts.registry    — tool registry with list() and invoke()
 * @param {Message[]}    opts.messages    — conversation so far (will NOT be mutated; a copy is returned)
 * @param {GenConfig}    opts.genConfig   — generation parameters
 * @param {boolean}      opts.thinking    — whether to enable thinking channel
 * @param {number}       [opts.maxSteps=6] — hard cap on generation rounds (prevents infinite loops)
 * @param {TraceBus}     opts.trace       — trace event bus
 * @param {AbortSignal}  [opts.signal]    — optional abort signal
 * @returns {Promise<{messages: Message[], finalText: string}>}
 *
 * Error handling: errors are emitted as {type:'error', message} on the trace bus
 * and then rethrown so the caller can handle them (e.g. show an error in the UI).
 * Abort (via signal) is treated as a graceful stop: we return whatever state we
 * have accumulated so far with finalText set to the last content or empty string.
 */
export async function runAgent({
  engine,
  protocol,
  registry,
  messages: inputMessages,
  genConfig,
  thinking = false,
  maxSteps = 6,
  trace,
  signal,
}) {
  // Work on a shallow copy so we never mutate the caller's array
  const messages = [...inputMessages];
  let finalText = '';

  try {
    for (let step = 0; step < maxSteps; step++) {
      // --- Check abort before each step ---
      if (signal?.aborted) {
        engine.cancel?.();
        return { messages, finalText };
      }

      // (a) Shape messages and gather tool specs (wrapped for the template)
      const shaped = protocol.buildMessagesForPrompt(messages, { thinking });
      const toolSpecs = protocol.toolSpecsToTemplate(registry.list());

      // (b) Apply chat template (tokenize)
      const { input_ids, rendered } = await engine.applyChatTemplate({
        messages: shaped,
        tools: toolSpecs,
        thinking,
      });

      trace.emit({
        type: 'prompt_built',
        text: rendered,
        tokenCount: input_ids.length,
      });

      // --- Check abort after template ---
      if (signal?.aborted) {
        engine.cancel?.();
        return { messages, finalText };
      }

      // (c) Generate with streaming parser
      const parser = protocol.createStreamParser();

      // Set up abort listener for mid-generation cancellation
      let abortHandler;
      if (signal) {
        abortHandler = () => engine.cancel?.();
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      let generateResult;
      try {
        generateResult = await engine.generate({
          input_ids,
          genConfig,
          onToken: ({ text }) => {
            for (const ev of parser.push(text)) {
              trace.emit(ev);
            }
          },
        });
      } finally {
        // Clean up abort listener
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
      }

      const { outputText, stats } = generateResult;

      // Flush parser
      for (const ev of parser.end()) {
        trace.emit(ev);
      }

      trace.emit({
        type: 'step_done',
        tokens: stats.tokens,
        ms: stats.ms,
        tokensPerSec: stats.tokensPerSec,
      });

      // --- Check abort after generation ---
      if (signal?.aborted) {
        engine.cancel?.();
        return { messages, finalText };
      }

      // (d) Parse the full output
      const { thoughts, content, tool_calls } = protocol.splitFinal(outputText);

      // (e) If there are tool calls, execute them and continue the loop
      if (tool_calls.length > 0) {
        // Push assistant message with tool calls
        messages.push({
          role: 'assistant',
          content,
          thoughts,
          tool_calls,
        });

        // Execute each tool call sequentially
        for (const call of tool_calls) {
          trace.emit({ type: 'tool_call', call });

          const result = await registry.invoke(call.name, call.args, {
            tool_call_id: call.id,
          });

          trace.emit({ type: 'tool_result', result });

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: JSON.stringify(result.value ?? result.error),
          });
        }

        // Continue to next iteration
        continue;
      }

      // (f) No tool calls — this is the final answer
      messages.push({
        role: 'assistant',
        content,
        thoughts,
      });

      trace.emit({ type: 'turn_done' });
      finalText = content;
      return { messages, finalText };
    }

    // If we exhausted maxSteps without a final answer, return current state.
    // NOTE: This is a graceful degradation — we emit turn_done and return
    // whatever content we have, rather than throwing.
    trace.emit({ type: 'turn_done' });
    return { messages, finalText };
  } catch (err) {
    // Emit error on trace bus, then rethrow for caller handling
    const message = err?.message || String(err);
    trace.emit({ type: 'error', message });
    throw err;
  }
}
