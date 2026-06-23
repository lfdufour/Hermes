/**
 * patent.test.mjs — Node-runnable tests for patent/ modules.
 *
 * Covers: normalizeNumber, segmentPassages, topPassages.
 * parsePatentHtml needs DOMParser (browser), so we test it via small HTML
 * fixtures using a minimal JSDOM-free approach (we inline test the extraction
 * logic through segmentPassages which is pure string logic).
 *
 * Run: node src/patent/patent.test.mjs
 * Exits non-zero on any failure.
 */

// --- Test helpers ---

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, name) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.error(`  FAIL: ${name}`);
  }
}

function assertEqual(actual, expected, name) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.error(`  FAIL: ${name}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
  }
}

// --- Import modules under test ---

// NOTE: We import from the source files directly. segmentPassages and
// topPassages are pure logic and fully node-testable. normalizeNumber
// and buildPatentUrl are also pure.

import { normalizeNumber, buildPatentUrl, DEFAULT_PROXIES, parsePasted } from './fetch.js';
import { segmentPassages } from './parse.js';
import { topPassages } from './retrieve.js';

// ===================================================================
// normalizeNumber
// ===================================================================
console.log('--- normalizeNumber ---');

assertEqual(
  normalizeNumber('de 19728057 c2'),
  'DE19728057C2',
  'normalizeNumber: spaces + lowercase'
);

assertEqual(
  normalizeNumber('DE19728057C2'),
  'DE19728057C2',
  'normalizeNumber: already normalized'
);

assertEqual(
  normalizeNumber('us-2020/0264668-a1'),
  'US20200264668A1',
  'normalizeNumber: dashes and slashes'
);

assertEqual(
  normalizeNumber('EP 1 234 567 B1'),
  'EP1234567B1',
  'normalizeNumber: EP with spaces'
);

assertEqual(
  normalizeNumber('wo 2023.123456'),
  'WO2023123456',
  'normalizeNumber: dots'
);

// ===================================================================
// buildPatentUrl
// ===================================================================
console.log('--- buildPatentUrl ---');

assertEqual(
  buildPatentUrl('DE19728057C2'),
  'https://patents.google.com/patent/DE19728057C2/en',
  'buildPatentUrl: basic'
);

// ===================================================================
// DEFAULT_PROXIES
// ===================================================================
console.log('--- DEFAULT_PROXIES ---');

assert(
  Array.isArray(DEFAULT_PROXIES) && DEFAULT_PROXIES.length > 0,
  'DEFAULT_PROXIES: is non-empty array'
);

assert(
  DEFAULT_PROXIES.every(p => p.includes('{url}')),
  'DEFAULT_PROXIES: all contain {url} placeholder'
);

// ===================================================================
// segmentPassages — description with [00xx] numbers
// ===================================================================
console.log('--- segmentPassages: description with paragraph numbers ---');

{
  const text = `[0001] This application claims priority from Korean Patent Application No. 10-2019-0017042.

[0002] Exemplary embodiments relate to a display device.

[0003] Electronic devices such as smart phones include a display device for displaying images.`;

  const passages = segmentPassages(text, 'description');

  assertEqual(passages.length, 3, 'paraNum: 3 passages');
  assertEqual(passages[0].label, '[0001]', 'paraNum: first label');
  assertEqual(passages[0].section, 'description', 'paraNum: section is description');
  assertEqual(passages[0].index, 0, 'paraNum: first index is 0');
  assert(
    passages[0].text.startsWith('This application claims'),
    'paraNum: text content correct'
  );
  assertEqual(passages[1].label, '[0002]', 'paraNum: second label');
  assertEqual(passages[2].label, '[0003]', 'paraNum: third label');
  assertEqual(passages[2].index, 2, 'paraNum: third index is 2');
}

// ===================================================================
// segmentPassages — description without paragraph numbers (fallback)
// ===================================================================
console.log('--- segmentPassages: description without paragraph numbers ---');

{
  const text = `The invention relates to a filling element mentioned in the preamble of claim 1.

A generic filler is from the DE-OS 20 45 293 known. The relief device relieves the off in this construction.

The aim of these constructions is to ensure the liquid-free headspace of the filled container.`;

  const passages = segmentPassages(text, 'description');

  assertEqual(passages.length, 3, 'noPara: 3 passages');
  assertEqual(passages[0].label, '¶1', 'noPara: first label ¶1');
  assertEqual(passages[1].label, '¶2', 'noPara: second label ¶2');
  assertEqual(passages[2].label, '¶3', 'noPara: third label ¶3');
  assertEqual(passages[0].section, 'description', 'noPara: section is description');
  assert(
    passages[0].text.startsWith('The invention relates'),
    'noPara: text content correct'
  );
}

// ===================================================================
// segmentPassages — empty input
// ===================================================================
console.log('--- segmentPassages: edge cases ---');

{
  assertEqual(segmentPassages('', 'description'), [], 'empty string returns []');
  assertEqual(segmentPassages('   ', 'description'), [], 'whitespace returns []');
  assertEqual(segmentPassages(null, 'description'), [], 'null returns []');
  assertEqual(segmentPassages(undefined, 'claims'), [], 'undefined returns []');
}

// ===================================================================
// segmentPassages — claims
// ===================================================================
console.log('--- segmentPassages: claims ---');

{
  const text = `1. A display device comprising: a display panel which comprises a main region configured to display an image.

2. The display device of claim 1, wherein the metal layer comprises a first edge and a second edge.

3. The display device of claim 1, wherein the notch region is an incision region defined in the metal layer.`;

  const passages = segmentPassages(text, 'claims');

  assertEqual(passages.length, 3, 'claims: 3 claims');
  assertEqual(passages[0].label, 'claim 1', 'claims: first label');
  assertEqual(passages[1].label, 'claim 2', 'claims: second label');
  assertEqual(passages[2].label, 'claim 3', 'claims: third label');
  assertEqual(passages[0].section, 'claims', 'claims: section is claims');
  assert(
    passages[0].text.startsWith('A display device comprising'),
    'claims: claim 1 text starts correctly (no leading number)'
  );
  assert(
    passages[1].text.startsWith('The display device of claim 1'),
    'claims: claim 2 text correct'
  );
}

// ===================================================================
// segmentPassages — claims with dependent multi-line
// ===================================================================
console.log('--- segmentPassages: multi-line claims ---');

{
  const text = `1. Filling element for filling beverage containers (bottle 8) under pressure with CO2-containing beverages, with a liquid valve (10) and with a height-adjustable return gas pipe (12), characterized in that the control device (16) controls the immersion depth.

2. Filling device according to claim 1, characterized in that the control direction (16) works independently of the control devices of other filling elements of a filling machine.`;

  const passages = segmentPassages(text, 'claims');

  assertEqual(passages.length, 2, 'multiline claims: 2 claims');
  assertEqual(passages[0].label, 'claim 1', 'multiline claims: first label');
  assert(
    passages[0].text.includes('characterized in that'),
    'multiline claims: full text preserved'
  );
}

// ===================================================================
// segmentPassages — single claim without number
// ===================================================================
console.log('--- segmentPassages: single claim without number ---');

{
  const text = `A method of making a widget comprising steps of heating and cooling.`;
  const passages = segmentPassages(text, 'claims');

  assertEqual(passages.length, 1, 'single unnumbered claim: 1 passage');
  assertEqual(passages[0].label, 'claim 1', 'single unnumbered claim: label is claim 1');
}

// ===================================================================
// segmentPassages — description with mixed content before [0001]
// ===================================================================
console.log('--- segmentPassages: text before first para number ---');

{
  const text = `BACKGROUND OF THE INVENTION

[0001] The present invention relates to a widget.

[0002] Prior art widgets have limitations.`;

  const passages = segmentPassages(text, 'description');

  // The "BACKGROUND" text is short (< 10 chars? no, it's 29 chars), so it gets [0000]
  assertEqual(passages.length, 3, 'prePara: 3 passages (including pre-text)');
  assertEqual(passages[0].label, '[0000]', 'prePara: pre-text gets [0000]');
  assertEqual(passages[1].label, '[0001]', 'prePara: first numbered para');
  assertEqual(passages[2].label, '[0002]', 'prePara: second numbered para');
}

// ===================================================================
// topPassages — basic ranking
// ===================================================================
console.log('--- topPassages: basic ranking ---');

{
  const passages = [
    { index: 0, label: '¶1', text: 'The cat sat on the mat', section: 'description' },
    { index: 1, label: '¶2', text: 'A liquid valve controls the flow of beverage through a pipe', section: 'description' },
    { index: 2, label: '¶3', text: 'The foam control valve regulates beverage foam generation', section: 'description' },
    { index: 3, label: '¶4', text: 'Temperature sensors monitor the heating element', section: 'description' },
    { index: 4, label: '¶5', text: 'The beverage container includes a foam barrier valve mechanism', section: 'description' },
  ];

  const result = topPassages('beverage foam control valve', passages, { k: 3 });

  assertEqual(result.length, 3, 'topPassages: returns k=3 results');

  // The passages about foam/valve/beverage should rank higher than cat/temperature
  const labels = result.map(p => p.label);
  assert(!labels.includes('¶1'), 'topPassages: "cat" passage not in top 3');
  assert(!labels.includes('¶4'), 'topPassages: "temperature" passage not in top 3');
  assert(labels.includes('¶3'), 'topPassages: foam+control+valve+beverage passage is top');
}

// ===================================================================
// topPassages — deterministic ordering (same scores, stable by index)
// ===================================================================
console.log('--- topPassages: deterministic ---');

{
  const passages = [
    { index: 0, label: '¶1', text: 'alpha beta gamma', section: 'description' },
    { index: 1, label: '¶2', text: 'alpha beta gamma', section: 'description' },
  ];

  const result1 = topPassages('alpha', passages, { k: 2 });
  const result2 = topPassages('alpha', passages, { k: 2 });

  assertEqual(
    result1.map(p => p.index),
    result2.map(p => p.index),
    'topPassages: deterministic on identical scores'
  );
  assertEqual(result1[0].index, 0, 'topPassages: lower index wins tie');
}

// ===================================================================
// topPassages — empty inputs
// ===================================================================
console.log('--- topPassages: edge cases ---');

{
  assertEqual(topPassages('test', [], { k: 3 }), [], 'topPassages: empty passages returns []');

  const passages = [
    { index: 0, label: '¶1', text: 'some text', section: 'description' },
  ];
  const result = topPassages('', passages, { k: 3 });
  assertEqual(result.length, 1, 'topPassages: empty query returns first k passages');
}

// ===================================================================
// topPassages — k larger than available passages
// ===================================================================
console.log('--- topPassages: k > passages.length ---');

{
  const passages = [
    { index: 0, label: '¶1', text: 'valve mechanism', section: 'description' },
    { index: 1, label: '¶2', text: 'pipe valve', section: 'description' },
  ];

  const result = topPassages('valve control', passages, { k: 10 });
  assertEqual(result.length, 2, 'topPassages: returns all passages when k > length');
}

// ===================================================================
// topPassages — proper TF scoring (term that appears more often scores higher)
// ===================================================================
console.log('--- topPassages: TF sensitivity ---');

{
  const passages = [
    { index: 0, label: '¶1', text: 'valve', section: 'description' },
    { index: 1, label: '¶2', text: 'valve valve valve mechanism control system', section: 'description' },
  ];

  const result = topPassages('valve', passages, { k: 2 });
  // Passage 1 has "valve" once out of 1 token => TF=1.0
  // Passage 2 has "valve" 3 times out of 6 tokens => TF=0.5
  // Passage 1 should score higher due to normalized scoring
  assertEqual(result[0].index, 0, 'topPassages: higher TF density scores higher');
}

// ===================================================================
// topPassages — multi-term coverage rewards
// ===================================================================
console.log('--- topPassages: multi-term coverage ---');

{
  const passages = [
    { index: 0, label: '¶1', text: 'immersion depth control device mechanism', section: 'description' },
    { index: 1, label: '¶2', text: 'weather report sunny cloudy rainy', section: 'description' },
    { index: 2, label: '¶3', text: 'immersion depth control regulates foam generation device', section: 'description' },
  ];

  const result = topPassages('immersion depth control device', passages, { k: 2 });
  // Passage 0 has all 4 query terms in 5 tokens => high score
  // Passage 1 has 0 query terms => score 0
  // Passage 2 has all 4 query terms in 7 tokens => good but lower density than 0
  const labels = result.map(p => p.label);
  assert(
    !labels.includes('¶2'),
    'topPassages: unrelated passage not in top 2'
  );
  assertEqual(result[0].index, 0, 'topPassages: best coverage+density ranks first');
}

// ===================================================================
// parsePasted — basic round-trip
// ===================================================================
console.log('--- parsePasted ---');

{
  const doc = parsePasted('de 19728057 c2', 'Description text here.\n\nMore description.\n\nClaims\n\n1. A method of doing things.\n\n2. The method of claim 1 with extras.');

  assertEqual(doc.id, 'DE19728057C2', 'parsePasted: id normalized');
  assertEqual(doc.status, 'pasted', 'parsePasted: status is pasted');
  assert(doc.description.includes('Description text'), 'parsePasted: description extracted');
  assert(doc.claims.includes('method'), 'parsePasted: claims extracted');
  assert(doc.passages.length > 0, 'parsePasted: has passages');
  assert(doc.url.includes('DE19728057C2'), 'parsePasted: url contains patent number');
}

// ===================================================================
// Summary
// ===================================================================
console.log('\n===========================');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('Failures:');
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
}
console.log('===========================');
console.log(failed === 0 ? 'PASS' : 'FAIL');

process.exit(failed === 0 ? 0 : 1);
