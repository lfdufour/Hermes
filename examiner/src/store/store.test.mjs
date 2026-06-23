/**
 * store.test.mjs — Node-runnable tests for store/cases.js (pure parts) and store/exportReport.js.
 *
 * Run: node src/store/store.test.mjs
 * Prints PASS/FAIL per test; exits non-zero on any failure.
 *
 * Zero dependencies. IndexedDB tests are NOT included here (browser-only);
 * we test the pure-logic exports: newCase, exportJSON, importJSON, toCSV, toMarkdown.
 */

// NOTE: Dynamically import so we can set up crypto polyfill first if needed.
// Node 19+ has crypto.randomUUID; older nodes need a shim.
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = {};
}
if (typeof globalThis.crypto.randomUUID !== 'function') {
  globalThis.crypto.randomUUID = () =>
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
}

const { casesStore } = await import('./cases.js');
const { toCSV, toMarkdown } = await import('./exportReport.js');

let passed = 0;
let failed = 0;

/**
 * Minimal test runner.
 */
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      (message ? message + ': ' : '') +
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertIncludes(haystack, needle, message) {
  if (!haystack.includes(needle)) {
    throw new Error(
      (message ? message + ': ' : '') +
      `expected string to include ${JSON.stringify(needle)}\n        got: ${JSON.stringify(haystack.slice(0, 200))}...`
    );
  }
}

// ---------------------------------------------------------------------------
// Build a realistic test fixture
// ---------------------------------------------------------------------------

function buildTestCase() {
  return {
    id: 'test-case-001',
    title: 'Widget Apparatus',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    source: {
      claims: 'Claim 1: A widget comprising a housing (10) and a processor.',
      description: 'The invention relates to widgets...',
    },
    meta: {
      applicant: 'Acme Corp',
      applicationNo: 'EP2026001234',
      category: 'product',
    },
    table: {
      claims: [
        { num: 1, type: 'independent', dependsOn: [], category: 'product', twoPart: true },
        { num: 2, type: 'dependent', dependsOn: [1], category: 'product', twoPart: false },
      ],
      features: [
        {
          id: '1.1',
          claim: 1,
          type: 'independent',
          dependsOn: [],
          text: 'A widget comprising a housing',
          portion: 'preamble',
          refSigns: ['10'],
          category: 'product',
        },
        {
          id: '1.2',
          claim: 1,
          type: 'independent',
          dependsOn: [],
          text: 'a processor arranged within the housing',
          portion: 'characterizing',
          refSigns: [],
          category: 'product',
        },
        {
          id: '2.1',
          claim: 2,
          type: 'dependent',
          dependsOn: [1],
          text: 'wherein the processor is an ASIC',
          portion: null,
          refSigns: [],
          category: 'product',
        },
      ],
    },
    documents: [
      {
        id: 'DE19728057C2',
        number: 'DE19728057C2',
        url: 'https://patents.google.com/patent/DE19728057C2/en',
        status: 'loaded',
        title: 'Housing device',
        description: 'A known housing structure...',
        claims: 'Claim 1: A housing with electronics.',
        passages: [
          { index: 0, label: '[0001]', text: 'A known housing structure...', section: 'description' },
        ],
        fetchedAt: '2026-01-02T12:00:00.000Z',
        searchCategory: 'X',
      },
      {
        id: 'US6543210B1',
        number: 'US6543210B1',
        url: 'https://patents.google.com/patent/US6543210B1/en',
        status: 'loaded',
        title: 'Processor chip',
        description: 'An ASIC-based processor...',
        claims: 'Claim 1: A processor chip.',
        passages: [],
        fetchedAt: '2026-01-02T13:00:00.000Z',
        searchCategory: 'Y',
      },
    ],
    mappings: {
      'DE19728057C2': {
        '1.1': {
          featureId: '1.1',
          verdict: 'Y',
          citations: [
            { label: '[0001]', quote: 'A known housing structure' },
          ],
          explanation: 'The housing is directly disclosed in paragraph [0001].',
          status: 'done',
        },
        '1.2': {
          featureId: '1.2',
          verdict: 'P',
          citations: [
            { label: '[0001]', quote: 'housing structure' },
          ],
          explanation: 'A processor is implied but not explicitly disclosed.',
          status: 'done',
        },
        '2.1': {
          featureId: '2.1',
          verdict: 'N',
          citations: [],
          explanation: 'No mention of ASIC technology.',
          status: 'done',
        },
      },
      'US6543210B1': {
        '1.1': {
          featureId: '1.1',
          verdict: 'N',
          citations: [],
          explanation: 'Document focuses on processor, not housing.',
          status: 'done',
        },
        '1.2': {
          featureId: '1.2',
          verdict: 'Y',
          citations: [
            { label: '[0010]', quote: 'ASIC-based processor unit' },
          ],
          explanation: 'Processor is disclosed.',
          status: 'done',
        },
        '2.1': {
          featureId: '2.1',
          verdict: 'Y',
          citations: [
            { label: '[0010]', quote: 'ASIC-based processor unit' },
          ],
          explanation: 'ASIC is directly disclosed.',
          status: 'done',
        },
      },
    },
    summaries: {
      'DE19728057C2': {
        disclosedCount: 1,
        partialCount: 1,
        totalCount: 3,
        independentFullyDisclosed: false,
        noveltyVerdict: 'Discloses housing but not processor specifics; relevant in combination.',
        suggestedCategory: 'Y',
      },
      'US6543210B1': {
        disclosedCount: 2,
        partialCount: 0,
        totalCount: 3,
        independentFullyDisclosed: false,
        noveltyVerdict: 'Discloses processor and ASIC but not the housing; relevant in combination.',
        suggestedCategory: 'Y',
      },
    },
    settings: { modelId: 'test-model' },
  };
}

