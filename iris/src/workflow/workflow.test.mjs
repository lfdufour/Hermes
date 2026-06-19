/**
 * workflow.test.mjs — Pure-Node tests for workflow/schema.js + workflow/runner.js.
 *
 * Zero external dependencies. Run: node src/workflow/workflow.test.mjs
 * Prints PASS/FAIL and exits non-zero on failure.
 */

import { validate, DEFAULT_CHAT_WORKFLOW } from './schema.js';
import { runWorkflow } from './runner.js';

// ---------- Test harness ----------

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

// ---------- Fakes (mirrors loop.test.mjs patterns) ----------

/**
 * Minimal TraceBus fake — just collects events.
 */
function makeTrace() {
  const events = [];
  return {
    events,
    emit(ev) { events.push(ev); },
    addEventListener() {},
  };
}

/**
 * Fake protocol implementing the gemma.js interface.
 */
const fakeProtocol = {
  buildMessagesForPrompt(messages) { return messages; },
  toolSpecsToTemplate(tools) { return tools || []; },
  createStreamParser() {
    return {
      push() { return []; },
      end() { return []; },
    };
  },
  splitFinal(outputText) {
    return { thoughts: '', content: outputText, tool_calls: [] };
  },
};

/**
 * Fake engine that returns canned responses.
 * @param {string[]} answers - successive answers for generate() calls
 */
function fakeEngine(answers) {
  let idx = 0;
  return {
    applyChatTemplate: async ({ messages }) => ({
      input_ids: new Array(messages.length * 5),
      rendered: messages.map(m => `[${m.role}] ${m.content || ''}`).join('\n'),
    }),
    generate: async ({ input_ids, genConfig, onToken }) => {
      const text = answers[idx++] || '';
      if (onToken) onToken({ text });
      return {
        outputText: text,
        stats: { tokens: 10, ms: 50, tokensPerSec: 200 },
      };
    },
    cancel: () => {},
  };
}

/**
 * Fake registry.
 * @param {Object<string, function>} handlers - name -> (args) => value
 */
function fakeRegistry(handlers = {}) {
  const invocations = [];
  return {
    invocations,
    list: () => Object.keys(handlers).map(name => ({
      name, description: `Fake ${name}`, parameters: {},
    })),
    has: (name) => name in handlers,
    invoke: async (name, args, ctx) => {
      invocations.push({ name, args });
      const start = Date.now();
      if (handlers[name]) {
        try {
          const value = await handlers[name](args);
          return { tool_call_id: 'tc_test', name, ok: true, value, ms: Date.now() - start };
        } catch (err) {
          return { tool_call_id: 'tc_test', name, ok: false, value: null, error: err.message, ms: 0 };
        }
      }
      return { tool_call_id: 'tc_test', name, ok: false, value: null, error: `Unknown: ${name}`, ms: 0 };
    },
  };
}

// ====================================================================
//  VALIDATE TESTS
// ====================================================================

function testValidateDefaultWorkflow() {
  console.log('Test 1: validate() — DEFAULT_CHAT_WORKFLOW is valid');
  const result = validate(DEFAULT_CHAT_WORKFLOW);
  assert(result.ok === true, 'ok is true');
  assertEqual(result.errors.length, 0, 'no errors');
  console.log('  done.\n');
}

function testValidateNotAnArray() {
  console.log('Test 2: validate() — non-array input');
  const result = validate('not an array');
  assert(result.ok === false, 'ok is false');
  assert(result.errors.length > 0, 'has errors');
  assert(result.errors[0].includes('array'), 'error mentions array');
  console.log('  done.\n');
}

function testValidateEmptyArray() {
  console.log('Test 3: validate() — empty array');
  const result = validate([]);
  assert(result.ok === false, 'ok is false');
  assert(result.errors.some(e => e.includes('at least one')), 'error mentions at least one node');
  console.log('  done.\n');
}

