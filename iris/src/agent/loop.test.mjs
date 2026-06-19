/**
 * loop.test.mjs — Pure-Node tests for agent/loop.js + agent/trace.js.
 *
 * Uses the REAL protocol (protocol/gemma.js) for integration coverage.
 * Fake engine and fake registry simulate the worker and tool execution.
 *
 * Run: node src/agent/loop.test.mjs
 */

import { runAgent } from './loop.js';
import { TraceBus } from './trace.js';
import {
  buildMessagesForPrompt,
  createStreamParser,
  splitFinal,
} from '../protocol/gemma.js';

// ---------- Helpers ----------

const protocol = { buildMessagesForPrompt, createStreamParser, splitFinal };

function makeTrace() {
  const events = [];
  const bus = new TraceBus();
  bus.addEventListener('trace', (e) => events.push(e.detail));
  return { bus, events };
}

/**
 * Create a fake engine.
 * `responses` is an array of { outputText, stats, chunks? } for successive
 * generate() calls.  chunks is an optional array of text strings to feed via onToken.
 */
function fakeEngine(responses) {
  let callIndex = 0;
  const calls = [];
  return {
    calls,
    applyChatTemplate: async ({ messages, tools, thinking }) => {
      // Return dummy input_ids (just need a length) and a rendered string
      return {
        input_ids: new Array(messages.length * 10), // fake token array
        rendered: messages.map((m) => `[${m.role}] ${m.content || ''}`).join('\n'),
      };
    },
    generate: async ({ input_ids, genConfig, onToken }) => {
      const idx = callIndex++;
      if (idx >= responses.length) {
        throw new Error(`Unexpected generate call #${idx + 1}`);
      }
      const resp = responses[idx];
      calls.push({ input_ids, genConfig });

      // Simulate streaming by calling onToken with chunks
      const chunks = resp.chunks || [resp.outputText];
      for (const chunk of chunks) {
        onToken({ text: chunk });
      }

      return {
        outputText: resp.outputText,
        stats: resp.stats || { tokens: 20, ms: 100, tokensPerSec: 200 },
      };
    },
    cancel: () => {},
  };
}

/**
 * Create a fake registry.
 * `handlers` is a map of name -> (args, ctx) => value.
 */
