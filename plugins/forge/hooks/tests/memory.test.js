#!/usr/bin/env node
'use strict';
// Unit tests for lib/memory.js (D28, docs/plans/memory-v2.md unit 1).
// Standalone (like tier.test.js) rather than a cases.json entry: memory.js is a
// pure library, not a hook script driven over stdin/stdout, so it is exercised
// directly. Node stdlib only. Uses a per-run temp dir for filesystem cases so
// nothing touches the repo's real .claude/agent-memory.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mem = require('../lib/memory');

let failed = 0;
let ran = 0;

function t(name, fn) {
  ran++;
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n  ${e.stack || e.message}`);
  }
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mem-test-'));
}

// --- round-trip parse/serialize -------------------------------------------

t('round-trips a full schema record byte-for-byte', () => {
  const src = [
    '---',
    'id: abc-123',
    'type: lesson',
    'scope: reviewer',
    'tier: semantic',
    'importance: 0.7',
    'created: "2026-09-16T00:00:00.000Z"',
    'lastUsed: null',
    'uses: 3',
    'source: authored',
    'supersedes: null',
    '---',
    '',
    'The body of the lesson.',
    'Second line.',
    '',
  ].join('\n');
  const parsed = mem.parseRecord(src);
  assert.strictEqual(parsed.malformed, false);
  assert.strictEqual(parsed.frontmatter.id, 'abc-123');
  assert.strictEqual(parsed.frontmatter.type, 'lesson');
  assert.strictEqual(parsed.frontmatter.importance, 0.7);
  assert.strictEqual(parsed.frontmatter.uses, 3);
  assert.strictEqual(parsed.frontmatter.lastUsed, null);
  assert.ok(parsed.body.includes('The body of the lesson.'));
  const out = mem.serializeRecord(parsed);
  assert.strictEqual(out, src, `round-trip mismatch:\n---got---\n${out}\n---want---\n${src}`);
});

t('preserves unknown frontmatter keys (migration losslessness)', () => {
  const src = [
    '---',
    'id: x1',
    'type: note',
    'scope: implementer',
    'name: some-name',
    'description: a description with: a colon',
    'metadata:',
    '  type: feedback',
    '---',
    '',
    'body here',
  ].join('\n');
  const parsed = mem.parseRecord(src);
  assert.strictEqual(parsed.extra.name, 'some-name');
  assert.ok(String(parsed.extra.metadata).includes('type: feedback'), 'metadata block preserved');
  const out = mem.serializeRecord(parsed);
  const reparsed = mem.parseRecord(out);
  assert.strictEqual(reparsed.extra.name, 'some-name');
  assert.ok(String(reparsed.extra.metadata).includes('type: feedback'));
  assert.ok(reparsed.body.includes('body here'));
});

// --- redaction of each secret kind ----------------------------------------

t('redacts a PEM private key block', () => {
  const s = 'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\nDEF==\n-----END RSA PRIVATE KEY-----\nafter';
  const { text, redactions } = mem.scrubSecrets(s);
  assert.ok(text.includes('[REDACTED:pem]'), text);
  assert.ok(!text.includes('MIIabc'));
  assert.ok(redactions.some((r) => r.kind === 'pem'));
});

t('redacts an AWS access key id', () => {
  const { text } = mem.scrubSecrets('key AKIAIOSFODNN7EXAMPLE end');
  assert.ok(text.includes('[REDACTED:aws-access-key]'), text);
  assert.ok(!text.includes('AKIAIOSFODNN7EXAMPLE'));
});

t('redacts a GitHub token', () => {
  const tok = 'ghp_' + 'a'.repeat(36);
  // Bare token in prose (no `key=` prefix, which would match secret-assignment
  // first — that ordering is intentional and also redacts, just under a
  // different kind).
  const { text } = mem.scrubSecrets(`the value ${tok} was leaked`);
  assert.ok(text.includes('[REDACTED:github-token]'), text);
  assert.ok(!text.includes(tok));
});

t('redacts a Slack token', () => {
  const { text } = mem.scrubSecrets('xoxb-123456789012-abcdefghijkl');
  assert.ok(text.includes('[REDACTED:slack-token]'), text);
});

t('redacts an sk- api key', () => {
  const k = 'sk-ant-' + 'A1b2C3d4'.repeat(4);
  const { text } = mem.scrubSecrets(`OPENAI ${k}`);
  assert.ok(text.includes('[REDACTED:api-key]'), text);
  assert.ok(!text.includes(k));
});

t('redacts a Bearer token but keeps the Bearer keyword', () => {
  const { text } = mem.scrubSecrets('Authorization: Bearer abcDEF123456ghijklmnop');
  assert.ok(text.includes('Bearer [REDACTED:bearer-token]'), text);
});

t('redacts a *_SECRET= assignment but keeps the key name', () => {
  const { text } = mem.scrubSecrets('DB_SECRET=hunter2supersecret');
  assert.ok(/DB_SECRET\s*=\s*\[REDACTED:secret-assignment\]/.test(text), text);
  assert.ok(!text.includes('hunter2supersecret'));
});

t('leaves ordinary prose untouched', () => {
  const s = 'This is a normal lesson about running tests locally.';
  assert.strictEqual(mem.scrubSecrets(s).text, s);
});

// --- writeRecord scrubs before write --------------------------------------

t('writeRecord scrubs secrets in the body before persisting', () => {
  const root = tmpRoot();
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'implementer',
    frontmatter: { id: 'w1', type: 'note', scope: 'implementer' },
    body: 'accidentally pasted GITHUB_TOKEN=ghp_' + 'z'.repeat(36),
    now: '2026-09-16T00:00:00.000Z',
  });
  const onDisk = fs.readFileSync(res.file, 'utf8');
  assert.ok(!/ghp_z{36}/.test(onDisk), 'secret must not reach disk');
  assert.ok(onDisk.includes('[REDACTED'), onDisk);
  assert.ok(res.redactions.length >= 1);
  fs.rmSync(root, { recursive: true, force: true });
});

t('writeRecord scrubs secrets nested in extra (not just body/frontmatter)', () => {
  const root = tmpRoot();
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    frontmatter: { id: 'x1', type: 'note', scope: 'reviewer' },
    body: 'clean',
    // extra carries migrated free-text (description) and a nested block
    // (metadata) — both are write paths and must be scrubbed too.
    extra: {
      description: 'pasted AKIAIOSFODNN7EXAMPLE here',
      metadata: { nested: 'GITHUB_TOKEN=ghp_' + 'y'.repeat(36) },
    },
    now: '2026-09-16T00:00:00.000Z',
  });
  const onDisk = fs.readFileSync(res.file, 'utf8');
  assert.ok(!/AKIAIOSFODNN7EXAMPLE/.test(onDisk), 'extra.description secret must not reach disk');
  assert.ok(!/ghp_y{36}/.test(onDisk), 'nested extra secret must not reach disk');
  assert.ok(onDisk.includes('[REDACTED'), onDisk);
  assert.ok(res.redactions.length >= 2, 'both extra secrets reported as redactions');
  fs.rmSync(root, { recursive: true, force: true });
});

t('parseScalar is a true inverse of serializeScalar for escaped quotes/backslashes', () => {
  // A value that both needs quoting (contains a colon) and contains a quote +
  // backslash — serialize must escape, parse must unescape, byte-stable.
  const original = 'he said: "a\\b"';
  const round = mem.parseRecord(mem.serializeRecord({
    frontmatter: { id: 'q1', type: 'note', scope: 'reviewer' },
    extra: { note: original },
    body: '',
  }));
  assert.strictEqual(round.extra.note, original, 'escaped value must round-trip exactly');
});

// --- supersedes upsert-and-archive ----------------------------------------

t('supersedes archives the old record, keeps history, writes the new one', () => {
  const root = tmpRoot();
  mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    frontmatter: { id: 'old-1', type: 'fact', scope: 'reviewer' },
    body: 'original value',
    now: '2026-09-16T00:00:00.000Z',
  });
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    frontmatter: { id: 'new-1', type: 'fact', scope: 'reviewer', supersedes: 'old-1' },
    body: 'corrected value',
    now: '2026-09-16T01:00:00.000Z',
  });
  assert.ok(res.archived, 'expected an archive path');
  assert.ok(fs.existsSync(res.archived), 'archived file must exist (history kept)');
  const dir = mem.scopeDir(root, 'forge', 'reviewer');
  assert.ok(!fs.existsSync(path.join(dir, 'old-1.md')), 'old record moved out of live dir');
  assert.ok(fs.existsSync(path.join(dir, 'new-1.md')), 'new record present');
  // readScope must NOT surface the archived record.
  const live = mem.readScope(root, 'forge', 'reviewer');
  const ids = live.map((r) => r.frontmatter.id).sort();
  assert.deepStrictEqual(ids, ['new-1'], `live ids: ${ids}`);
  fs.rmSync(root, { recursive: true, force: true });
});

t('archiving a non-existent supersedes id is not an error', () => {
  const root = tmpRoot();
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    frontmatter: { id: 'n2', type: 'fact', scope: 'reviewer', supersedes: 'never-existed' },
    body: 'x',
    now: '2026-09-16T00:00:00.000Z',
  });
  assert.strictEqual(res.archived, null);
  assert.ok(fs.existsSync(res.file));
  fs.rmSync(root, { recursive: true, force: true });
});

// --- per-scope read isolation (D4, load-bearing) --------------------------

t('readScope reads exactly one scope, never a sibling scope', () => {
  const root = tmpRoot();
  mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    frontmatter: { id: 'r1', type: 'lesson', scope: 'reviewer' },
    body: 'reviewer only', now: '2026-09-16T00:00:00.000Z',
  });
  mem.writeRecord({
    root, plugin: 'forge', scope: 'implementer',
    frontmatter: { id: 'i1', type: 'lesson', scope: 'implementer' },
    body: 'implementer only', now: '2026-09-16T00:00:00.000Z',
  });
  const reviewer = mem.readScope(root, 'forge', 'reviewer');
  const impl = mem.readScope(root, 'forge', 'implementer');
  assert.deepStrictEqual(reviewer.map((r) => r.frontmatter.id), ['r1']);
  assert.deepStrictEqual(impl.map((r) => r.frontmatter.id), ['i1']);
  // A reviewer record must never be readable as an implementer record.
  assert.ok(!impl.some((r) => r.frontmatter.id === 'r1'), 'cross-scope leak!');
  fs.rmSync(root, { recursive: true, force: true });
});

t('readScope skips MEMORY.md (index, not a record)', () => {
  const root = tmpRoot();
  const dir = mem.scopeDir(root, 'forge', 'explorer');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '- [x](x.md) — index line\n');
  mem.writeRecord({
    root, plugin: 'forge', scope: 'explorer',
    frontmatter: { id: 'e1', type: 'note', scope: 'explorer' },
    body: 'real record', now: '2026-09-16T00:00:00.000Z',
  });
  const recs = mem.readScope(root, 'forge', 'explorer');
  assert.deepStrictEqual(recs.map((r) => r.frontmatter.id), ['e1']);
  fs.rmSync(root, { recursive: true, force: true });
});

t('readScope of a non-existent scope returns [] (fail open)', () => {
  const root = tmpRoot();
  assert.deepStrictEqual(mem.readScope(root, 'forge', 'nope'), []);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- malformed-record handling (fail safe, don't crash) -------------------

t('parseRecord on a file with no frontmatter returns it as body, malformed', () => {
  const parsed = mem.parseRecord('just some text\nno fence here');
  assert.strictEqual(parsed.malformed, true);
  assert.strictEqual(parsed.body, 'just some text\nno fence here');
  assert.deepStrictEqual(parsed.frontmatter, {});
});

t('parseRecord on unterminated frontmatter does not throw', () => {
  const parsed = mem.parseRecord('---\nid: x\ntype: note\n(no closing fence)\n');
  assert.strictEqual(parsed.malformed, true);
});

t('parseRecord on empty / null input does not throw', () => {
  assert.strictEqual(mem.parseRecord('').malformed, true);
  assert.strictEqual(mem.parseRecord(null).malformed, true);
  assert.strictEqual(mem.parseRecord(undefined).malformed, true);
});

t('readScope tolerates a malformed file among valid records', () => {
  const root = tmpRoot();
  const dir = mem.scopeDir(root, 'forge', 'doc-updater');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'broken.md'), 'not a record at all');
  mem.writeRecord({
    root, plugin: 'forge', scope: 'doc-updater',
    frontmatter: { id: 'ok1', type: 'note', scope: 'doc-updater' },
    body: 'fine', now: '2026-09-16T00:00:00.000Z',
  });
  const recs = mem.readScope(root, 'forge', 'doc-updater');
  assert.strictEqual(recs.length, 2, 'both files surfaced (one malformed)');
  assert.strictEqual(recs.filter((r) => r.malformed).length, 1);
  assert.strictEqual(recs.filter((r) => !r.malformed).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- validation & write refusal -------------------------------------------

t('writeRecord refuses an invalid type (throws)', () => {
  const root = tmpRoot();
  assert.throws(() => mem.writeRecord({
    root, plugin: 'forge', scope: 'implementer',
    frontmatter: { id: 'bad', type: 'goal', scope: 'implementer' },
    body: 'x', now: '2026-09-16T00:00:00.000Z',
  }), /type must be one of/);
  fs.rmSync(root, { recursive: true, force: true });
});

t('writeRecord refuses a missing id (hook-safety contract)', () => {
  const root = tmpRoot();
  assert.throws(() => mem.writeRecord({
    root, plugin: 'forge', scope: 'implementer',
    frontmatter: { type: 'note', scope: 'implementer' },
    body: 'x', now: '2026-09-16T00:00:00.000Z',
  }), /id is required/);
  fs.rmSync(root, { recursive: true, force: true });
});

t('validateFrontmatter flags out-of-range importance', () => {
  const problems = mem.validateFrontmatter({ id: 'x', type: 'note', scope: 's', importance: 5 });
  assert.ok(problems.some((p) => /importance/.test(p)), problems.join(';'));
});

// --- newId ----------------------------------------------------------------

t('newId returns a supplied id verbatim and generates a uuid otherwise', () => {
  assert.strictEqual(mem.newId('caller-supplied'), 'caller-supplied');
  const gen = mem.newId();
  assert.match(gen, /^[0-9a-f-]{36}$/, gen);
});

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