function testValidateBadNodeType() {
  console.log('Test 4: validate() — invalid node type');
  const result = validate([{ type: 'banana' }]);
  assert(result.ok === false, 'ok is false');
  assert(result.errors.some(e => e.includes('banana')), 'error mentions the bad type');
  console.log('  done.\n');
}

function testValidateMissingInputAs() {
  console.log('Test 5: validate() — input node missing "as"');
  const result = validate([{ type: 'input' }]);
  assert(result.ok === false, 'ok is false');
  assert(result.errors.some(e => e.includes('as')), 'error mentions "as"');
  console.log('  done.\n');
}

function testValidateLlmMissingOut() {
  console.log('Test 6: validate() — llm node missing "out"');
  const result = validate([
    { type: 'input', as: 'x' },
    { type: 'llm', in: 'x' },
  ]);
  assert(result.ok === false, 'ok is false');
  assert(result.errors.some(e => e.includes('out')), 'error mentions "out"');
  console.log('  done.\n');
}

function testValidateUndefinedVariable() {
  console.log('Test 7: validate() — llm references undefined variable');
  const result = validate([
    { type: 'llm', in: 'nonexistent', out: 'y' },
  ]);
  assert(result.ok === false, 'ok is false');
  assert(result.errors.some(e => e.includes('nonexistent')), 'error mentions the undefined var');
  console.log('  done.\n');
}

function testValidateOutputUndefined() {
  console.log('Test 8: validate() — output references undefined variable');
  const result = validate([
    { type: 'output', from: 'nothing' },
  ]);
  assert(result.ok === false, 'ok is false');
  assert(result.errors.some(e => e.includes('nothing')), 'error mentions the undefined var');
  console.log('  done.\n');
}

function testValidateConditionMissingFields() {
  console.log('Test 9: validate() — condition missing required fields');
  const result = validate([
    { type: 'input', as: 'x' },
    { type: 'condition', var: 'x' },
  ]);
  assert(result.ok === false, 'ok is false');
  assert(result.errors.some(e => e.includes('op')), 'error mentions "op"');
  assert(result.errors.some(e => e.includes('then')), 'error mentions "then"');
  console.log('  done.\n');
}

function testValidateLoopMissingFields() {
  console.log('Test 10: validate() — loop missing times/whileVar and body');
  const result = validate([
    { type: 'loop' },
  ]);
  assert(result.ok === false, 'ok is false');
  assert(result.errors.some(e => e.includes('times') || e.includes('whileVar')), 'error mentions times or whileVar');
  assert(result.errors.some(e => e.includes('body')), 'error mentions "body"');
  console.log('  done.\n');
}

function testValidateToolNode() {
  console.log('Test 11: validate() — tool node valid and invalid');
  // Valid
  const ok = validate([
    { type: 'tool', name: 'calculator', args: { expression: '2+2' }, out: 'result' },
  ]);
  assert(ok.ok === true, 'valid tool node passes');

  // Missing name
  const bad = validate([
    { type: 'tool', out: 'result' },
  ]);
  assert(bad.ok === false, 'tool without name fails');
  assert(bad.errors.some(e => e.includes('name')), 'error mentions "name"');
  console.log('  done.\n');
}

// ====================================================================
//  RUNNER TESTS
// ====================================================================

async function testRunnerInputOutput() {
  console.log('Test 12: runWorkflow() — trivial input -> output');
  const trace = makeTrace();
  const ctx = await runWorkflow(
    [
      { type: 'input', as: 'x' },
      { type: 'output', from: 'x' },
    ],
    {
      engine: fakeEngine([]),
      protocol: fakeProtocol,
      registry: fakeRegistry(),
      trace,
      context: { x: 'hello world' },
    }
  );
  assertEqual(ctx.__output, 'hello world', '__output equals seeded x');
  console.log('  done.\n');
}