function fakeRegistry(handlers = {}) {
  const invocations = [];
  return {
    invocations,
    list: () =>
      Object.keys(handlers).map((name) => ({
        name,
        description: `Fake ${name}`,
        parameters: {},
      })),
    invoke: async (name, args, ctx) => {
      invocations.push({ name, args, ctx });
      const start = Date.now();
      if (handlers[name]) {
        try {
          const value = await handlers[name](args, ctx);
          return {
            tool_call_id: ctx.tool_call_id || 'unknown',
            name,
            ok: true,
            value,
            ms: Date.now() - start,
          };
        } catch (err) {
          return {
            tool_call_id: ctx.tool_call_id || 'unknown',
            name,
            ok: false,
            value: null,
            error: err.message,
            ms: Date.now() - start,
          };
        }
      }
      return {
        tool_call_id: ctx.tool_call_id || 'unknown',
        name,
        ok: false,
        value: null,
        error: `Unknown tool: ${name}`,
        ms: 0,
      };
    },
  };
}

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    passed++;
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    console.error(`  FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  } else {
    passed++;
  }
}

// ---------- Test 1: Single turn, no tools ----------
async function testSingleTurnNoTools() {
  console.log('Test 1: Single turn, no tools');

  const { bus, events } = makeTrace();
  const engine = fakeEngine([
    {
      outputText: 'Hello! I can help you with that.',
      chunks: ['Hello! ', 'I can help ', 'you with that.'],
      stats: { tokens: 12, ms: 60, tokensPerSec: 200 },
    },
  ]);
  const registry = fakeRegistry({});

  const result = await runAgent({
    engine,
    protocol,
    registry,
    messages: [{ role: 'user', content: 'Hi there' }],
    genConfig: { temperature: 0.7, top_p: 0.9, max_new_tokens: 256, do_sample: true },
    thinking: false,
    maxSteps: 6,
    trace: bus,
  });

  assertEqual(result.finalText, 'Hello! I can help you with that.', 'finalText correct');
  assertEqual(engine.calls.length, 1, 'generate called once');

  // Check messages: should have user + assistant
  assertEqual(result.messages.length, 2, 'two messages total');
  assertEqual(result.messages[0].role, 'user', 'first message is user');
  assertEqual(result.messages[1].role, 'assistant', 'second message is assistant');
  assertEqual(result.messages[1].content, 'Hello! I can help you with that.', 'assistant content correct');

  // Check trace events
  const types = events.map((e) => e.type);
  assert(types.includes('prompt_built'), 'prompt_built emitted');
  assert(types.includes('step_done'), 'step_done emitted');
  assert(types.includes('turn_done'), 'turn_done emitted');
  assert(types.filter((t) => t === 'content_delta').length > 0, 'content_delta events emitted');

  // Verify step_done has correct stats
  const stepDone = events.find((e) => e.type === 'step_done');
  assertEqual(stepDone.tokens, 12, 'step_done tokens');
  assertEqual(stepDone.ms, 60, 'step_done ms');
  assertEqual(stepDone.tokensPerSec, 200, 'step_done tokensPerSec');

  console.log('  done.\n');
}

// ---------- Test 2: One tool call then final answer ----------
async function testOneToolCallThenFinal() {
  console.log('Test 2: One tool call then final answer');

  const { bus, events } = makeTrace();

  // First response: a tool call in Gemma format
  const toolCallOutput = '<|tool_call>call:calculator{"expression":"2+2"}<tool_call|>';
  // Second response: a plain final answer
  const finalOutput = 'The result of 2+2 is 4.';

  const engine = fakeEngine([
    {
      outputText: toolCallOutput,
      chunks: ['<|tool_call>', 'call:calculator{"expression":"2+2"}', '<tool_call|>'],
      stats: { tokens: 15, ms: 75, tokensPerSec: 200 },
    },
    {
      outputText: finalOutput,
      chunks: ['The result ', 'of 2+2 is 4.'],
      stats: { tokens: 10, ms: 50, tokensPerSec: 200 },
    },
  ]);

  const registry = fakeRegistry({
    calculator: (args) => {
      return 4;
    },
  });

  const result = await runAgent({
    engine,
    protocol,
    registry,
    messages: [{ role: 'user', content: 'What is 2+2?' }],
    genConfig: { temperature: 0.7, top_p: 0.9, max_new_tokens: 256, do_sample: true },
    thinking: false,
    maxSteps: 6,
    trace: bus,
  });

  // generate called twice (tool call + final)
  assertEqual(engine.calls.length, 2, 'generate called twice');

  // registry.invoke called once
  assertEqual(registry.invocations.length, 1, 'registry.invoke called once');
  assertEqual(registry.invocations[0].name, 'calculator', 'invoked tool is calculator');

  // Final text is the plain answer
  assertEqual(result.finalText, 'The result of 2+2 is 4.', 'finalText correct');

  // Check messages structure:
  // user, assistant (with tool_calls), tool, assistant (final)
  assertEqual(result.messages.length, 4, 'four messages total');
  assertEqual(result.messages[0].role, 'user', 'msg 0 is user');
  assertEqual(result.messages[1].role, 'assistant', 'msg 1 is assistant');
  assert(
    result.messages[1].tool_calls && result.messages[1].tool_calls.length === 1,
    'msg 1 has one tool_call'
  );
  assertEqual(result.messages[2].role, 'tool', 'msg 2 is tool');
  assertEqual(result.messages[2].name, 'calculator', 'tool msg name is calculator');
  assertEqual(result.messages[2].content, '4', 'tool msg content is the result value');
  assertEqual(result.messages[3].role, 'assistant', 'msg 3 is final assistant');

  // Check trace events for tool_call and tool_result
  const types = events.map((e) => e.type);
  assert(types.includes('tool_call'), 'tool_call trace event emitted');
  assert(types.includes('tool_result'), 'tool_result trace event emitted');
  assert(types.includes('turn_done'), 'turn_done emitted');

  // Verify tool_result has correct value
  const toolResult = events.find((e) => e.type === 'tool_result');
  assert(toolResult.result.ok === true, 'tool_result ok is true');
  assertEqual(toolResult.result.value, 4, 'tool_result value is 4');

  // Two step_done events (one per generate call)
  assertEqual(
    types.filter((t) => t === 'step_done').length,
    2,
    'two step_done events'
  );

  // Two prompt_built events
  assertEqual(
    types.filter((t) => t === 'prompt_built').length,
    2,
    'two prompt_built events'
  );

  console.log('  done.\n');
}

// ---------- Test 3: maxSteps guard ----------
async function testMaxStepsGuard() {
  console.log('Test 3: maxSteps guard (engine always returns tool call)');

  const { bus, events } = makeTrace();
  const maxSteps = 3;

  // Every response is a tool call — should stop after maxSteps
  const toolCallOutput = '<|tool_call>call:calculator{"expression":"1+1"}<tool_call|>';
  const responses = [];
  for (let i = 0; i < maxSteps + 2; i++) {
    responses.push({
      outputText: toolCallOutput,
      chunks: [toolCallOutput],
      stats: { tokens: 10, ms: 50, tokensPerSec: 200 },
    });
  }

  const engine = fakeEngine(responses);
  const registry = fakeRegistry({
    calculator: () => 2,
  });

  const result = await runAgent({
    engine,
    protocol,
    registry,
    messages: [{ role: 'user', content: 'Loop forever please' }],
    genConfig: { temperature: 0.7, top_p: 0.9, max_new_tokens: 256, do_sample: true },
    thinking: false,
    maxSteps,
    trace: bus,
  });

  // generate called exactly maxSteps times (not more)
  assertEqual(engine.calls.length, maxSteps, `generate called exactly ${maxSteps} times`);

  // Registry invoked maxSteps times (one tool call per step)
  assertEqual(registry.invocations.length, maxSteps, `registry invoked ${maxSteps} times`);

  // No infinite loop — we returned
  assert(result.messages.length > 0, 'messages array is non-empty');

  // turn_done should be emitted at the end
  const types = events.map((e) => e.type);
  assert(types.includes('turn_done'), 'turn_done emitted even when maxSteps exhausted');

  console.log('  done.\n');
}

// ---------- Test 4: Abort signal ----------
async function testAbortSignal() {
  console.log('Test 4: Abort signal stops the loop');

  const { bus, events } = makeTrace();
  const ac = new AbortController();

  // Abort immediately before the loop starts
  ac.abort();

  const engine = fakeEngine([
    {
      outputText: 'Should not get here',
      stats: { tokens: 5, ms: 25, tokensPerSec: 200 },
    },
  ]);
  const registry = fakeRegistry({});

  const result = await runAgent({
    engine,
    protocol,
    registry,
    messages: [{ role: 'user', content: 'Hello' }],
    genConfig: { temperature: 0.7, top_p: 0.9, max_new_tokens: 256, do_sample: true },
    thinking: false,
    maxSteps: 6,
    trace: bus,
    signal: ac.signal,
  });

  // Should not have called generate at all
  assertEqual(engine.calls.length, 0, 'generate not called when pre-aborted');
  // Should return the original messages
  assertEqual(result.messages.length, 1, 'only the original user message');

  console.log('  done.\n');
}

// ---------- Test 5: Error handling ----------
async function testErrorHandling() {
  console.log('Test 5: Error emits trace event and rethrows');

  const { bus, events } = makeTrace();

  const engine = {
    applyChatTemplate: async () => {
      throw new Error('Engine exploded');
    },
    cancel: () => {},
  };
  const registry = fakeRegistry({});

  let caught = false;
  try {
    await runAgent({
      engine,
      protocol,
      registry,
      messages: [{ role: 'user', content: 'Hi' }],
      genConfig: { temperature: 0.7, top_p: 0.9, max_new_tokens: 256, do_sample: true },
      thinking: false,
      maxSteps: 6,
      trace: bus,
    });
  } catch (err) {
    caught = true;
    assertEqual(err.message, 'Engine exploded', 'correct error message');
  }

  assert(caught, 'error was rethrown');

  // Check that an error trace event was emitted
  const errorEvent = events.find((e) => e.type === 'error');
  assert(errorEvent !== undefined, 'error trace event emitted');
  assertEqual(errorEvent?.message, 'Engine exploded', 'error trace event has correct message');

  console.log('  done.\n');
}

// ---------- Test 6: Thinking channel ----------
async function testThinkingChannel() {
  console.log('Test 6: Thinking channel in output');

  const { bus, events } = makeTrace();

  const outputWithThoughts =
    '<|channel>thought\nLet me think about this.\n<channel|>The answer is 42.';

  const engine = fakeEngine([
    {
      outputText: outputWithThoughts,
      chunks: ['<|channel>thought\n', 'Let me think', ' about this.\n', '<channel|>', 'The answer is 42.'],
      stats: { tokens: 20, ms: 100, tokensPerSec: 200 },
    },
  ]);
  const registry = fakeRegistry({});

  const result = await runAgent({
    engine,
    protocol,
    registry,
    messages: [{ role: 'user', content: 'What is the meaning of life?' }],
    genConfig: { temperature: 0.7, top_p: 0.9, max_new_tokens: 256, do_sample: true },
    thinking: true,
    maxSteps: 6,
    trace: bus,
  });

  assertEqual(result.finalText, 'The answer is 42.', 'finalText excludes thoughts');

  // Check that thought_delta events were emitted
  const thoughtDeltas = events.filter((e) => e.type === 'thought_delta');
  assert(thoughtDeltas.length > 0, 'thought_delta events emitted');

  // Check assistant message has thoughts
  const assistantMsg = result.messages.find((m) => m.role === 'assistant');
  assertEqual(assistantMsg.thoughts, 'Let me think about this.\n', 'assistant has thoughts');
  assertEqual(assistantMsg.content, 'The answer is 42.', 'assistant content is clean');

  console.log('  done.\n');
}

// ---------- Test 7: Input messages not mutated ----------
async function testInputNotMutated() {
  console.log('Test 7: Input messages array is not mutated');

  const { bus } = makeTrace();
  const engine = fakeEngine([
    {
      outputText: 'Reply.',
      stats: { tokens: 2, ms: 10, tokensPerSec: 200 },
    },
  ]);
  const registry = fakeRegistry({});

  const original = [{ role: 'user', content: 'Hi' }];
  const originalLength = original.length;

  await runAgent({
    engine,
    protocol,
    registry,
    messages: original,
    genConfig: { temperature: 0.7, top_p: 0.9, max_new_tokens: 256, do_sample: true },
    thinking: false,
    maxSteps: 6,
    trace: bus,
  });

  assertEqual(original.length, originalLength, 'original messages array not mutated');

  console.log('  done.\n');
}

// ---------- Run all tests ----------
async function main() {
  console.log('=== agent/loop.test.mjs ===\n');

  await testSingleTurnNoTools();
  await testOneToolCallThenFinal();
  await testMaxStepsGuard();
  await testAbortSignal();
  await testErrorHandling();
  await testThinkingChannel();
  await testInputNotMutated();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('PASS');
  }
}

main().catch((err) => {
  console.error('Unhandled test error:', err);
  process.exit(1);
});
