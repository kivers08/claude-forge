#!/usr/bin/env node
'use strict';
// Unit tests for the pure comparison in scripts/conflict/github-rules.js.
const { evaluate, FORGE_CHECKS } = require('../github-rules');

let failed = 0;
let ran = 0;
function test(name, fn) {
  ran++;
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n  ${e.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
const has = (r, text) => r.findings.some((f) => f.includes(text));

const GOOD_REPO = {
  allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, allow_auto_merge: true,
  squash_merge_commit_title: 'PR_TITLE', squash_merge_commit_message: 'PR_BODY',
};
const checks = (names, strict) => ({ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: !!strict, required_status_checks: names.map((context) => ({ context })) } });
const pr = (approvals, methods) => ({ type: 'pull_request', parameters: { required_approving_review_count: approvals, allowed_merge_methods: methods || ['squash'] } });
const GOOD_MAIN = [pr(0), checks(FORGE_CHECKS.main), { type: 'non_fast_forward' }, { type: 'deletion' }];
const GOOD_PARENT = [pr(0), checks(FORGE_CHECKS.parent)];

test('a repo matching the decisions has no findings', () => {
  const r = evaluate(GOOD_REPO, { main: GOOD_MAIN, parent: GOOD_PARENT, child: [] }, FORGE_CHECKS);
  assert(r.findings.length === 0, r.findings.join(' / '));
  assert(r.ok.includes('squash only'), 'squash only reported ok');
});

test('merge commits, wrong squash message and auto-merge off are reported', () => {
  const r = evaluate({ ...GOOD_REPO, allow_merge_commit: true, squash_merge_commit_message: 'COMMIT_MESSAGES', allow_auto_merge: false }, { main: GOOD_MAIN, parent: GOOD_PARENT }, FORGE_CHECKS);
  assert(has(r, 'merge commits') && has(r, 'Squash message') && has(r, 'auto-merge is off'), r.findings.join(' / '));
});

test('an approval requirement on main is reported as the solo-account blocker', () => {
  const r = evaluate(GOOD_REPO, { main: [pr(1), checks(FORGE_CHECKS.main), { type: 'non_fast_forward' }, { type: 'deletion' }], parent: GOOD_PARENT }, FORGE_CHECKS);
  assert(has(r, 'approving review'), r.findings.join(' / '));
});

test('missing named checks only when names are given; no checks at all always', () => {
  const main = [pr(0), checks(['validate']), { type: 'non_fast_forward' }, { type: 'deletion' }];
  assert(has(evaluate(GOOD_REPO, { main, parent: GOOD_PARENT }, FORGE_CHECKS), 'reviewer clean'), 'named check missing');
  assert(!has(evaluate(GOOD_REPO, { main, parent: GOOD_PARENT }), 'reviewer clean'), 'no names, no named finding');
  assert(has(evaluate(GOOD_REPO, { main: [pr(0)], parent: GOOD_PARENT }), 'requires no status checks'), 'empty checks always reported');
});

test('parent rules: missing, strict up-to-date, child PR rule', () => {
  assert(has(evaluate(GOOD_REPO, { main: GOOD_MAIN, parent: [] }), 'have no rules'), 'no parent rules');
  assert(has(evaluate(GOOD_REPO, { main: GOOD_MAIN, parent: [pr(0), checks(FORGE_CHECKS.parent, true)] }), 'up to date'), 'strict');
  assert(has(evaluate(GOOD_REPO, { main: GOOD_MAIN, parent: GOOD_PARENT, child: [pr(0)] }), 'Child branches'), 'child PR rule');
});

test('unreadable main is a finding, never a pass', () => {
  assert(has(evaluate(GOOD_REPO, { main: null, parent: GOOD_PARENT }), 'could not be read'), 'null main');
});

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