async function testRunnerInputMissing() {
  console.log('Test 13: runWorkflow() — input node with missing context throws');
  const trace = makeTrace();
  let threw = false;
  try {
    await runWorkflow(
      [{ type: 'input', as: 'missing' }],
      {
        engine: fakeEngine([]),
        protocol: fakeProtocol,
        registry: fakeRegistry(),
        trace,
        context: {},
      }
    );
  } catch (e) {
    threw = true;
    assert(e.message.includes('missing'), 'error mentions the missing var');
  }
  assert(threw, 'threw for missing input');
  console.log('  done.\n');
}

async function testRunnerLlmAgentLoop() {
  console.log('Test 14: runWorkflow() — llm node with agentLoop (stubbed engine)');
  const trace = makeTrace();
  const engine = fakeEngine(['The capital of France is Paris.']);

  const ctx = await runWorkflow(
    [
      { type: 'input', as: 'question' },
      { type: 'llm', in: 'question', out: 'answer', agentLoop: true, tools: '*' },
      { type: 'output', from: 'answer' },
    ],
    {
      engine,
      protocol: fakeProtocol,
      registry: fakeRegistry(),
      trace,
      context: { question: 'What is the capital of France?' },
    }
  );
  assertEqual(ctx.answer, 'The capital of France is Paris.', 'answer stored in context');
  assertEqual(ctx.__output, 'The capital of France is Paris.', '__output set correctly');
  console.log('  done.\n');
}

async function testRunnerLlmSingleShot() {
  console.log('Test 15: runWorkflow() — llm node without agentLoop (single shot)');
  const trace = makeTrace();
  const engine = fakeEngine(['Single-shot reply.']);

  const ctx = await runWorkflow(
    [
      { type: 'input', as: 'msg' },
      { type: 'llm', in: 'msg', out: 'reply', agentLoop: false },
      { type: 'output', from: 'reply' },
    ],
    {
      engine,
      protocol: fakeProtocol,
      registry: fakeRegistry(),
      trace,
      context: { msg: 'Hello' },
    }
  );
  assertEqual(ctx.reply, 'Single-shot reply.', 'reply stored in context');
  assertEqual(ctx.__output, 'Single-shot reply.', '__output set correctly');
  console.log('  done.\n');
}

async function testRunnerToolNode() {
  console.log('Test 16: runWorkflow() — tool node invokes registry');
  const trace = makeTrace();
  const registry = fakeRegistry({
    calculator: (args) => eval(args.expression), // safe for test: we control the input
  });

  const ctx = await runWorkflow(
    [
      { type: 'tool', name: 'calculator', args: { expression: '3*7' }, out: 'calcResult' },
      { type: 'output', from: 'calcResult' },
    ],
    {
      engine: fakeEngine([]),
      protocol: fakeProtocol,
      registry,
      trace,
      context: {},
    }
  );
  assertEqual(ctx.calcResult, 21, 'calcResult is 21');
  assertEqual(ctx.__output, 21, '__output is 21');
  assertEqual(registry.invocations.length, 1, 'registry invoked once');
  assertEqual(registry.invocations[0].name, 'calculator', 'invoked calculator');
  console.log('  done.\n');
}

async function testRunnerToolNodeWithContextArgs() {
  console.log('Test 17: runWorkflow() — tool node resolves $-prefixed args from context');
  const trace = makeTrace();
  const registry = fakeRegistry({
    echo: (args) => args.text,
  });

  const ctx = await runWorkflow(
    [
      { type: 'input', as: 'greeting' },
      { type: 'tool', name: 'echo', args: { text: '$greeting' }, out: 'echoed' },
      { type: 'output', from: 'echoed' },
    ],
    {
      engine: fakeEngine([]),
      protocol: fakeProtocol,
      registry,
      trace,
      context: { greeting: 'hello from context' },
    }
  );
  assertEqual(ctx.echoed, 'hello from context', 'echoed value resolved from context');
  console.log('  done.\n');
}