// ===========================================================================
console.log('\n--- casesStore.newCase ---');
// ===========================================================================

test('newCase returns object with all required fields', () => {
  const c = casesStore.newCase({ title: 'Test Patent' });
  assertEqual(c.title, 'Test Patent', 'title');
  assert(typeof c.id === 'string' && c.id.length > 0, 'id should be non-empty string');
  assert(typeof c.createdAt === 'string', 'createdAt should be string');
  assert(typeof c.updatedAt === 'string', 'updatedAt should be string');
  assertEqual(c.createdAt, c.updatedAt, 'createdAt === updatedAt initially');
});

test('newCase has empty source fields', () => {
  const c = casesStore.newCase({ title: 'X' });
  assertEqual(c.source.claims, '', 'source.claims');
  assertEqual(c.source.description, '', 'source.description');
});

test('newCase has empty table with claims and features arrays', () => {
  const c = casesStore.newCase({ title: 'X' });
  assert(Array.isArray(c.table.claims), 'table.claims is array');
  assert(Array.isArray(c.table.features), 'table.features is array');
  assertEqual(c.table.claims.length, 0, 'table.claims empty');
  assertEqual(c.table.features.length, 0, 'table.features empty');
});

test('newCase has empty documents, mappings, summaries', () => {
  const c = casesStore.newCase({ title: 'X' });
  assert(Array.isArray(c.documents), 'documents is array');
  assertEqual(c.documents.length, 0, 'documents empty');
  assertEqual(Object.keys(c.mappings).length, 0, 'mappings empty');
  assertEqual(Object.keys(c.summaries).length, 0, 'summaries empty');
});

test('newCase has settings with empty modelId', () => {
  const c = casesStore.newCase({ title: 'X' });
  assert(typeof c.settings === 'object', 'settings is object');
  assertEqual(c.settings.modelId, '', 'settings.modelId');
});

test('newCase has empty meta object', () => {
  const c = casesStore.newCase({ title: 'X' });
  assert(typeof c.meta === 'object', 'meta is object');
});

test('newCase generates unique ids', () => {
  const ids = new Set();
  for (let i = 0; i < 50; i++) {
    ids.add(casesStore.newCase({ title: `Case ${i}` }).id);
  }
  assertEqual(ids.size, 50, 'all 50 ids should be unique');
});

