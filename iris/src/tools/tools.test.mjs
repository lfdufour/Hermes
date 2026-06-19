/**
 * tools.test.mjs — Node-runnable tests for ToolRegistry + calculator.
 *
 * Run: node tools.test.mjs
 * Prints PASS/FAIL per test, exits 1 on any failure.
 *
 * Uses a FAKE in-memory vfs (no OPFS) so tests work under Node.
 */

import { ToolRegistry } from './registry.js';
import { registerBuiltins, evaluate } from './builtins.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
}

function assertClose(a, b, msg, epsilon = 1e-9) {
  assert(Math.abs(a - b) < epsilon, msg);
}

function assertThrows(fn, msg) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, msg);
}

// ---------------------------------------------------------------------------
// Fake in-memory VFS for testing
// ---------------------------------------------------------------------------
function createFakeVfs() {
  const store = new Map(); // path -> string content
  return {
    async readFile(path) {
      if (!store.has(path)) throw new Error(`File not found: ${path}`);
      return store.get(path);
    },
    async writeFile(path, data) {
      store.set(path, typeof data === 'string' ? data : String(data));
    },
    async listFiles(dir = '/') {
      const prefix = dir.endsWith('/') ? dir : dir + '/';
      const entries = [];
      for (const [p, content] of store) {
        // Include files directly under this directory
        if (p.startsWith(prefix) || (dir === '/' && !p.substring(1).includes('/'))) {
          const rel = dir === '/' ? p.substring(1) : p.substring(prefix.length);
          if (!rel.includes('/')) {
            entries.push({ name: rel, path: p, size: content.length, kind: 'file' });
          }
        }
      }
      return entries;
    },
    async deleteFile(path) {
      if (!store.has(path)) throw new Error(`File not found: ${path}`);
      store.delete(path);
    },
    async stat(path) {
      if (!store.has(path)) throw new Error(`Not found: ${path}`);
      return { name: path.split('/').pop(), kind: 'file', size: store.get(path).length };
    },
    async exists(path) {
      return store.has(path);
    },
    // Expose store for test introspection
    _store: store,
  };
}

// ---------------------------------------------------------------------------
// ToolRegistry tests
// ---------------------------------------------------------------------------
console.log('--- ToolRegistry ---');