async function testRunnerConditionThen() {
  console.log('Test 18: runWorkflow() — condition node takes "then" branch');
  const trace = makeTrace();
  const registry = fakeRegistry({
    setFlag: () => 'branch-then',
  });

  const ctx = await runWorkflow(
    [
      { type: 'input', as: 'val' },
      {
        type: 'condition',
        var: 'val',
        op: '==',
        value: 'yes',
        then: [{ type: 'tool', name: 'setFlag', args: {}, out: 'flag' }],
        else: [{ type: 'tool', name: 'setFlag', args: {}, out: 'wrongFlag' }],
      },
      { type: 'output', from: 'flag' },
    ],
    {
      engine: fakeEngine([]),
      protocol: fakeProtocol,
      registry,
      trace,
      context: { val: 'yes' },
    }
  );
  assertEqual(ctx.flag, 'branch-then', 'then branch executed');
  assertEqual(ctx.wrongFlag, undefined, 'else branch NOT executed');
  console.log('  done.\n');
}

async function testRunnerConditionElse() {
  console.log('Test 19: runWorkflow() — condition node takes "else" branch');
  const trace = makeTrace();
  const registry = fakeRegistry({
    setFlag: () => 'branch-else',
  });

  const ctx = await runWorkflow(
    [
      { type: 'input', as: 'val' },
      {
        type: 'condition',
        var: 'val',
        op: '==',
        value: 'yes',
        then: [{ type: 'tool', name: 'setFlag', args: {}, out: 'wrongFlag' }],
        else: [{ type: 'tool', name: 'setFlag', args: {}, out: 'flag' }],
      },
      { type: 'output', from: 'flag' },
    ],
    {
      engine: fakeEngine([]),
      protocol: fakeProtocol,
      registry,
      trace,
      context: { val: 'no' },
    }
  );
  assertEqual(ctx.flag, 'branch-else', 'else branch executed');
  assertEqual(ctx.wrongFlag, undefined, 'then branch NOT executed');
  console.log('  done.\n');
}

async function testRunnerConditionTruthy() {
  console.log('Test 20: runWorkflow() — condition with "truthy" op');
  const trace = makeTrace();
  const registry = fakeRegistry({
    mark: () => 'truthy-hit',
  });

  const ctx = await runWorkflow(
    [
      { type: 'input', as: 'flag' },
      {
        type: 'condition',
        var: 'flag',
        op: 'truthy',
        then: [{ type: 'tool', name: 'mark', args: {}, out: 'result' }],
      },
    ],
    {
      engine: fakeEngine([]),
      protocol: fakeProtocol,
      registry,
      trace,
      context: { flag: 'anything-truthy' },
    }
  );
  assertEqual(ctx.result, 'truthy-hit', 'truthy branch ran');
  console.log('  done.\n');
}

async function testRunnerLoopTimes() {
  console.log('Test 21: runWorkflow() — loop node runs body N times');
  const trace = makeTrace();
  let counter = 0;
  const registry = fakeRegistry({
    increment: () => ++counter,
  });

  const ctx = await runWorkflow(
    [
      {
        type: 'loop',
        times: 5,
        body: [{ type: 'tool', name: 'increment', args: {}, out: 'last' }],
      },
    ],
    {
      engine: fakeEngine([]),
      protocol: fakeProtocol,
      registry,
      trace,
      context: {},
    }
  );
  assertEqual(counter, 5, 'body executed 5 times');
  assertEqual(registry.invocations.length, 5, 'registry invoked 5 times');
  assertEqual(ctx.last, 5, 'last iteration result stored');
  console.log('  done.\n');
}

