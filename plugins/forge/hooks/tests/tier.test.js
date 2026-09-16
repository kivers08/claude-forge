#!/usr/bin/env node
'use strict';
// Unit tests for lib/tier.js (D17). Standalone rather than a cases.json
// entry: cases.json/run.js black-box tests a *hook script* end to end over
// stdin/stdout; resolveTier() is a pure function with no hook payload of
// its own, so it is exercised directly here instead. Uses the same
// `fixtures/tiers/.claude/forge.json` a coordinator project would ship, via
// the real `lib/config.js` loader — not a hand-rolled config object — so
// this also catches a config-shape mismatch between the two modules.
const assert = require('assert');
const path = require('path');
const cfg = require('../lib/config');
const { resolveTier, DEFAULT_TIER } = require('../lib/tier');

const FIXTURE = path.join(__dirname, 'fixtures', 'tiers');
const { config } = cfg.load(FIXTURE);
assert(config.tiers, 'fixture forge.json must have a tiers block for these tests to mean anything');

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

t('no changed paths resolves to the default tier', () => {
  assert.strictEqual(resolveTier(config, []), DEFAULT_TIER);
  assert.strictEqual(resolveTier(config, undefined), DEFAULT_TIER);
});

t('no tiers config at all resolves to T2, never T0', () => {
  assert.strictEqual(resolveTier({}, ['docs/readme.md']), 'T2');
});

t('a path matching only T0 resolves to T0', () => {
  assert.strictEqual(resolveTier(config, ['docs/readme.md']), 'T0');
});

t('a path matching no tier pattern resolves to T2 (safe default)', () => {
  assert.strictEqual(resolveTier(config, ['src/app.js']), 'T2');
});

t('a path matching T3 resolves to T3', () => {
  assert.strictEqual(resolveTier(config, ['src/payments/checkout.js']), 'T3');
});

t('highest matching tier wins across multiple changed paths', () => {
  assert.strictEqual(
    resolveTier(config, ['docs/readme.md', 'src/payments/checkout.js']),
    'T3',
  );
  assert.strictEqual(
    resolveTier(config, ['docs/readme.md', '.claude/forge.json']),
    'T1',
  );
});

t('an unmatched path forces the default tier, not "no opinion"', () => {
  // Regression: the resolver used to scan tiers globally ("did ANY path match
  // this tier's globs"), so a path matching nothing contributed nothing and
  // docs + arbitrary source resolved to T0 — handing `gh pr merge --auto` the
  // marker-free fast path for unclassified code. Resolution is per path, then
  // the max across paths.
  assert.strictEqual(resolveTier(config, ['docs/readme.md', 'src/app.js']), 'T2');
  assert.strictEqual(resolveTier(config, ['.claude/forge.json', 'src/app.js']), 'T2');
  assert.strictEqual(resolveTier(config, ['docs/a.md', 'changelog.d/b.md']), 'T0');
  // A higher tier still wins over an unmatched path.
  assert.strictEqual(resolveTier(config, ['src/app.js', 'src/payments/x.js']), 'T3');
});

t('glob matching is real glob matching, not a prefix check', () => {
  assert.strictEqual(resolveTier(config, ['plugins/forge/hooks/guards/merge-gate.js']), 'T1');
  assert.strictEqual(resolveTier(config, ['plugins-forge/hooks/x.js']), 'T2');
});

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