test('newCase id looks like a UUID', () => {
  const c = casesStore.newCase({ title: 'X' });
  // UUID v4 pattern: 8-4-4-4-12 hex chars
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert(uuidRe.test(c.id), `id "${c.id}" should match UUID v4 pattern`);
});

// ===========================================================================
console.log('\n--- casesStore.exportJSON / importJSON ---');
// ===========================================================================

test('exportJSON returns valid JSON string', () => {
  const c = casesStore.newCase({ title: 'Export Test' });
  const json = casesStore.exportJSON(c);
  const parsed = JSON.parse(json);
  assertEqual(parsed.title, 'Export Test');
  assertEqual(parsed.id, c.id);
});

test('importJSON round-trips with exportJSON', () => {
  const original = buildTestCase();
  const json = casesStore.exportJSON(original);
  const restored = casesStore.importJSON(json);
  assertEqual(restored.id, original.id);
  assertEqual(restored.title, original.title);
  assertEqual(restored.table.features.length, 3);
  assertEqual(restored.documents.length, 2);
});

test('importJSON rejects invalid JSON', () => {
  let threw = false;
  try {
    casesStore.importJSON('not json at all');
  } catch (e) {
    threw = true;
  }
  assert(threw, 'should throw on invalid JSON');
});

test('importJSON rejects object missing id', () => {
  let threw = false;
  try {
    casesStore.importJSON('{"title":"X"}');
  } catch (e) {
    threw = true;
    assertIncludes(e.message, 'id');
  }
  assert(threw, 'should throw when id missing');
});

test('importJSON rejects object missing title', () => {
  let threw = false;
  try {
    casesStore.importJSON('{"id":"abc"}');
  } catch (e) {
    threw = true;
    assertIncludes(e.message, 'title');
  }
  assert(threw, 'should throw when title missing');
});

// ===========================================================================
console.log('\n--- toCSV ---');
// ===========================================================================

test('toCSV produces header with feature columns and per-doc groups', () => {
  const c = buildTestCase();
  const csv = toCSV(c);
  const headerLine = csv.split('\n')[0];
  assertIncludes(headerLine, 'Feature ID');
  assertIncludes(headerLine, 'Claim');
  assertIncludes(headerLine, 'Feature Text');
  assertIncludes(headerLine, 'DE19728057C2 Verdict');
  assertIncludes(headerLine, 'DE19728057C2 Citations');
  assertIncludes(headerLine, 'DE19728057C2 Explanation');
  assertIncludes(headerLine, 'US6543210B1 Verdict');
});

test('toCSV has correct number of data rows (one per feature)', () => {
  const c = buildTestCase();
  const csv = toCSV(c);
  const lines = csv.split('\n');
  // Header + 3 feature rows + blank + summary header + summary data + independent row = 8
  assertEqual(lines[1].startsWith('1.1'), true, 'first data row starts with feature 1.1');
  assertEqual(lines[2].startsWith('1.2'), true, 'second data row starts with feature 1.2');
  assertEqual(lines[3].startsWith('2.1'), true, 'third data row starts with feature 2.1');
});

test('toCSV correctly escapes commas and quotes in feature text', () => {
  const c = buildTestCase();
  c.table.features[0].text = 'A widget, comprising a "housing"';
  const csv = toCSV(c);
  // The cell should be quoted with internal quotes doubled
  assertIncludes(csv, '"A widget, comprising a ""housing"""');
});

test('toCSV correctly escapes newlines in explanations', () => {
  const c = buildTestCase();
  c.mappings['DE19728057C2']['1.1'].explanation = 'Line one.\nLine two.';
  const csv = toCSV(c);
  assertIncludes(csv, '"Line one.\nLine two."');
});

test('toCSV includes summary section', () => {
  const c = buildTestCase();
  const csv = toCSV(c);
  assertIncludes(csv, 'Summary');
  assertIncludes(csv, '1/3 disclosed');
  assertIncludes(csv, 'Independent claims fully disclosed?');
  assertIncludes(csv, 'No');
});

test('toCSV includes verdicts in feature rows', () => {
  const c = buildTestCase();
  const csv = toCSV(c);
  const lines = csv.split('\n');
  // Feature 1.1 row should contain Y for DE doc and N for US doc
  const row1 = lines[1];
  assertIncludes(row1, 'Y');
});

