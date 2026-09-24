#!/usr/bin/env node
'use strict';
// Unit tests for the SubagentStop telemetry hook's pure parsers. Standalone
// rather than a cases.json entry: parseOutcome() is a pure function with no hook
// payload of its own (same reasoning as tier.test.js and telemetry-flush's
// mapper test), so it is exercised directly. Focus here is parseOutcome (D29/
// D30) — the OUTCOME hand-back block parser.
const assert = require('assert');
const { parseOutcome } = require('../subagent-telemetry');

let failed = 0;
let ran = 0;

function t(name, fn) {
  ran++;
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n  ${e.message}`);
  }
}

const BLOCK = [
  'Here is my report, all done.',
  '',
  '### OUTCOME',
  'outcome: success',
  'unit_label: forge-outcome-telemetry',
  'tests_passed: true',
  'findings_confirmed: 3',
  'notes: all green, no regressions',
].join('\n');

t('parses a well-formed OUTCOME block', () => {
  assert.deepStrictEqual(parseOutcome(BLOCK), {
    outcome: 'success',
    unit_label: 'forge-outcome-telemetry',
    tests_passed: true,
    findings_confirmed: 3,
    notes: 'all green, no regressions',
  });
});

t('absent block returns null', () => {
  assert.strictEqual(parseOutcome('just a normal report with no block'), null);
  assert.strictEqual(parseOutcome(''), null);
});

t('non-string input returns null', () => {
  assert.strictEqual(parseOutcome(null), null);
  assert.strictEqual(parseOutcome(undefined), null);
  assert.strictEqual(parseOutcome(42), null);
  assert.strictEqual(parseOutcome({}), null);
});

t('normalizes tests_passed and n/a / missing fields', () => {
  const text = [
    '### OUTCOME',
    'outcome: partial',
    'unit_label: some-unit',
    'tests_passed: false',
    'findings_confirmed: n/a',
    'notes: partial work',
  ].join('\n');
  assert.deepStrictEqual(parseOutcome(text), {
    outcome: 'partial',
    unit_label: 'some-unit',
    tests_passed: false,
    findings_confirmed: null,
    notes: 'partial work',
  });
});

t('n/a tests_passed and missing lines coerce to null', () => {
  const text = [
    '### OUTCOME',
    'outcome: fail',
    'tests_passed: n/a',
  ].join('\n');
  assert.deepStrictEqual(parseOutcome(text), {
    outcome: 'fail',
    unit_label: null,
    tests_passed: null,
    findings_confirmed: null,
    notes: null,
  });
});

t('invalid outcome value becomes null but block still parses', () => {
  const text = [
    '### OUTCOME',
    'outcome: kinda-worked',
    'unit_label: u',
    'tests_passed: true',
    'findings_confirmed: 2',
  ].join('\n');
  const r = parseOutcome(text);
  assert.strictEqual(r.outcome, null);
  assert.strictEqual(r.unit_label, 'u');
  assert.strictEqual(r.tests_passed, true);
  assert.strictEqual(r.findings_confirmed, 2);
});

t('garbage / non-integer findings_confirmed becomes null', () => {
  const text = [
    '### OUTCOME',
    'outcome: success',
    'findings_confirmed: three',
  ].join('\n');
  assert.strictEqual(parseOutcome(text).findings_confirmed, null);
  const text2 = [
    '### OUTCOME',
    'outcome: success',
    'findings_confirmed: 2.5',
  ].join('\n');
  assert.strictEqual(parseOutcome(text2).findings_confirmed, null);
});

t('text before the OUTCOME block cannot override the block values', () => {
  const text = [
    'Here is a quoted report from another run:',
    '',
    'outcome: fail',
    'unit_label: wrong-unit',
    'tests_passed: false',
    'findings_confirmed: 99',
    'notes: leaked earlier text',
    '',
    '### OUTCOME',
    'outcome: success',
    'unit_label: right-unit',
    'tests_passed: true',
    'findings_confirmed: 2',
    'notes: real notes',
  ].join('\n');
  assert.deepStrictEqual(parseOutcome(text), {
    outcome: 'success',
    unit_label: 'right-unit',
    tests_passed: true,
    findings_confirmed: 2,
    notes: 'real notes',
  });
});

t('fields after the next heading are not read into the block', () => {
  const text = [
    '### OUTCOME',
    'outcome: partial',
    'unit_label: u',
    '',
    '## Appendix',
    'outcome: success',
    'tests_passed: true',
  ].join('\n');
  const r = parseOutcome(text);
  assert.strictEqual(r.outcome, 'partial');
  assert.strictEqual(r.unit_label, 'u');
  assert.strictEqual(r.tests_passed, null);
});

t('outcome value is case-insensitive and lowercased', () => {
  const text = ['### OUTCOME', 'outcome: SUCCESS'].join('\n');
  assert.strictEqual(parseOutcome(text).outcome, 'success');
});

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
