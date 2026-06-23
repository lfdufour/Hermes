/**
 * cognition.test.mjs — Pure-logic tests for table.js helpers + summarize.
 *
 * Zero dependencies; node-runnable: `node cognition.test.mjs`
 * Prints PASS/FAIL per test, exits non-zero on any failure.
 * Does NOT call the real model — tests only pure functions with stubbed data.
 */

import {
  splitClaimsIntoUnits,
  renumber,
  dependencyContext,
  validateTable,
  detectDependency,
  detectTwoPart,
  detectCategory,
  extractRefSigns,
} from './table.js';

// Import summarize from mapping (relative path from features/)
import { summarize } from '../mapping/map.js';

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name}`);
    failed++;
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ============================================================================
console.log('\n--- splitClaimsIntoUnits ---');

{
  const text = `1. A device for processing data comprising a processor (10) and a memory (20).
2. The device according to claim 1, wherein the processor is a multi-core processor.
3. A method of processing data, comprising the steps of receiving and transmitting.`;
  const units = splitClaimsIntoUnits(text);
  assert(units.length === 3, 'splits 3 claims');
  assert(units[0].num === 1, 'first claim is #1');
  assert(units[1].num === 2, 'second claim is #2');
  assert(units[2].num === 3, 'third claim is #3');
  assert(units[0].text.startsWith('A device'), 'claim 1 text stripped of number prefix');
  assert(units[1].text.includes('according to claim 1'), 'claim 2 has dependency text');
}

{
  const units = splitClaimsIntoUnits('');
  assert(units.length === 0, 'empty string returns empty array');
}

{
  const units = splitClaimsIntoUnits(null);
  assert(units.length === 0, 'null returns empty array');
}

{
  const text = 'A single claim with no numbering.';
  const units = splitClaimsIntoUnits(text);
  assert(units.length === 1, 'unnumbered text → single claim');
  assert(units[0].num === 1, 'unnumbered fallback is claim 1');
}

{
  const text = `Claim 1. A widget comprising a frame.
