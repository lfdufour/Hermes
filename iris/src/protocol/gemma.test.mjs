/**
 * gemma.test.mjs — Node-runnable unit tests for protocol/gemma.js
 * Run: node gemma.test.mjs
 * Prints per-case PASS/FAIL and exits non-zero on any failure.
 */

import {
  buildMessagesForPrompt,
  toolSpecsToTemplate,
  createStreamParser,
  parseToolCall,
  splitFinal,
} from './gemma.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function assertEq(a, b, msg) {
  const aStr = JSON.stringify(a);
  const bStr = JSON.stringify(b);
  if (aStr !== bStr) {
    throw new Error(`${msg}\n  expected: ${bStr}\n  actual:   ${aStr}`);
  }
}

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${e.message}`);
    failed++;
  }
}

// ============================================================
// buildMessagesForPrompt
// ============================================================

test('buildMessagesForPrompt: drops thoughts from prior completed assistant turns', () => {
  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi', thoughts: 'thinking about hi' },
    { role: 'user', content: 'next' },
    { role: 'assistant', content: 'bye', thoughts: 'thinking about bye' },
  ];
  const result = buildMessagesForPrompt(messages, { thinking: true });
  // First assistant turn is a prior completed turn without tool_calls → thoughts dropped
  assert(!('thoughts' in result[1]), 'first assistant turn should have thoughts dropped');
  // Last assistant turn keeps thoughts
  assertEq(result[3].thoughts, 'thinking about bye', 'last assistant should keep thoughts');
});

test('buildMessagesForPrompt: keeps thoughts in prior turn with tool_calls', () => {
  const messages = [
    { role: 'user', content: 'calc' },
    { role: 'assistant', content: '', thoughts: 'let me call calc', tool_calls: [{ id: '1', name: 'calc', args: {} }] },
    { role: 'tool', content: '42', tool_call_id: '1' },
    { role: 'assistant', content: 'The answer is 42', thoughts: 'done thinking' },
  ];
  const result = buildMessagesForPrompt(messages, { thinking: true });
  // First assistant has tool_calls → keep thoughts even though it's a prior turn
  assertEq(result[1].thoughts, 'let me call calc', 'prior turn with tool_calls keeps thoughts');
  // Last assistant keeps thoughts
  assertEq(result[3].thoughts, 'done thinking', 'last assistant keeps thoughts');
});

test('buildMessagesForPrompt: handles messages with no assistant turns', () => {
  const messages = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'hi' },
  ];
  const result = buildMessagesForPrompt(messages, { thinking: false });
  assertEq(result.length, 2, 'should return same number of messages');
});

// ============================================================
// toolSpecsToTemplate
// ============================================================

test('toolSpecsToTemplate: wraps tool specs in OpenAI/Gemma-4 function shape', () => {
  const tools = [
    { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  ];
  const result = toolSpecsToTemplate(tools);
  assertEq(result.length, 1, 'one tool');
  assertEq(result[0].type, 'function', 'type: function');
  assertEq(result[0].function.name, 'read_file', 'name preserved under function');
  assertEq(result[0].function.description, 'Read a file', 'description preserved');
  assert(result[0].function.parameters.type === 'object', 'parameters preserved');
});

test('toolSpecsToTemplate: returns empty array for no tools', () => {
  assertEq(toolSpecsToTemplate([]), [], 'empty array for empty input');
  assertEq(toolSpecsToTemplate(null), [], 'empty array for null');
  assertEq(toolSpecsToTemplate(undefined), [], 'empty array for undefined');
});

// ============================================================
// parseToolCall
// ============================================================

test('parseToolCall: parses standard format', () => {
  const result = parseToolCall('call:read_file{"path": "/hello.txt"}');
  assertEq(result.name, 'read_file', 'name');
  assertEq(result.args.path, '/hello.txt', 'args.path');
  assert(result.id, 'should have an id');
});

test('parseToolCall: handles single quotes in args', () => {
  const result = parseToolCall("call:calculator{'expression': '2+2'}");
  assertEq(result.name, 'calculator', 'name');
  assertEq(result.args.expression, '2+2', 'args.expression');
});

test('parseToolCall: handles trailing commas in args', () => {
  const result = parseToolCall('call:write_file{"path": "/a.txt", "content": "hi",}');
  assertEq(result.name, 'write_file', 'name');
  assertEq(result.args.path, '/a.txt', 'args.path');
  assertEq(result.args.content, 'hi', 'args.content');
});

test('parseToolCall: handles space between name and JSON', () => {
  const result = parseToolCall('call:now {}');
  assertEq(result.name, 'now', 'name');
  assertEq(JSON.stringify(result.args), '{}', 'empty args');
});

// --- Gemma 4 native serialization (<|"|> string delims, bare key:value) ---

test('parseToolCall: Gemma 4 string arg with <|"|> delimiters', () => {
  const result = parseToolCall('call:get_weather{city:<|"|>Paris<|"|>}');
  assertEq(result.name, 'get_weather', 'name');
  assertEq(result.args.city, 'Paris', 'string value unwrapped from <|"|>');
});

test('parseToolCall: Gemma 4 multiple args, mixed types', () => {
  const result = parseToolCall('call:search{query:<|"|>mars distance<|"|>,limit:5,verbose:true}');
  assertEq(result.args.query, 'mars distance', 'string arg');
  assertEq(result.args.limit, 5, 'number arg');
  assertEq(result.args.verbose, true, 'boolean arg');
});

test('parseToolCall: Gemma 4 nested object + array args', () => {
  const result = parseToolCall('call:plot{loc:{city:<|"|>Rome<|"|>},days:[1,2,3]}');
  assertEq(result.args.loc.city, 'Rome', 'nested string');
  assertEq(result.args.days, [1, 2, 3], 'array of numbers');
});

test('parseToolCall: Gemma 4 string containing braces/commas', () => {
  const result = parseToolCall('call:echo{text:<|"|>a, {b}: c<|"|>}');
  assertEq(result.args.text, 'a, {b}: c', 'punctuation inside string preserved');
});

// ============================================================
// splitFinal — non-streaming parse
// ============================================================

test('splitFinal: plain answer (no thinking, no tools)', () => {
  const result = splitFinal('Hello, how can I help?');
  assertEq(result.thoughts, '', 'no thoughts');
  assertEq(result.content, 'Hello, how can I help?', 'content');
  assertEq(result.tool_calls.length, 0, 'no tool calls');
});

test('splitFinal: answer with thinking', () => {
  const text = '<|channel>thought\nLet me think about this...<channel|>The answer is 42.';
  const result = splitFinal(text);
  assertEq(result.thoughts, 'Let me think about this...', 'thoughts');
  assertEq(result.content, 'The answer is 42.', 'content');
  assertEq(result.tool_calls.length, 0, 'no tool calls');
});

test('splitFinal: single tool call', () => {
  const text = '<|tool_call>call:read_file{"path": "/test.txt"}<tool_call|>';
  const result = splitFinal(text);
  assertEq(result.tool_calls.length, 1, 'one tool call');
  assertEq(result.tool_calls[0].name, 'read_file', 'tool name');
  assertEq(result.tool_calls[0].args.path, '/test.txt', 'tool arg');
  assertEq(result.content, '', 'no content');
});

test('splitFinal: multiple tool calls', () => {
  const text = '<|tool_call>call:read_file{"path": "/a.txt"}<tool_call|> <|tool_call>call:read_file{"path": "/b.txt"}<tool_call|>';
  const result = splitFinal(text);
  assertEq(result.tool_calls.length, 2, 'two tool calls');
  assertEq(result.tool_calls[0].args.path, '/a.txt', 'first path');
  assertEq(result.tool_calls[1].args.path, '/b.txt', 'second path');
});

test('splitFinal: thinking + tool call + content', () => {
  const text = '<|channel>thought\nI should read the file<channel|>Let me check.<|tool_call>call:read_file{"path": "/x.txt"}<tool_call|>';
  const result = splitFinal(text);
  assertEq(result.thoughts, 'I should read the file', 'thoughts');
  assertEq(result.tool_calls.length, 1, 'one tool call');
  assertEq(result.content, 'Let me check.', 'content preserved');
});

test('splitFinal: tool call with no thinking', () => {
  const text = 'Sure, let me check.<|tool_call>call:calculator{"expression": "2+2"}<tool_call|>';
  const result = splitFinal(text);
  assertEq(result.thoughts, '', 'no thoughts');
  assertEq(result.tool_calls.length, 1, 'one tool call');
  assertEq(result.tool_calls[0].name, 'calculator', 'tool name');
  assertEq(result.content, 'Sure, let me check.', 'content before tool call');
});

test('splitFinal: Gemma 4 native tool call with <|"|> args', () => {
  const text = 'Let me check.<|tool_call>call:get_weather{city:<|"|>Tokyo<|"|>}<tool_call|>';
  const result = splitFinal(text);
  assertEq(result.tool_calls.length, 1, 'one tool call');
  assertEq(result.tool_calls[0].name, 'get_weather', 'tool name');
  assertEq(result.tool_calls[0].args.city, 'Tokyo', 'gemma-serialized arg');
  assertEq(result.content, 'Let me check.', 'content before call');
});

test('stream: Gemma 4 native tool call with <|"|> args', () => {
  const parser = createStreamParser();
  const events = [];
  events.push(...parser.push('<|tool_call>call:search{q:<|"|>hello<|"|>}<tool_call|>'));
  events.push(...parser.end());
  const toolCalls = events.filter(e => e.type === 'tool_call');
  assertEq(toolCalls.length, 1, 'one tool call');
  assertEq(toolCalls[0].call.args.q, 'hello', 'gemma-serialized arg streamed');
});

// ============================================================
// createStreamParser — basic streaming
// ============================================================

test('stream: plain answer', () => {
  const parser = createStreamParser();
  const e1 = parser.push('Hello ');
  const e2 = parser.push('world!');
  const e3 = parser.end();

  const all = [...e1, ...e2, ...e3];
  const content = all.filter(e => e.type === 'content_delta').map(e => e.delta).join('');
  assertEq(content, 'Hello world!', 'content concatenated');
});

test('stream: answer with thinking', () => {
  const parser = createStreamParser();
  const events = [];
  events.push(...parser.push('<|channel>thought\nI think '));
  events.push(...parser.push('deeply.<channel|>'));
  events.push(...parser.push('The answer.'));
  events.push(...parser.end());

  const thoughts = events.filter(e => e.type === 'thought_delta').map(e => e.delta).join('');
  const content = events.filter(e => e.type === 'content_delta').map(e => e.delta).join('');
  assertEq(thoughts, 'I think deeply.', 'thought content');
  assertEq(content, 'The answer.', 'final content');
});

test('stream: single tool call', () => {
  const parser = createStreamParser();
  const events = [];
  events.push(...parser.push('<|tool_call>call:read_file{"path": "/a.txt"}<tool_call|>'));
  events.push(...parser.end());

  const toolCalls = events.filter(e => e.type === 'tool_call');
  assertEq(toolCalls.length, 1, 'one tool call event');
  assertEq(toolCalls[0].call.name, 'read_file', 'tool name');
  assertEq(toolCalls[0].call.args.path, '/a.txt', 'tool arg');
});

test('stream: multiple tool calls', () => {
  const parser = createStreamParser();
  const events = [];
  events.push(...parser.push('<|tool_call>call:calc{"expression":"1+1"}<tool_call|>'));
  events.push(...parser.push('<|tool_call>call:now{}<tool_call|>'));
  events.push(...parser.end());

  const toolCalls = events.filter(e => e.type === 'tool_call');
  assertEq(toolCalls.length, 2, 'two tool call events');
  assertEq(toolCalls[0].call.name, 'calc', 'first tool name');
  assertEq(toolCalls[1].call.name, 'now', 'second tool name');
});

test('stream: tool call with no thinking', () => {
  const parser = createStreamParser();
  const events = [];
  events.push(...parser.push('Let me check.'));
  events.push(...parser.push('<|tool_call>call:read_file{"path":"/"}<tool_call|>'));
  events.push(...parser.end());

  const content = events.filter(e => e.type === 'content_delta').map(e => e.delta).join('');
  const toolCalls = events.filter(e => e.type === 'tool_call');
  const thoughts = events.filter(e => e.type === 'thought_delta');
  assertEq(content, 'Let me check.', 'content');
  assertEq(toolCalls.length, 1, 'one tool call');
  assertEq(thoughts.length, 0, 'no thought events');
});

// ============================================================
// createStreamParser — markers split across chunks
// ============================================================

test('stream split: thought open marker split across chunks', () => {
  const parser = createStreamParser();
  const events = [];
  // Split "<|channel>thought\n" across multiple chunks
  events.push(...parser.push('<|chan'));
  events.push(...parser.push('nel>thought\n'));
  events.push(...parser.push('deep thought'));
  events.push(...parser.push('<channel|>'));
  events.push(...parser.push('answer'));
  events.push(...parser.end());

  const thoughts = events.filter(e => e.type === 'thought_delta').map(e => e.delta).join('');
  const content = events.filter(e => e.type === 'content_delta').map(e => e.delta).join('');
  assertEq(thoughts, 'deep thought', 'thought reconstructed across chunks');
  assertEq(content, 'answer', 'content after thought');
});

test('stream split: thought close marker split across chunks', () => {
  const parser = createStreamParser();
  const events = [];
  events.push(...parser.push('<|channel>thought\n'));
  events.push(...parser.push('thinking'));
  events.push(...parser.push('<chan'));
  events.push(...parser.push('nel|>'));
  events.push(...parser.push('done'));
  events.push(...parser.end());

  const thoughts = events.filter(e => e.type === 'thought_delta').map(e => e.delta).join('');
  const content = events.filter(e => e.type === 'content_delta').map(e => e.delta).join('');
  assertEq(thoughts, 'thinking', 'thought captured');
  assertEq(content, 'done', 'content after close');
});

test('stream split: tool_call marker split across chunks', () => {
  const parser = createStreamParser();
  const events = [];
  events.push(...parser.push('<|tool'));
  events.push(...parser.push('_call>call:now{}<tool'));
  events.push(...parser.push('_call|>'));
  events.push(...parser.end());

  const toolCalls = events.filter(e => e.type === 'tool_call');
  assertEq(toolCalls.length, 1, 'tool call parsed across chunks');
  assertEq(toolCalls[0].call.name, 'now', 'tool name');
});

test('stream split: single character chunks', () => {
  const parser = createStreamParser();
  const events = [];
  const fullText = '<|channel>thought\nhi<channel|>ok';
  for (const ch of fullText) {
    events.push(...parser.push(ch));
  }
  events.push(...parser.end());

  const thoughts = events.filter(e => e.type === 'thought_delta').map(e => e.delta).join('');
  const content = events.filter(e => e.type === 'content_delta').map(e => e.delta).join('');
  assertEq(thoughts, 'hi', 'thought from single chars');
  assertEq(content, 'ok', 'content from single chars');
});

test('stream split: tool call with args split across chunks', () => {
  const parser = createStreamParser();
  const events = [];
  const text = '<|tool_call>call:read_file{"path": "/test.txt"}<tool_call|>after';
  // Feed in 3-char chunks
  for (let i = 0; i < text.length; i += 3) {
    events.push(...parser.push(text.substring(i, i + 3)));
  }
  events.push(...parser.end());

  const toolCalls = events.filter(e => e.type === 'tool_call');
  const content = events.filter(e => e.type === 'content_delta').map(e => e.delta).join('');
  assertEq(toolCalls.length, 1, 'one tool call from small chunks');
  assertEq(toolCalls[0].call.name, 'read_file', 'tool name');
  assertEq(toolCalls[0].call.args.path, '/test.txt', 'tool arg');
  assertEq(content, 'after', 'content after tool call');
});

// ============================================================
// Malformed JSON repair
// ============================================================

test('parseToolCall: repairs single quotes', () => {
  const result = parseToolCall("call:write_file{'path': '/out.txt', 'content': 'hello'}");
  assertEq(result.name, 'write_file', 'name');
  assertEq(result.args.path, '/out.txt', 'path');
  assertEq(result.args.content, 'hello', 'content');
});

test('parseToolCall: repairs trailing comma', () => {
  const result = parseToolCall('call:list_files{"dir": "/",}');
  assertEq(result.name, 'list_files', 'name');
  assertEq(result.args.dir, '/', 'dir arg');
});

test('parseToolCall: repairs single quotes + trailing comma combined', () => {
  const result = parseToolCall("call:write_file{'path': '/x.txt', 'content': 'data',}");
  assertEq(result.name, 'write_file', 'name');
  assertEq(result.args.path, '/x.txt', 'path');
  assertEq(result.args.content, 'data', 'content');
});

test('splitFinal: malformed JSON in tool call is repaired', () => {
  const text = "<|tool_call>call:calculator{'expression': '1+1',}<tool_call|>";
  const result = splitFinal(text);
  assertEq(result.tool_calls.length, 1, 'parsed despite malformed JSON');
  assertEq(result.tool_calls[0].args.expression, '1+1', 'expression arg');
});

test('stream: malformed JSON in streamed tool call is repaired', () => {
  const parser = createStreamParser();
  const events = [];
  events.push(...parser.push("<|tool_call>call:calculator{'expression': '3*3',}<tool_call|>"));
  events.push(...parser.end());

  const toolCalls = events.filter(e => e.type === 'tool_call');
  assertEq(toolCalls.length, 1, 'tool call parsed with repaired JSON');
  assertEq(toolCalls[0].call.args.expression, '3*3', 'expression');
});

// ============================================================
// Edge cases
// ============================================================

test('splitFinal: empty thinking block', () => {
  const text = '<|channel>thought\n<channel|>Hello!';
  const result = splitFinal(text);
  assertEq(result.thoughts, '', 'empty thoughts');
  assertEq(result.content, 'Hello!', 'content');
});

test('stream: empty thinking block', () => {
  const parser = createStreamParser();
  const events = [];
  events.push(...parser.push('<|channel>thought\n<channel|>Hello!'));
  events.push(...parser.end());

  const thoughts = events.filter(e => e.type === 'thought_delta').map(e => e.delta).join('');
  const content = events.filter(e => e.type === 'content_delta').map(e => e.delta).join('');
  assertEq(thoughts, '', 'empty thoughts');
  assertEq(content, 'Hello!', 'content');
});

test('buildMessagesForPrompt: does not mutate original messages', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hey', thoughts: 'thinking' },
    { role: 'user', content: 'bye' },
    { role: 'assistant', content: 'later' },
  ];
  buildMessagesForPrompt(messages, { thinking: true });
  assertEq(messages[1].thoughts, 'thinking', 'original not mutated');
});

// ============================================================
// Summary
// ============================================================

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