async function testRunnerLoopCap() {
  console.log('Test 22: runWorkflow() — loop node caps at MAX_LOOP_ITERATIONS (25)');
  const trace = makeTrace();
  let counter = 0;
  const registry = fakeRegistry({
    count: () => ++counter,
  });

  await runWorkflow(
    [
      {
        type: 'loop',
        times: 100, // exceeds cap
        body: [{ type: 'tool', name: 'count', args: {}, out: 'c' }],
      },
    ],
    {
      engine: fakeEngine([]),
      protocol: fakeProtocol,
      registry,
      trace,
      context: {},
    }
  );
  assertEqual(counter, 25, 'body capped at 25 iterations');
  console.log('  done.\n');
}

async function testRunnerLoopWhileVar() {
  console.log('Test 23: runWorkflow() — loop with whileVar stops when falsy');
  const trace = makeTrace();
  let counter = 0;
  const registry = fakeRegistry({
    tick: (args) => {
      counter++;
      // Return value isn't used for the whileVar check directly;
      // we'll manipulate context in a creative way by having the
      // tool clear the whileVar after 3 calls.
      return counter;
    },
  });

  // We'll pre-seed keepGoing=true and have the loop body set it to false
  // after 3 iterations by using a condition node inside the body.
  // But for simplicity, let's just test that whileVar=false stops immediately.
  const ctx = await runWorkflow(
    [
      {
        type: 'loop',
        whileVar: 'shouldContinue',
        body: [{ type: 'tool', name: 'tick', args: {}, out: 'tickResult' }],
      },
    ],
    {
      engine: fakeEngine([]),
      protocol: fakeProtocol,
      registry,
      trace,
      context: { shouldContinue: false },
    }
  );
  assertEqual(counter, 0, 'body not executed when whileVar is falsy');

  // Now test with truthy whileVar — it will run up to 25 times (capped)
  counter = 0;
  const registry2 = fakeRegistry({
    tick: () => ++counter,
  });

  await runWorkflow(
    [
      {
        type: 'loop',
        whileVar: 'go',
        body: [{ type: 'tool', name: 'tick', args: {}, out: 'r' }],
      },
    ],
    {
      engine: fakeEngine([]),
      protocol: fakeProtocol,
      registry: registry2,
      trace,
      context: { go: true },
    }
  );
  assertEqual(counter, 25, 'whileVar=true runs up to cap');
  console.log('  done.\n');
}

async function testRunnerFullChatWorkflow() {
  console.log('Test 24: runWorkflow() — DEFAULT_CHAT_WORKFLOW with stubbed services');
  const trace = makeTrace();
  const engine = fakeEngine(['I am a helpful assistant.']);

  const ctx = await runWorkflow(
    DEFAULT_CHAT_WORKFLOW,
    {
      engine,
      protocol: fakeProtocol,
      registry: fakeRegistry(),
      trace,
      context: { userMessage: 'Who are you?' },
    }
  );
  assertEqual(ctx.answer, 'I am a helpful assistant.', 'answer in context');
  assertEqual(ctx.__output, 'I am a helpful assistant.', '__output set');
  console.log('  done.\n');
}

// ====================================================================
//  Run all tests
// ====================================================================

async function main() {
  console.log('=== workflow/workflow.test.mjs ===\n');

  // Validate tests
  testValidateDefaultWorkflow();
  testValidateNotAnArray();
  testValidateEmptyArray();
  testValidateBadNodeType();
  testValidateMissingInputAs();
  testValidateLlmMissingOut();
  testValidateUndefinedVariable();
  testValidateOutputUndefined();
  testValidateConditionMissingFields();
  testValidateLoopMissingFields();
  testValidateToolNode();

  // Runner tests
  await testRunnerInputOutput();
  await testRunnerInputMissing();
  await testRunnerLlmAgentLoop();
  await testRunnerLlmSingleShot();
  await testRunnerToolNode();
  await testRunnerToolNodeWithContextArgs();
  await testRunnerConditionThen();
  await testRunnerConditionElse();
  await testRunnerConditionTruthy();
  await testRunnerLoopTimes();
  await testRunnerLoopCap();
  await testRunnerLoopWhileVar();
  await testRunnerFullChatWorkflow();

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