Claim 2. The widget of claim 1, further comprising a lid.`;
  const units = splitClaimsIntoUnits(text);
  assert(units.length === 2, '"Claim N." style — splits 2');
  assert(units[0].num === 1, '"Claim 1." parsed as #1');
}

// ============================================================================
console.log('\n--- renumber ---');

{
  const features = [
    { claim: 1, text: 'f1a' },
    { claim: 1, text: 'f1b' },
    { claim: 2, text: 'f2a' },
    { claim: 2, text: 'f2b' },
    { claim: 2, text: 'f2c' },
  ];
  const result = renumber(features);
  assert(result[0].id === '1.1', 'first feature of claim 1 is 1.1');
  assert(result[1].id === '1.2', 'second feature of claim 1 is 1.2');
  assert(result[2].id === '2.1', 'first feature of claim 2 is 2.1');
  assert(result[3].id === '2.2', 'second feature of claim 2 is 2.2');
  assert(result[4].id === '2.3', 'third feature of claim 2 is 2.3');
  // Original features should not be mutated
  assert(features[0].id === undefined, 'original not mutated');
}

{
  const result = renumber([]);
  assert(result.length === 0, 'empty input returns empty');
}

{
  const result = renumber(null);
  assert(result.length === 0, 'null input returns empty');
}

// ============================================================================
console.log('\n--- dependencyContext ---');

{
  const table = {
    claims: [
      { num: 1, type: 'independent', dependsOn: [] },
      { num: 2, type: 'dependent', dependsOn: [1] },
    ],
    features: [
      { id: '1.1', claim: 1, type: 'independent', dependsOn: [], text: 'A device' },
      { id: '1.2', claim: 1, type: 'independent', dependsOn: [], text: 'with a processor' },
      { id: '2.1', claim: 2, type: 'dependent', dependsOn: [1], text: 'multi-core processor' },
    ],
  };

  const indCtx = dependencyContext(table.features[0], table);
  assert(indCtx === '', 'independent feature has no dependency context');

  const depCtx = dependencyContext(table.features[2], table);
  assert(depCtx.includes('[1.1]'), 'dependent feature inherits 1.1');
  assert(depCtx.includes('[1.2]'), 'dependent feature inherits 1.2');
  assert(depCtx.includes('A device'), 'context includes feature text');
}

{
  // Transitive dependencies: claim 3 → claim 2 → claim 1
  const table = {
    claims: [
      { num: 1, type: 'independent', dependsOn: [] },
      { num: 2, type: 'dependent', dependsOn: [1] },
      { num: 3, type: 'dependent', dependsOn: [2] },
    ],
    features: [
      { id: '1.1', claim: 1, type: 'independent', dependsOn: [], text: 'base feature' },
      { id: '2.1', claim: 2, type: 'dependent', dependsOn: [1], text: 'mid feature' },
      { id: '3.1', claim: 3, type: 'dependent', dependsOn: [2], text: 'top feature' },
    ],
  };

  const ctx = dependencyContext(table.features[2], table);
  assert(ctx.includes('[1.1]'), 'transitive: claim 3 inherits from claim 1');
  assert(ctx.includes('[2.1]'), 'transitive: claim 3 inherits from claim 2');
}

// ============================================================================
console.log('\n--- validateTable ---');

{
  const table = {
    claims: [
      { num: 1, type: 'independent', dependsOn: [] },
    ],
    features: [
      { id: '1.1', claim: 1, type: 'independent', dependsOn: [], text: 'A device', portion: null, refSigns: [], category: 'product' },
    ],
  };
  const { ok, errors } = validateTable(table);
  assert(ok === true, 'valid table passes');
  assert(errors.length === 0, 'no errors for valid table');
}

{
  const { ok } = validateTable(null);
  assert(ok === false, 'null table fails');
}

{
  const table = {
    claims: [{ num: 1, type: 'independent', dependsOn: [] }],
    features: [
      { id: '1.1', claim: 1, type: 'independent', dependsOn: [], text: 'Feature A', portion: null, refSigns: [] },
      { id: '1.1', claim: 1, type: 'independent', dependsOn: [], text: 'Feature B', portion: null, refSigns: [] },
    ],
  };
  const { ok, errors } = validateTable(table);
  assert(ok === false, 'duplicate ids detected');
  assert(errors.some(e => e.includes('Duplicate')), 'error mentions duplicate');
}

{
  const table = {
    claims: [{ num: 1, type: 'independent', dependsOn: [] }],
    features: [
      { id: 'bad', claim: 1, type: 'independent', dependsOn: [], text: 'Feature', portion: null, refSigns: [] },
    ],
  };
  const { ok, errors } = validateTable(table);
  assert(ok === false, 'bad id pattern detected');
  assert(errors.some(e => e.includes('N.M')), 'error mentions N.M pattern');
}

{
  const table = {
    claims: [
      { num: 1, type: 'independent', dependsOn: [] },
      { num: 2, type: 'dependent', dependsOn: [1] },
    ],
    features: [
      { id: '1.1', claim: 1, type: 'independent', dependsOn: [], text: 'Base', portion: null, refSigns: [] },
      { id: '2.1', claim: 2, type: 'dependent', dependsOn: [1], text: 'Extension', portion: null, refSigns: [] },
    ],
  };
  const { ok } = validateTable(table);
  assert(ok === true, 'dependent claim with dependsOn is valid');
}

{
  const table = {
    claims: [{ num: 2, type: 'dependent', dependsOn: [] }],
    features: [
      { id: '2.1', claim: 2, type: 'dependent', dependsOn: [], text: 'Oops', portion: null, refSigns: [] },
    ],
  };
  const { ok, errors } = validateTable(table);
  assert(ok === false, 'dependent claim with empty dependsOn fails');
  assert(errors.some(e => e.includes('empty dependsOn')), 'error for empty dependsOn');
}

{
  // Feature referencing a claim not in claims list
  const table = {
    claims: [{ num: 1, type: 'independent', dependsOn: [] }],
    features: [
      { id: '5.1', claim: 5, type: 'independent', dependsOn: [], text: 'Orphan', portion: null, refSigns: [] },
    ],
  };
  const { ok, errors } = validateTable(table);
  assert(ok === false, 'orphan claim reference detected');
  assert(errors.some(e => e.includes('not in claims list')), 'error for orphan reference');
}

// ============================================================================
console.log('\n--- detectDependency ---');

{
  assert(deepEqual(detectDependency('The device according to claim 1, wherein...'), [1]),
    '"according to claim 1" → [1]');
  assert(deepEqual(detectDependency('A method of claim 3, further comprising...'), [3]),
    '"of claim 3" → [3]');
  assert(deepEqual(detectDependency('As claimed in claim 2, the widget also...'), [2]),
    '"as claimed in claim 2" → [2]');
  assert(deepEqual(detectDependency('An independent apparatus comprising a housing.'), []),
    'independent claim → []');
  assert(detectDependency('The device according to claims 1 or 2, wherein...').includes(1),
    '"claims 1 or 2" includes 1');
  assert(detectDependency('The device according to claims 1 or 2, wherein...').includes(2),
    '"claims 1 or 2" includes 2');
}

// ============================================================================
console.log('\n--- detectTwoPart ---');

{
  assert(detectTwoPart('A device comprising X, characterized in that it further comprises Y.') === true,
    '"characterized in that" → two-part');
  assert(detectTwoPart('A device characterized by having a special processor.') === true,
    '"characterized by" → two-part');
  assert(detectTwoPart('The improvement comprising a new heating element.') === true,
    '"the improvement comprising" → two-part');
  assert(detectTwoPart('A device comprising a processor and a memory.') === false,
    'no two-part phrase → false');
  assert(detectTwoPart('') === false, 'empty → false');
  assert(detectTwoPart(null) === false, 'null → false');
}

// ============================================================================
console.log('\n--- detectCategory ---');

{
  assert(detectCategory('A device for processing data') === 'product',
    '"device" → product');
  assert(detectCategory('A method of manufacturing a widget') === 'process',
    '"method" → process');
  assert(detectCategory('Use of compound X as a catalyst') === 'use',
    '"Use of" → use');
  assert(detectCategory('A system comprising multiple modules') === 'product',
    '"system" → product');
  assert(detectCategory('A process for treating wastewater') === 'process',
    '"process" → process');
  assert(detectCategory('') === null, 'empty → null');
  assert(detectCategory('Something vague') === null, 'ambiguous → null');
}

// ============================================================================
console.log('\n--- extractRefSigns ---');

{
  assert(deepEqual(extractRefSigns('a processor (10) connected to a memory (20)'), ['10', '20']),
    'extracts (10) and (20)');
  assert(deepEqual(extractRefSigns('a bracket (3a) and a flange (3b)'), ['3a', '3b']),
    'extracts alphanumeric ref signs');
  assert(deepEqual(extractRefSigns('no reference signs here'), []),
    'no ref signs → empty array');
  assert(deepEqual(extractRefSigns(''), []),
    'empty → empty array');
  // Deduplication
  assert(deepEqual(extractRefSigns('a widget (5) and another widget (5)'), ['5']),
    'deduplicates ref signs');
}

// ============================================================================
console.log('\n--- summarize (novelty logic) ---');

{
  // All independent features disclosed → X
  const table = {
    claims: [{ num: 1, type: 'independent', dependsOn: [] }],
    features: [
      { id: '1.1', claim: 1, type: 'independent', dependsOn: [], text: 'Feature A' },
      { id: '1.2', claim: 1, type: 'independent', dependsOn: [], text: 'Feature B' },
    ],
  };
  const cells = [
    { featureId: '1.1', verdict: 'Y', citations: [], explanation: '', status: 'done' },
    { featureId: '1.2', verdict: 'Y', citations: [], explanation: '', status: 'done' },
  ];
  const s = summarize(table, cells);
  assert(s.independentFullyDisclosed === true, 'all ind. Y → independentFullyDisclosed=true');
  assert(s.suggestedCategory === 'X', 'all ind. Y → X');
  assert(s.disclosedCount === 2, 'disclosedCount=2');
  assert(s.partialCount === 0, 'partialCount=0');
  assert(s.totalCount === 2, 'totalCount=2');
}

{
  // One independent feature not disclosed → not X
  const table = {
    claims: [{ num: 1, type: 'independent', dependsOn: [] }],
    features: [
      { id: '1.1', claim: 1, type: 'independent', dependsOn: [], text: 'Feature A' },
      { id: '1.2', claim: 1, type: 'independent', dependsOn: [], text: 'Feature B' },
    ],
  };
  const cells = [
    { featureId: '1.1', verdict: 'Y', citations: [], explanation: '', status: 'done' },
    { featureId: '1.2', verdict: 'N', citations: [], explanation: '', status: 'done' },
  ];
  const s = summarize(table, cells);
  assert(s.independentFullyDisclosed === false, 'one ind. N → not fully disclosed');
  assert(s.suggestedCategory !== 'X', 'not all ind. Y → not X');
}

{
  // Many features disclosed (>50%) but not all independent → Y
  const table = {
    claims: [
      { num: 1, type: 'independent', dependsOn: [] },
      { num: 2, type: 'dependent', dependsOn: [1] },
    ],
    features: [
      { id: '1.1', claim: 1, type: 'independent', dependsOn: [], text: 'F1' },
      { id: '1.2', claim: 1, type: 'independent', dependsOn: [], text: 'F2' },
      { id: '2.1', claim: 2, type: 'dependent', dependsOn: [1], text: 'F3' },
      { id: '2.2', claim: 2, type: 'dependent', dependsOn: [1], text: 'F4' },
    ],
  };
  const cells = [
    { featureId: '1.1', verdict: 'Y', citations: [], explanation: '', status: 'done' },
    { featureId: '1.2', verdict: 'N', citations: [], explanation: '', status: 'done' },
    { featureId: '2.1', verdict: 'Y', citations: [], explanation: '', status: 'done' },
    { featureId: '2.2', verdict: 'P', citations: [], explanation: '', status: 'done' },
  ];
  const s = summarize(table, cells);
  assert(s.suggestedCategory === 'Y', '>50% disclosed but not all ind. → Y');
  assert(s.disclosedCount === 2, '2 Y verdicts');
  assert(s.partialCount === 1, '1 P verdict');
}

{
  // Few features disclosed (<50%) → A
  const table = {
    claims: [{ num: 1, type: 'independent', dependsOn: [] }],
    features: [
      { id: '1.1', claim: 1, type: 'independent', dependsOn: [], text: 'F1' },
      { id: '1.2', claim: 1, type: 'independent', dependsOn: [], text: 'F2' },
      { id: '1.3', claim: 1, type: 'independent', dependsOn: [], text: 'F3' },
      { id: '1.4', claim: 1, type: 'independent', dependsOn: [], text: 'F4' },
    ],
  };
  const cells = [
    { featureId: '1.1', verdict: 'Y', citations: [], explanation: '', status: 'done' },
    { featureId: '1.2', verdict: 'N', citations: [], explanation: '', status: 'done' },
    { featureId: '1.3', verdict: 'N', citations: [], explanation: '', status: 'done' },
    { featureId: '1.4', verdict: 'N', citations: [], explanation: '', status: 'done' },
  ];
  const s = summarize(table, cells);
  assert(s.suggestedCategory === 'A', '<50% → A (background)');
}

{
  // Mixed: independent features all Y, plus some dependent → X
  const table = {
    claims: [
      { num: 1, type: 'independent', dependsOn: [] },
      { num: 2, type: 'dependent', dependsOn: [1] },
    ],
    features: [
      { id: '1.1', claim: 1, type: 'independent', dependsOn: [], text: 'F1' },
      { id: '1.2', claim: 1, type: 'independent', dependsOn: [], text: 'F2' },
      { id: '2.1', claim: 2, type: 'dependent', dependsOn: [1], text: 'F3' },
    ],
  };
  const cells = [
    { featureId: '1.1', verdict: 'Y', citations: [], explanation: '', status: 'done' },
    { featureId: '1.2', verdict: 'Y', citations: [], explanation: '', status: 'done' },
    { featureId: '2.1', verdict: 'N', citations: [], explanation: '', status: 'done' },
  ];
  const s = summarize(table, cells);
  assert(s.independentFullyDisclosed === true, 'all ind. Y even with dep. N → fully disclosed');
  assert(s.suggestedCategory === 'X', 'all ind. Y → X regardless of dependent verdicts');
}

{
  // Edge case: empty cells
  const table = {
    claims: [{ num: 1, type: 'independent', dependsOn: [] }],
    features: [{ id: '1.1', claim: 1, type: 'independent', dependsOn: [], text: 'F1' }],
  };
  const s = summarize(table, []);
  assert(s.suggestedCategory === 'A', 'no cells → A');
  assert(s.independentFullyDisclosed === false, 'no cells → not fully disclosed');
}

{
  // Edge case: null table
  const s = summarize(null, []);
  assert(s.suggestedCategory === 'A', 'null table → A');
}

{
  // P verdict on independent feature → not fully disclosed
  const table = {
    claims: [{ num: 1, type: 'independent', dependsOn: [] }],
    features: [
      { id: '1.1', claim: 1, type: 'independent', dependsOn: [], text: 'F1' },
      { id: '1.2', claim: 1, type: 'independent', dependsOn: [], text: 'F2' },
    ],
  };
  const cells = [
    { featureId: '1.1', verdict: 'Y', citations: [], explanation: '', status: 'done' },
    { featureId: '1.2', verdict: 'P', citations: [], explanation: '', status: 'done' },
  ];
  const s = summarize(table, cells);
  assert(s.independentFullyDisclosed === false, 'P on ind. feature → not fully disclosed');
  // But >50% disclosed+partial → Y
  assert(s.suggestedCategory === 'Y', 'P on ind. but >50% → Y');
}

// ============================================================================
// Summary
console.log(`\n========================================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`========================================\n`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests PASS.');
  process.exit(0);
}
