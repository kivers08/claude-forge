#!/usr/bin/env node
'use strict';
// Unit tests for hooks/lib/github-read.js pure helpers (no network).
const assert = require('assert');
const g = require('../lib/github-read');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n  ${e.message}`);
  }
}

test('branchRequiresChecks needs a PR rule AND a non-empty check list', () => {
  const pr = { type: 'pull_request', parameters: {} };
  const checks = (n) => ({ type: 'required_status_checks', parameters: { required_status_checks: n.map((context) => ({ context })) } });
  assert.strictEqual(g.branchRequiresChecks([pr, checks(['validate'])]), true);
  assert.strictEqual(g.branchRequiresChecks([pr, checks([])]), false);
  assert.strictEqual(g.branchRequiresChecks([checks(['validate'])]), false);
  assert.strictEqual(g.branchRequiresChecks(null), false);
});

test('validSlug accepts owner/repo only', () => {
  assert.strictEqual(g.validSlug('kivers08/claude-forge'), true);
  for (const bad of ['a/b/c', 'a/b?x=1', '../x', 'a/..', '', null, 'onlyone']) assert.strictEqual(g.validSlug(bad), false, String(bad));
});

test('pullRequest and branchRules refuse a bad slug without any request', () => {
  assert.strictEqual(g.pullRequest('a/b/pulls', 7), null);
  assert.strictEqual(g.branchRules('a?b/c', 'main'), null);
});

console.log(failed ? `\n${failed} failed` : '\nall github-read tests passed');
process.exit(failed ? 1 : 0);