test('toCSV handles empty case gracefully', () => {
  const c = casesStore.newCase({ title: 'Empty' });
  const csv = toCSV(c);
  assert(csv.length > 0, 'should produce at least a header');
  assertIncludes(csv, 'Feature ID');
});

test('toCSV includes citation text', () => {
  const c = buildTestCase();
  const csv = toCSV(c);
  assertIncludes(csv, 'A known housing structure');
  assertIncludes(csv, '[0001]');
});

// ===========================================================================
console.log('\n--- toMarkdown ---');
// ===========================================================================

test('toMarkdown produces title heading', () => {
  const c = buildTestCase();
  const md = toMarkdown(c);
  assertIncludes(md, '# Patent Examiner Search Report: Widget Apparatus');
});

test('toMarkdown includes metadata', () => {
  const c = buildTestCase();
  const md = toMarkdown(c);
  assertIncludes(md, '**Applicant:** Acme Corp');
  assertIncludes(md, '**Application No:** EP2026001234');
});

test('toMarkdown includes document legend', () => {
  const c = buildTestCase();
  const md = toMarkdown(c);
  assertIncludes(md, '## Prior Art Documents');
  assertIncludes(md, '**DE19728057C2**');
  assertIncludes(md, 'Housing device');
  assertIncludes(md, 'Category Y');
});

test('toMarkdown includes feature matrix table', () => {
  const c = buildTestCase();
  const md = toMarkdown(c);
  assertIncludes(md, '## Feature Mapping Matrix');
  assertIncludes(md, '| Feature ID |');
  // Check that verdict cells appear
  assertIncludes(md, '| 1.1 |');
});

test('toMarkdown matrix table has proper separator row', () => {
  const c = buildTestCase();
  const md = toMarkdown(c);
  // Separator should have centered columns for verdicts
  assertIncludes(md, ':---:');
});

test('toMarkdown includes per-document summaries', () => {
  const c = buildTestCase();
  const md = toMarkdown(c);
  assertIncludes(md, '## DE19728057C2');
  assertIncludes(md, '**Disclosed:** 1/3');
  assertIncludes(md, '**Suggested category:** Y');
  assertIncludes(md, 'Discloses housing but not processor specifics');
});

test('toMarkdown includes detailed feature tables per document', () => {
  const c = buildTestCase();
  const md = toMarkdown(c);
  assertIncludes(md, '### Feature Details');
  assertIncludes(md, '| Feature | Verdict | Citations | Explanation |');
  assertIncludes(md, 'A known housing structure');
});

test('toMarkdown escapes pipe characters in feature text', () => {
  const c = buildTestCase();
  c.table.features[0].text = 'A|B connection';
  const md = toMarkdown(c);
  assertIncludes(md, 'A\\|B connection');
});

test('toMarkdown handles empty case gracefully', () => {
  const c = casesStore.newCase({ title: 'Empty Case' });
  const md = toMarkdown(c);
  assertIncludes(md, '# Patent Examiner Search Report: Empty Case');
  // Should not crash
  assert(md.length > 50, 'should produce meaningful output');
});

test('toMarkdown includes generation footer', () => {
  const c = buildTestCase();
  const md = toMarkdown(c);
  assertIncludes(md, 'Generated by Hermes Patent Examiner');
});

test('toMarkdown includes independent claim disclosure info', () => {
  const c = buildTestCase();
  const md = toMarkdown(c);
  assertIncludes(md, '**Independent claims fully disclosed:** No');
});

test('toMarkdown handles case with no mappings', () => {
  const c = buildTestCase();
  c.mappings = {};
  c.summaries = {};
  const md = toMarkdown(c);
  // Should still have the matrix (with empty verdict cells)
  assertIncludes(md, '## Feature Mapping Matrix');
  // Document sections should exist but without summary details
  assertIncludes(md, '## DE19728057C2');
});

// ===========================================================================
// Report
// ===========================================================================

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);

if (failed > 0) {
  process.exit(1);
}