{
  const reg = new ToolRegistry();

  // register + list
  reg.register({
    name: 'echo',
    description: 'Echo back the input',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    async run(args) { return args.text; },
  });

  const specs = reg.list();
  assert(specs.length === 1, 'list() returns 1 tool after register');
  assert(specs[0].name === 'echo', 'list() returns correct tool name');
  assert(specs[0].description === 'Echo back the input', 'list() includes description');
  assert(typeof specs[0].parameters === 'object', 'list() includes parameters');
  assert(typeof specs[0].run === 'undefined', 'list() does not leak run()');

  // has
  assert(reg.has('echo') === true, 'has() returns true for registered tool');
  assert(reg.has('nope') === false, 'has() returns false for unregistered tool');

  // invoke success
  const result = await reg.invoke('echo', { text: 'hello' });
  assert(result.ok === true, 'invoke ok=true on success');
  assert(result.value === 'hello', 'invoke returns correct value');
  assert(result.name === 'echo', 'invoke returns tool name');
  assert(typeof result.tool_call_id === 'string' && result.tool_call_id.length > 0, 'invoke generates tool_call_id');
  assert(typeof result.ms === 'number', 'invoke includes ms timing');

  // invoke with ctx.tool_call_id
  const result2 = await reg.invoke('echo', { text: 'hi' }, { tool_call_id: 'custom-id-42' });
  assert(result2.tool_call_id === 'custom-id-42', 'invoke uses ctx.tool_call_id when provided');

  // invoke unknown tool
  const result3 = await reg.invoke('nonexistent', {});
  assert(result3.ok === false, 'invoke ok=false for unknown tool');
  assert(typeof result3.error === 'string', 'invoke includes error for unknown tool');
  assert(result3.error.includes('nonexistent'), 'error mentions tool name');

  // invoke tool that throws
  reg.register({
    name: 'bomb',
    description: 'Always throws',
    parameters: {},
    async run() { throw new Error('boom'); },
  });
  const result4 = await reg.invoke('bomb', {});
  assert(result4.ok === false, 'invoke ok=false when tool throws');
  assert(result4.error === 'boom', 'invoke captures error message');
  assert(typeof result4.ms === 'number', 'invoke includes ms even on error');

  // duplicate registration throws
  let dupThrew = false;
  try {
    reg.register({ name: 'echo', description: 'dup', parameters: {}, async run() {} });
  } catch { dupThrew = true; }
  assert(dupThrew, 'register throws on duplicate name');

  // register without name throws
  let noNameThrew = false;
  try { reg.register({ description: 'x', parameters: {}, async run() {} }); } catch { noNameThrew = true; }
  assert(noNameThrew, 'register throws without name');

  // register without run throws
  let noRunThrew = false;
  try { reg.register({ name: 'bad', description: 'x', parameters: {} }); } catch { noRunThrew = true; }
  assert(noRunThrew, 'register throws without run()');

  // --- enable/disable + listAll + unregister ---
  reg.setEnabled('echo', false);
  const enabledSpecs = reg.list();
  assert(!enabledSpecs.some(s => s.name === 'echo'), 'list() hides disabled tools');
  const all = reg.listAll();
  const echoMeta = all.find(t => t.name === 'echo');
  assert(echoMeta && echoMeta.enabled === false, 'listAll() reports disabled state');
  assert(echoMeta && echoMeta.custom === false, 'listAll() marks builtins as non-custom');
  reg.setEnabled('echo', true);
  assert(reg.list().some(s => s.name === 'echo'), 'list() shows re-enabled tools');

  reg.register({ name: 'mycustom', description: 'c', parameters: {}, custom: true, code: 'return 1;', async run() { return 1; } });
  assert(reg.listAll().find(t => t.name === 'mycustom').custom === true, 'listAll() flags custom tools');
  assert(reg.unregister('mycustom') === true, 'unregister returns true when removed');
  assert(reg.has('mycustom') === false, 'tool gone after unregister');
  assert(reg.unregister('mycustom') === false, 'unregister returns false when absent');
}

// ---------------------------------------------------------------------------
// Builtins integration tests (with fake VFS)
// ---------------------------------------------------------------------------
console.log('\n--- Builtins (fake VFS) ---');

{
  const reg = new ToolRegistry();
  const fakeVfs = createFakeVfs();
  registerBuiltins(reg, { vfs: fakeVfs });

  // All expected tools registered
  for (const name of ['read_file', 'write_file', 'list_files', 'delete_file', 'calculator', 'now']) {
    assert(reg.has(name), `builtin "${name}" is registered`);
  }

  // write_file + read_file round-trip
  const wr = await reg.invoke('write_file', { path: '/hello.txt', content: 'world' });
  assert(wr.ok === true, 'write_file succeeds');
  const rd = await reg.invoke('read_file', { path: '/hello.txt' });
  assert(rd.ok === true, 'read_file succeeds');
  assert(rd.value === 'world', 'read_file returns written content');

  // list_files
  await reg.invoke('write_file', { path: '/second.txt', content: 'data' });
  const ls = await reg.invoke('list_files', {});
  assert(ls.ok === true, 'list_files succeeds');
  assert(Array.isArray(ls.value), 'list_files returns array');
  assert(ls.value.length >= 2, 'list_files sees written files');

  // delete_file
  const del = await reg.invoke('delete_file', { path: '/hello.txt' });
  assert(del.ok === true, 'delete_file succeeds');
  const rd2 = await reg.invoke('read_file', { path: '/hello.txt' });
  assert(rd2.ok === false, 'read_file fails after delete');

  // now
  const nw = await reg.invoke('now', {});
  assert(nw.ok === true, 'now succeeds');
  assert(typeof nw.value === 'string', 'now returns string');
  assert(nw.value.includes('T'), 'now returns ISO-like string');
}

// ---------------------------------------------------------------------------
// Calculator tests (via evaluate)
// ---------------------------------------------------------------------------
console.log('\n--- Calculator (evaluate) ---');

