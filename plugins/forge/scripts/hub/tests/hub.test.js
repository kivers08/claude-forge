#!/usr/bin/env node
'use strict';
// Unit tests for scripts/hub/hub.js. Builds throwaway repos in a temp dir and
// runs the CLI as a child process, the way CI and wrap-up run it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const hub = require('../hub');

const HUB = path.resolve(__dirname, '..', 'hub.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hub-tests-'));
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

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const LABELS = `---
id: labels
---
# Labels
## Standard
- merge: merging and branches
- ci: checks
- docs: documentation
## This repo
- process: how work is run
`;

const SPOKE = `---
id: decisions
---
# Decisions

## Log

### D-A | 2026-10-01 | process | First decision.
Body of A.

### D-B | 2026-10-03 | merge, ci | Children auto-merge when checks pass.
Body of B, with a code block:
\`\`\`
### not a heading inside a fence
\`\`\`

### D-C | 2026-10-03 | docs | Same date as B, written later.
Body of C.
`;

function repo(name, files, hubs) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'forge.json'), JSON.stringify({
    hubs: hubs || { labels: 'labels.md', files: [{ hub: 'docs/decisions-hub.md', spokes: ['docs/decisions.md'] }] },
  }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function run(dir, ...args) {
  return spawnSync(process.execPath, [HUB, ...args, '--root', dir], { encoding: 'utf8' });
}

test('parseLabels reads "- label: meaning" lines only', () => {
  const s = hub.parseLabels(LABELS);
  assert(s.has('merge') && s.has('process') && s.size === 4, `got ${[...s]}`);
});

test('parseSpoke finds entries and ignores headings inside code fences', () => {
  const r = hub.parseSpoke(SPOKE, 'docs/decisions.md');
  assert(r.problems.length === 0, r.problems.join('; '));
  assert(r.entries.map((e) => e.id).join() === 'D-A,D-B,D-C', r.entries.map((e) => e.id).join());
  assert(r.entries[1].labels.join() === 'merge,ci', 'labels split');
  assert(r.entries[1].body.join('\n').includes('not a heading inside a fence'), 'fenced line kept in body');
});

test('build writes a hub, newest first, later same-date entry first', () => {
  const dir = repo('build', { 'labels.md': LABELS, 'docs/decisions.md': SPOKE });
  const r = run(dir, 'build');
  assert(r.status === 0, r.stderr);
  const text = fs.readFileSync(path.join(dir, 'docs/decisions-hub.md'), 'utf8');
  const idx = text.split('## Index')[1].trim().split('\n');
  assert(idx[0] === '- 2026-10-03 | docs | Same date as B, written later. | docs/decisions.md#D-C', idx[0]);
  assert(idx[2].endsWith('#D-A'), idx[2]);
  assert(/^---\nid: decisions-hub\ndate: 2026-10-03\nstatus: generated/.test(text), 'yaml header');
  const again = run(dir, 'check');
  assert(again.status === 0, `check after build: ${again.stderr}`);
});

test('check fails when a spoke changed after the build', () => {
  const dir = repo('stale', { 'labels.md': LABELS, 'docs/decisions.md': SPOKE });
  run(dir, 'build');
  fs.appendFileSync(path.join(dir, 'docs/decisions.md'), '\n### D-D | 2026-10-04 | ci | New one.\n');
  const r = run(dir, 'check');
  assert(r.status === 1 && r.stderr.includes('out of date'), r.stderr);
});

test('check names a hub pointer whose entry ID was removed', () => {
  const dir = repo('broken', { 'labels.md': LABELS, 'docs/decisions.md': SPOKE });
  run(dir, 'build');
  const spoke = path.join(dir, 'docs/decisions.md');
  fs.writeFileSync(spoke, fs.readFileSync(spoke, 'utf8').replace('### D-A |', '### D-Z |'));
  const r = run(dir, 'check');
  assert(r.status === 1 && r.stderr.includes('points at docs/decisions.md#D-A'), r.stderr);
});

test('unknown label, too many labels, duplicate ID and bad heading are refused', () => {
  const bad = `${SPOKE}
### D-E | 2026-10-05 | marketing | Unknown label.
### D-F | 2026-10-05 | merge, ci, docs, process | Four labels.
### D-A | 2026-10-05 | merge | Duplicate ID.
### D-G 2026-10-05 merge no pipes
`;
  const dir = repo('bad', { 'labels.md': LABELS, 'docs/decisions.md': bad });
  const r = run(dir, 'build');
  assert(r.status === 1, `exit ${r.status}`);
  for (const want of ['label "marketing"', 'needs 1 to 3 labels', 'duplicate ID', 'entry heading must be']) {
    assert(r.stderr.includes(want), `missing "${want}" in: ${r.stderr}`);
  }
  assert(!fs.existsSync(path.join(dir, 'docs/decisions-hub.md')), 'a refused build writes nothing');
});

test('find prints whole entries for a label, newest first, with a limit', () => {
  const dir = repo('find', { 'labels.md': LABELS, 'docs/decisions.md': SPOKE });
  const r = run(dir, 'find', 'merge', 'process', '--limit', '1');
  assert(r.status === 0, r.stderr);
  assert(r.stdout.includes('### D-B') && r.stdout.includes('Body of B'), r.stdout);
  assert(!r.stdout.includes('### D-A'), 'limit 1 shows only the newest');
  assert(r.stdout.includes('1 of 2 matching entries'), r.stdout);
  const u = run(dir, 'find', 'nope');
  assert(u.status === 2 && u.stderr.includes('unknown label'), u.stderr);
});

test('missing config or labels file is a usage error (exit 2)', () => {
  const dir = path.join(tmp, 'empty');
  fs.mkdirSync(dir, { recursive: true });
  assert(run(dir, 'check').status === 2, 'no forge.json');
  const d2 = repo('nolabels', { 'docs/decisions.md': SPOKE });
  const r = run(d2, 'check');
  assert(r.status === 2 && r.stderr.includes('labels file'), r.stderr);
});

test('a hub path outside the repository is refused, nothing written', () => {
  const dir = repo('escape', { 'labels.md': LABELS, 'docs/decisions.md': SPOKE },
    { labels: 'labels.md', files: [{ hub: '../escaped-hub.md', spokes: ['docs/decisions.md'] }] });
  const r = run(dir, 'build');
  assert(r.status === 2 && r.stderr.includes('outside the repository'), r.stderr);
  assert(!fs.existsSync(path.join(tmp, 'escaped-hub.md')), 'nothing written outside');
});

test('a symlinked directory leading outside is refused', () => {
  const outside = path.join(tmp, 'outside-dir');
  fs.mkdirSync(outside, { recursive: true });
  const dir = repo('symlink', { 'labels.md': LABELS, 'docs/decisions.md': SPOKE },
    { labels: 'labels.md', files: [{ hub: 'out/hub.md', spokes: ['docs/decisions.md'] }] });
  fs.symlinkSync(outside, path.join(dir, 'out'));
  const r = run(dir, 'build');
  assert(r.status === 2 && r.stderr.includes('symlink'), r.stderr);
  assert(!fs.existsSync(path.join(outside, 'hub.md')), 'nothing written through the symlink');
});

test('an impossible calendar date is refused', () => {
  const dir = repo('baddate', { 'labels.md': LABELS, 'docs/decisions.md': `${SPOKE}\n### D-X | 2026-02-30 | ci | Not a real day.\n` });
  const r = run(dir, 'check');
  assert(r.status === 1 && r.stderr.includes('2026-02-30 is not a real date'), r.stderr);
});

test('find --hub searches only the named hub', () => {
  const dir = repo('two-hubs', {
    'labels.md': LABELS,
    'docs/decisions.md': SPOKE,
    'docs/lessons.md': '# Lessons\n### L-001 | 2026-10-05 | merge | A merge lesson.\nDetail.\n',
  }, { labels: 'labels.md', files: [
    { hub: 'docs/decisions-hub.md', spokes: ['docs/decisions.md'] },
    { hub: 'docs/lessons-hub.md', spokes: ['docs/lessons.md'] },
  ] });
  const all = run(dir, 'find', 'merge');
  assert(all.stdout.includes('L-001') && all.stdout.includes('D-B'), all.stdout);
  const only = run(dir, 'find', 'merge', '--hub', 'docs/decisions-hub.md');
  assert(only.status === 0 && !only.stdout.includes('L-001') && only.stdout.includes('D-B'), only.stdout + only.stderr);
  assert(run(dir, 'find', 'merge', '--hub', 'nope.md').status === 2, 'unknown hub');
});

test('an empty spoke builds a hub that stays checkable (no date drift)', () => {
  const dir = repo('empty-spoke', { 'labels.md': LABELS, 'docs/decisions.md': '# Decisions\n## Log\n' });
  assert(run(dir, 'build').status === 0, 'build');
  const text = fs.readFileSync(path.join(dir, 'docs/decisions-hub.md'), 'utf8');
  assert(!/^date:/m.test(text), 'no date line without entries');
  assert(run(dir, 'check').status === 0, 'check after build');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