// Basic operations
assertClose(evaluate('2 + 3'), 5, '2 + 3 = 5');
assertClose(evaluate('10 - 4'), 6, '10 - 4 = 6');
assertClose(evaluate('3 * 7'), 21, '3 * 7 = 21');
assertClose(evaluate('20 / 4'), 5, '20 / 4 = 5');
assertClose(evaluate('10 % 3'), 1, '10 % 3 = 1');
assertClose(evaluate('2 ^ 10'), 1024, '2 ^ 10 = 1024');

// Decimals
assertClose(evaluate('3.14 * 2'), 6.28, '3.14 * 2 = 6.28');
assertClose(evaluate('0.1 + 0.2'), 0.3, '0.1 + 0.2 ≈ 0.3', 1e-6);

// Operator precedence
assertClose(evaluate('2 + 3 * 4'), 14, '2 + 3 * 4 = 14 (precedence)');
assertClose(evaluate('2 * 3 + 4'), 10, '2 * 3 + 4 = 10 (precedence)');
assertClose(evaluate('2 + 3 ^ 2'), 11, '2 + 3^2 = 11 (power before add)');
assertClose(evaluate('2 * 3 ^ 2'), 18, '2 * 3^2 = 18 (power before mul)');

// Right-associativity of ^
assertClose(evaluate('2 ^ 3 ^ 2'), 512, '2^3^2 = 512 (right-assoc)');

// Parentheses
assertClose(evaluate('(2 + 3) * 4'), 20, '(2 + 3) * 4 = 20');
assertClose(evaluate('((1 + 2) * (3 + 4))'), 21, '((1+2)*(3+4)) = 21');
assertClose(evaluate('(2 ^ (1 + 2))'), 8, '(2^(1+2)) = 8');

// Unary minus
assertClose(evaluate('-5'), -5, '-5 = -5');
assertClose(evaluate('-5 + 3'), -2, '-5 + 3 = -2');
assertClose(evaluate('-(3 + 2)'), -5, '-(3+2) = -5');
assertClose(evaluate('2 * -3'), -6, '2 * -3 = -6');
assertClose(evaluate('-(-5)'), 5, '-(-5) = 5');

// Complex expression
assertClose(evaluate('3 + 4 * 2 / (1 - 5) ^ 2'), 3.5, '3+4*2/(1-5)^2 = 3.5');

// Edge cases — should reject non-math input
assertThrows(() => evaluate(''), 'rejects empty string');
assertThrows(() => evaluate('hello'), 'rejects alphabetic input');
assertThrows(() => evaluate('2 +'), 'rejects trailing operator');
assertThrows(() => evaluate('* 3'), 'rejects leading binary operator');
// "2 + + 3" is valid — second + is unary plus
assertClose(evaluate('2 + + 3'), 5, '2 + +3 = 5 (unary plus)');
assertThrows(() => evaluate('(2 + 3'), 'rejects unmatched opening paren');
assertThrows(() => evaluate('2 + 3)'), 'rejects unmatched closing paren');
assertThrows(() => evaluate('abc + 123'), 'rejects variables');
assertThrows(() => evaluate('eval("1")'), 'rejects eval attempt');
assertThrows(() => evaluate('require("fs")'), 'rejects require attempt');

// Division by zero
assertThrows(() => evaluate('1 / 0'), 'rejects division by zero');
assertThrows(() => evaluate('5 % 0'), 'rejects modulo by zero');

// Calculator via registry
console.log('\n--- Calculator (via registry.invoke) ---');
{
  const reg = new ToolRegistry();
  const fakeVfs = createFakeVfs();
  registerBuiltins(reg, { vfs: fakeVfs });

  const r1 = await reg.invoke('calculator', { expression: '2 + 3 * 4' });
  assert(r1.ok === true, 'calculator invoke succeeds');
  assertClose(r1.value, 14, 'calculator result = 14');

  const r2 = await reg.invoke('calculator', { expression: 'not math!' });
  assert(r2.ok === false, 'calculator invoke fails on bad input');
  assert(typeof r2.error === 'string', 'calculator error is a string');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
