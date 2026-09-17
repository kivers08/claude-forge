#!/usr/bin/env node
'use strict';
// Unit tests for lib/memory.js (D28, docs/plans/memory-v2.md unit 1, D28.3
// record schema — Anthropic-superset, single vocabulary).
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

// --- round-trip parse/serialize (D28.3 shape: name/description top-level,
// everything else under metadata:) --------------------------------------

t('round-trips a full schema record byte-for-byte (metadata block)', () => {
  const src = [
    '---',
    'name: sample-lesson',
    'description: a one-line relevance summary',
    'metadata:',
    '  type: feedback',
    '  scope: reviewer',
    '  id: abc-123',
    '  tier: semantic',
    '  importance: 0.7',
    '  created: "2026-09-16T00:00:00.000Z"',
    '  lastUsed: null',
    '  uses: 3',
    '  source: authored',
    '  supersedes: null',
    '---',
    '',
    'The body of the lesson.',
    'Second line.',
    '',
  ].join('\n');
  const parsed = mem.parseRecord(src);
  assert.strictEqual(parsed.malformed, false);
  assert.strictEqual(parsed.frontmatter.name, 'sample-lesson');
  assert.strictEqual(parsed.frontmatter.description, 'a one-line relevance summary');
  assert.strictEqual(parsed.frontmatter.metadata.type, 'feedback');
  assert.strictEqual(parsed.frontmatter.metadata.id, 'abc-123');
  assert.strictEqual(parsed.frontmatter.metadata.importance, 0.7);
  assert.strictEqual(parsed.frontmatter.metadata.uses, 3);
  assert.strictEqual(parsed.frontmatter.metadata.lastUsed, null);
  assert.ok(parsed.body.includes('The body of the lesson.'));
  const out = mem.serializeRecord(parsed);
  assert.strictEqual(out, src, `round-trip mismatch:\n---got---\n${out}\n---want---\n${src}`);
});

t('preserves unknown top-level frontmatter keys (migration losslessness)', () => {
  const src = [
    '---',
    'name: x1',
    'description: a description with: a colon',
    'metadata:',
    '  type: feedback',
    '  scope: implementer',
    '  id: x1-id',
    'legacyField: some-value',
    '---',
    '',
    'body here',
  ].join('\n');
  const parsed = mem.parseRecord(src);
  assert.strictEqual(parsed.extra.legacyField, 'some-value');
  assert.strictEqual(parsed.frontmatter.metadata.type, 'feedback');
  const out = mem.serializeRecord(parsed);
  const reparsed = mem.parseRecord(out);
  assert.strictEqual(reparsed.extra.legacyField, 'some-value');
  assert.strictEqual(reparsed.frontmatter.metadata.type, 'feedback');
  assert.ok(reparsed.body.includes('body here'));
});

t('unknown metadata sub-key is preserved and round-trips byte-stable', () => {
  const src = [
    '---',
    'name: n',
    'description: d',
    'metadata:',
    '  type: feedback',
    '  scope: reviewer',
    '  id: abc',
    '  customThing: 42',
    '---',
    '',
    'body',
  ].join('\n');
  const parsed = mem.parseRecord(src);
  assert.strictEqual(parsed.frontmatter.metadata.customThing, 42);
  const out = mem.serializeRecord(parsed);
  assert.strictEqual(out, src, `round-trip mismatch:\n---got---\n${out}\n---want---\n${src}`);
});

t('metadata block parse/serialize is byte-stable with all schema fields plus an extra top-level field', () => {
  const src = [
    '---',
    'name: n2',
    'description: d2',
    'metadata:',
    '  type: project',
    '  scope: coordinator',
    '  id: id-2',
    '  tier: working',
    '  importance: 0.2',
    '  created: "2026-01-01T00:00:00.000Z"',
    '  lastUsed: "2026-01-02T00:00:00.000Z"',
    '  uses: 1',
    '  source: ambient',
    '  supersedes: old-id',
    'extraTopLevel: hello',
    '---',
    '',
    'body text',
  ].join('\n');
  const parsed = mem.parseRecord(src);
  const out = mem.serializeRecord(parsed);
  assert.strictEqual(out, src, `round-trip mismatch:\n---got---\n${out}\n---want---\n${src}`);
});

// --- redaction of each secret kind ----------------------------------------

t('redacts a PEM private key block', () => {
  const s = 'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\nDEF==\n-----END RSA PRIVATE KEY-----\nafter';
  const { text, redactions } = mem.scrubSecrets(s);
  assert.ok(text.includes('[REDACTED:pem]'), text);
  assert.ok(!text.includes('MIIabc'));
  assert.ok(redactions.some((r) => r.kind === 'pem'));
});

t('redacts an ENCRYPTED PRIVATE KEY block (Copilot finding)', () => {
  const s = 'x\n-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIsecretbytes\n-----END ENCRYPTED PRIVATE KEY-----\ny';
  const { text, redactions } = mem.scrubSecrets(s);
  assert.ok(text.includes('[REDACTED:pem]'), text);
  assert.ok(!text.includes('MIIsecretbytes'), 'encrypted key body must not reach disk');
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
    name: 'w1', description: 'a note',
    metadata: { type: 'feedback', id: 'w1' },
    body: 'accidentally pasted GITHUB_TOKEN=ghp_' + 'z'.repeat(36),
    now: '2026-09-16T00:00:00.000Z',
  });
  const onDisk = fs.readFileSync(res.file, 'utf8');
  assert.ok(!/ghp_z{36}/.test(onDisk), 'secret must not reach disk');
  assert.ok(onDisk.includes('[REDACTED'), onDisk);
  assert.ok(res.redactions.length >= 1);
  fs.rmSync(root, { recursive: true, force: true });
});

t('writeRecord scrubs secrets nested in extra (not just body/name/description/metadata)', () => {
  const root = tmpRoot();
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    name: 'x1', description: 'a note',
    metadata: { type: 'feedback', id: 'x1' },
    body: 'clean',
    // extra carries migrated free-text non-schema fields — both are write
    // paths and must be scrubbed too.
    extra: {
      note: 'pasted AKIAIOSFODNN7EXAMPLE here',
      legacy: { nested: 'GITHUB_TOKEN=ghp_' + 'y'.repeat(36) },
    },
    now: '2026-09-16T00:00:00.000Z',
  });
  const onDisk = fs.readFileSync(res.file, 'utf8');
  assert.ok(!/AKIAIOSFODNN7EXAMPLE/.test(onDisk), 'extra.note secret must not reach disk');
  assert.ok(!/ghp_y{36}/.test(onDisk), 'nested extra secret must not reach disk');
  assert.ok(onDisk.includes('[REDACTED'), onDisk);
  assert.ok(res.redactions.length >= 2, 'both extra secrets reported as redactions');
  // The nested map must SURVIVE (scrubbed), not be thrown away — proves the
  // secret is absent because it was redacted, not because the whole object was
  // stringified to `[object Object]` and lost (regression guard for bug #1).
  assert.ok(onDisk.includes('legacy:'), 'nested legacy block survives');
  assert.ok(onDisk.includes('nested:'), 'nested child key survives');
  assert.ok(!onDisk.includes('[object Object]'), 'object must not be stringified away');
  fs.rmSync(root, { recursive: true, force: true });
});

t('round-trips a nested extra object AND an array (bug #1)', () => {
  const record = {
    frontmatter: { name: 'nest-1', description: 'd', metadata: { type: 'feedback', scope: 'reviewer', id: 'nest-1' } },
    extra: {
      legacy: { type: 'feedback', level: 3 },
      tags: ['alpha', 'beta', 'gamma'],
    },
    body: 'body text',
  };
  const out = mem.serializeRecord(record);
  // Objects/arrays must never degrade to [object Object] / a,b,c.
  assert.ok(!out.includes('[object Object]'), out);
  const reparsed = mem.parseRecord(out);
  // A one-level map round-trips into the block-form string parseRecord produces.
  assert.ok(String(reparsed.extra.legacy).includes('type: feedback'), out);
  assert.ok(String(reparsed.extra.legacy).includes('level: 3'), out);
  // The array round-trips into a block sequence string, items preserved.
  assert.ok(String(reparsed.extra.tags).includes('- alpha'), out);
  assert.ok(String(reparsed.extra.tags).includes('- gamma'), out);
  // And re-serializing is byte-stable (no data drift on a second pass).
  assert.strictEqual(mem.serializeRecord(reparsed), out, 're-serialize must be stable');
});

t('an indented line under a TYPED top-level scalar key is skipped, not appended (bug #2)', () => {
  const src = [
    '---',
    'name: sk-1',
    '  anything: here',   // stray indented line under a top-level scalar key
    'description: d',
    'metadata:',
    '  type: feedback',
    '  scope: reviewer',
    '  id: sk-1-id',
    '  supersedes: null',
    '---',
    'body',
  ].join('\n');
  const parsed = mem.parseRecord(src);
  // name must stay 'sk-1' (not become "sk-1\n  anything: here").
  assert.strictEqual(parsed.frontmatter.name, 'sk-1', JSON.stringify(parsed.frontmatter));
  // supersedes must stay null (not become truthy, which would trigger a bogus
  // archive on write).
  assert.strictEqual(parsed.frontmatter.metadata.supersedes, null, JSON.stringify(parsed.frontmatter));
});

t('writeRecord defaults the full schema on a minimal write (bug #3)', () => {
  const root = tmpRoot();
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'implementer',
    name: 'min-1', description: 'a minimal note',
    metadata: { type: 'feedback', id: 'min-1' },
    body: 'minimal',
    now: '2026-09-16T00:00:00.000Z',
  });
  const onDisk = fs.readFileSync(res.file, 'utf8');
  const fm = mem.parseRecord(onDisk).frontmatter;
  assert.strictEqual(fm.metadata.tier, 'semantic');
  assert.strictEqual(fm.metadata.importance, 0.5);
  assert.strictEqual(fm.metadata.lastUsed, null);
  assert.strictEqual(fm.metadata.uses, 0);
  assert.strictEqual(fm.metadata.source, 'authored');
  assert.strictEqual(fm.metadata.supersedes, null);
  assert.strictEqual(fm.metadata.created, '2026-09-16T00:00:00.000Z');
  fs.rmSync(root, { recursive: true, force: true });
});

t('scopeDir rejects path-traversal scope/plugin segments (security #4)', () => {
  const root = tmpRoot();
  assert.throws(() => mem.scopeDir(root, 'forge', '../evil'), /invalid plugin\/scope/);
  assert.throws(() => mem.scopeDir(root, 'forge', 'a/b'), /invalid plugin\/scope/);
  assert.throws(() => mem.scopeDir(root, 'forge', '..'), /invalid plugin\/scope/);
  assert.throws(() => mem.scopeDir(root, '../x', 'reviewer'), /invalid plugin\/scope/);
  // writeRecord must refuse a crafted scope (write-outside-repo primitive).
  assert.throws(() => mem.writeRecord({
    root, plugin: 'forge', scope: '../../../tmp/evil',
    name: 'e', description: 'd', metadata: { type: 'feedback', id: 'e' }, body: 'x',
    now: '2026-09-16T00:00:00.000Z',
  }), /invalid plugin\/scope/);
  // readScope fails OPEN (returns []) rather than throwing on a bad segment.
  assert.deepStrictEqual(mem.readScope(root, 'forge', '../evil'), []);
  // A legitimate scope still works.
  assert.ok(mem.scopeDir(root, 'forge', 'reviewer').endsWith('forge-reviewer'));
  fs.rmSync(root, { recursive: true, force: true });
});

t('writeRecord stamps the redaction caveat into a record that had a redaction (#5)', () => {
  const root = tmpRoot();
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    name: 'cav-1', description: 'd',
    metadata: { type: 'feedback', id: 'cav-1' },
    body: 'leaked AKIAIOSFODNN7EXAMPLE here',
    now: '2026-09-16T00:00:00.000Z',
  });
  const onDisk = fs.readFileSync(res.file, 'utf8');
  assert.ok(onDisk.includes('redacted: true'), onDisk);
  assert.ok(onDisk.includes('redactionCaveat:'), onDisk);
  assert.ok(onDisk.includes('safety-net'), onDisk);
  fs.rmSync(root, { recursive: true, force: true });
});

t('a clean record does NOT carry the redaction caveat (#5)', () => {
  const root = tmpRoot();
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    name: 'cav-2', description: 'd',
    metadata: { type: 'feedback', id: 'cav-2' },
    body: 'a perfectly ordinary lesson',
    now: '2026-09-16T00:00:00.000Z',
  });
  const onDisk = fs.readFileSync(res.file, 'utf8');
  assert.ok(!onDisk.includes('redacted: true'), onDisk);
  assert.ok(!onDisk.includes('redactionCaveat:'), onDisk);
  fs.rmSync(root, { recursive: true, force: true });
});

t('secret-assignment does not re-redact an already-redacted value (#8)', () => {
  // GITHUB_TOKEN= is matched first by github-token, then the broad
  // secret-assignment pattern must NOT overwrite the specific label.
  const { text, redactions } = mem.scrubSecrets('GITHUB_TOKEN=ghp_' + 'q'.repeat(36));
  assert.ok(text.includes('[REDACTED:github-token]'), text);
  assert.ok(!text.includes('[REDACTED:secret-assignment]'), 'must not double-redact: ' + text);
  // Exactly one secret -> exactly one redaction (trustworthy telemetry).
  assert.strictEqual(redactions.length, 1, JSON.stringify(redactions));
});

t('needsQuote flags YAML-special leading characters (#9)', () => {
  for (const v of ['- item', '[a]', '{a}', '&anchor', '*alias', '!tag', '|block', '>fold', '`tick', '@at', '%pct']) {
    const out = mem.serializeScalar(v);
    assert.ok(out.startsWith('"'), `expected ${JSON.stringify(v)} to be quoted, got ${out}`);
    // And it must round-trip back to the original.
    assert.strictEqual(mem.parseScalar(out), v, `round-trip failed for ${JSON.stringify(v)}`);
  }
});

t('validateFrontmatter rejects empty-string importance and uses (#10)', () => {
  const pImp = mem.validateFrontmatter({ name: 'n', description: 'd', metadata: { id: 'x', type: 'feedback', scope: 's', importance: '' } });
  assert.ok(pImp.some((p) => /importance/.test(p)), pImp.join(';'));
  const pUses = mem.validateFrontmatter({ name: 'n', description: 'd', metadata: { id: 'x', type: 'feedback', scope: 's', uses: '' } });
  assert.ok(pUses.some((p) => /uses/.test(p)), pUses.join(';'));
  // A bare `importance:` line parses to '' — a round-trip must be caught.
  const parsed = mem.parseRecord('---\nname: n\ndescription: d\nmetadata:\n  id: x\n  type: feedback\n  scope: s\n  importance:\n---\nb');
  assert.ok(mem.validateFrontmatter(parsed.frontmatter).some((p) => /importance/.test(p)));
});

t('writeRecord scrubs a secret in a string metadata value (#7)', () => {
  const root = tmpRoot();
  // Drive the metadata-string scrub loop (memory.js) directly: a secret
  // pasted into the `created` string schema field (emitted to disk, unconstrained
  // content) must be scrubbed like any other string write path, and counted.
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    name: 'fm-scrub-1', description: 'd',
    metadata: {
      type: 'feedback', id: 'fm-scrub-1',
      created: 'AKIAIOSFODNN7EXAMPLE',
    },
    body: 'clean',
  });
  const onDisk = fs.readFileSync(res.file, 'utf8');
  assert.ok(!/AKIAIOSFODNN7EXAMPLE/.test(onDisk), onDisk);
  assert.ok(onDisk.includes('created:'), 'created field emitted to disk');
  assert.ok(res.redactions.some((r) => r.kind === 'aws-access-key'), JSON.stringify(res.redactions));
  fs.rmSync(root, { recursive: true, force: true });
});

t('archive collision counter suffixes when the same id is superseded twice (#7)', () => {
  const root = tmpRoot();
  const write = (id, supersedes, body) => mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    name: id, description: 'd', metadata: { id, type: 'project', scope: 'reviewer', supersedes },
    body, now: '2026-09-16T00:00:00.000Z',
  });
  write('dup', null, 'v0');
  write('next-1', 'dup', 'v1');        // archives dup.md
  write('dup', null, 'v2');            // recreate the id
  const res = write('next-2', 'dup', 'v3'); // archives dup.md AGAIN -> suffix
  const dir = mem.scopeDir(root, 'forge', 'reviewer');
  const archived = fs.readdirSync(path.join(dir, mem.ARCHIVE_DIR)).sort();
  assert.ok(archived.includes('dup.md'), archived.join(','));
  assert.ok(archived.some((n) => /^dup\.\d+\.md$/.test(n)), 'expected a suffixed archive: ' + archived.join(','));
  assert.ok(res.archived, 'second supersede returned an archive path');
  fs.rmSync(root, { recursive: true, force: true });
});

t('parseScalar is a true inverse of serializeScalar for escaped quotes/backslashes', () => {
  // A value that both needs quoting (contains a colon) and contains a quote +
  // backslash — serialize must escape, parse must unescape, byte-stable.
  const original = 'he said: "a\\b"';
  const round = mem.parseRecord(mem.serializeRecord({
    frontmatter: { name: 'q1', description: 'd', metadata: { id: 'q1', type: 'feedback', scope: 'reviewer' } },
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
    name: 'old-1', description: 'd', metadata: { id: 'old-1', type: 'project', scope: 'reviewer' },
    body: 'original value',
    now: '2026-09-16T00:00:00.000Z',
  });
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    name: 'new-1', description: 'd', metadata: { id: 'new-1', type: 'project', scope: 'reviewer', supersedes: 'old-1' },
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
  const ids = live.map((r) => r.frontmatter.metadata.id).sort();
  assert.deepStrictEqual(ids, ['new-1'], `live ids: ${ids}`);
  fs.rmSync(root, { recursive: true, force: true });
});

t('archiving a non-existent supersedes id is not an error', () => {
  const root = tmpRoot();
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    name: 'n2', description: 'd', metadata: { id: 'n2', type: 'project', scope: 'reviewer', supersedes: 'never-existed' },
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
    name: 'r1', description: 'd', metadata: { id: 'r1', type: 'feedback', scope: 'reviewer' },
    body: 'reviewer only', now: '2026-09-16T00:00:00.000Z',
  });
  mem.writeRecord({
    root, plugin: 'forge', scope: 'implementer',
    name: 'i1', description: 'd', metadata: { id: 'i1', type: 'feedback', scope: 'implementer' },
    body: 'implementer only', now: '2026-09-16T00:00:00.000Z',
  });
  const reviewer = mem.readScope(root, 'forge', 'reviewer');
  const impl = mem.readScope(root, 'forge', 'implementer');
  assert.deepStrictEqual(reviewer.map((r) => r.frontmatter.metadata.id), ['r1']);
  assert.deepStrictEqual(impl.map((r) => r.frontmatter.metadata.id), ['i1']);
  // A reviewer record must never be readable as an implementer record.
  assert.ok(!impl.some((r) => r.frontmatter.metadata.id === 'r1'), 'cross-scope leak!');
  fs.rmSync(root, { recursive: true, force: true });
});

t('readScope skips MEMORY.md (index, not a record)', () => {
  const root = tmpRoot();
  const dir = mem.scopeDir(root, 'forge', 'explorer');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '- [x](x.md) — index line\n');
  mem.writeRecord({
    root, plugin: 'forge', scope: 'explorer',
    name: 'e1', description: 'd', metadata: { id: 'e1', type: 'feedback', scope: 'explorer' },
    body: 'real record', now: '2026-09-16T00:00:00.000Z',
  });
  const recs = mem.readScope(root, 'forge', 'explorer');
  assert.deepStrictEqual(recs.map((r) => r.frontmatter.metadata.id), ['e1']);
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
  const parsed = mem.parseRecord('---\nname: x\ndescription: d\n(no closing fence)\n');
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
    name: 'ok1', description: 'd', metadata: { id: 'ok1', type: 'feedback', scope: 'doc-updater' },
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
    name: 'bad', description: 'd', metadata: { id: 'bad', type: 'goal', scope: 'implementer' },
    body: 'x', now: '2026-09-16T00:00:00.000Z',
  }), /metadata\.type must be one of/);
  fs.rmSync(root, { recursive: true, force: true });
});

t('validateFrontmatter rejects a type outside the new D28.3 vocabulary', () => {
  const problems = mem.validateFrontmatter({
    name: 'n', description: 'd',
    metadata: { id: 'x', type: 'lesson', scope: 's' }, // old vocabulary, no longer valid
  });
  assert.ok(problems.some((p) => /metadata\.type must be one of/.test(p)), problems.join(';'));
  // Every member of the new vocabulary is accepted.
  for (const type of mem.TYPES) {
    const ok = mem.validateFrontmatter({ name: 'n', description: 'd', metadata: { id: 'x', type, scope: 's' } });
    assert.deepStrictEqual(ok, [], `type ${type} should be valid: ${ok.join(';')}`);
  }
});

t('validateFrontmatter rejects a missing name or description', () => {
  const noName = mem.validateFrontmatter({ description: 'd', metadata: { id: 'x', type: 'feedback', scope: 's' } });
  assert.ok(noName.some((p) => /missing name/.test(p)), noName.join(';'));
  const noDesc = mem.validateFrontmatter({ name: 'n', metadata: { id: 'x', type: 'feedback', scope: 's' } });
  assert.ok(noDesc.some((p) => /missing description/.test(p)), noDesc.join(';'));
  const emptyName = mem.validateFrontmatter({ name: '', description: 'd', metadata: { id: 'x', type: 'feedback', scope: 's' } });
  assert.ok(emptyName.some((p) => /missing name/.test(p)), emptyName.join(';'));
});

t('validateFrontmatter rejects a missing metadata object', () => {
  const problems = mem.validateFrontmatter({ name: 'n', description: 'd' });
  assert.ok(problems.some((p) => /missing metadata/.test(p)), problems.join(';'));
});

t('writeRecord refuses a missing id (hook-safety contract)', () => {
  const root = tmpRoot();
  assert.throws(() => mem.writeRecord({
    root, plugin: 'forge', scope: 'implementer',
    name: 'n', description: 'd', metadata: { type: 'feedback', scope: 'implementer' },
    body: 'x', now: '2026-09-16T00:00:00.000Z',
  }), /metadata\.id is required/);
  fs.rmSync(root, { recursive: true, force: true });
});

t('validateFrontmatter flags out-of-range importance', () => {
  const problems = mem.validateFrontmatter({ name: 'n', description: 'd', metadata: { id: 'x', type: 'feedback', scope: 's', importance: 5 } });
  assert.ok(problems.some((p) => /importance/.test(p)), problems.join(';'));
});

// --- newId ----------------------------------------------------------------

t('newId returns a supplied id verbatim and generates a uuid otherwise', () => {
  assert.strictEqual(mem.newId('caller-supplied'), 'caller-supplied');
  const gen = mem.newId();
  assert.match(gen, /^[0-9a-f-]{36}$/, gen);
});

// --- migration script (temp fixture only, never the repo's real files) -----

const migrate = require('../../../../scripts/migrate-agent-memory');

t('migrateFile stamps the schema, is idempotent, and never touches real files (#7)', () => {
  const root = tmpRoot();
  const dir = path.join(root, 'forge-implementer');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sample.md');
  fs.writeFileSync(file, [
    '---',
    'name: sample',
    'description: a pre-existing record',
    'metadata:',
    '  type: feedback',
    '---',
    '',
    'Original body content.',
  ].join('\n'));

  const first = migrate.migrateFile(file, 'forge', 'implementer', false);
  assert.strictEqual(first.action, 'migrate');
  const afterFirst = fs.readFileSync(file, 'utf8');
  const fm = mem.parseRecord(afterFirst).frontmatter;
  assert.ok(fm.metadata.id, 'id stamped');
  assert.strictEqual(fm.metadata.tier, 'semantic');
  assert.strictEqual(fm.metadata.type, 'feedback', 'metadata type:feedback carried through per D28.3 mapping');
  // pre-existing frontmatter + body preserved
  assert.ok(afterFirst.includes('name: sample'), afterFirst);
  assert.ok(afterFirst.includes('description: a pre-existing record'), afterFirst);
  assert.ok(afterFirst.includes('Original body content.'), afterFirst);

  // Re-run: a file that already has a metadata.id is a no-op, bytes identical.
  const second = migrate.migrateFile(file, 'forge', 'implementer', false);
  assert.strictEqual(second.action, 'skip');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), afterFirst, 're-run must not churn');
  fs.rmSync(root, { recursive: true, force: true });
});

t('migrateFile scrubs a secret in an already-committed file (#6)', () => {
  const root = tmpRoot();
  const dir = path.join(root, 'forge-reviewer');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'leaky.md');
  fs.writeFileSync(file, [
    '---',
    'name: leaky',
    'description: has a secret AKIAIOSFODNN7EXAMPLE inline',
    '---',
    '',
    'body with GITHUB_TOKEN=ghp_' + 'w'.repeat(36),
  ].join('\n'));

  const res = migrate.migrateFile(file, 'forge', 'reviewer', false);
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.ok(!/AKIAIOSFODNN7EXAMPLE/.test(onDisk), 'extra secret scrubbed: ' + onDisk);
  assert.ok(!/ghp_w{36}/.test(onDisk), 'body secret scrubbed: ' + onDisk);
  assert.ok(onDisk.includes('[REDACTED'), onDisk);
  assert.ok(res.redactions >= 2, 'both secrets reported: ' + res.redactions);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- Copilot finding #1: non-injective record filename (data loss) --------

t('writeRecord throws on an unsafe id instead of colliding (Copilot #1)', () => {
  const root = tmpRoot();
  // 'a/b' would otherwise sanitize to 'a-b.md' and collide with the literal
  // id 'a-b' — reject it instead of silently mangling it.
  assert.throws(() => mem.writeRecord({
    root, plugin: 'forge', scope: 'implementer',
    name: 'n', description: 'd', metadata: { id: 'a/b', type: 'feedback', scope: 'implementer' },
    body: 'x', now: '2026-09-16T00:00:00.000Z',
  }), /unsafe record id/);
  // The distinct, SAFE id 'a-b' must write cleanly and not be affected.
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'implementer',
    name: 'n', description: 'd', metadata: { id: 'a-b', type: 'feedback', scope: 'implementer' },
    body: 'safe write', now: '2026-09-16T00:00:00.000Z',
  });
  assert.ok(fs.existsSync(res.file));
  assert.ok(fs.readFileSync(res.file, 'utf8').includes('safe write'));
  fs.rmSync(root, { recursive: true, force: true });
});

t('writeRecord still accepts a normal UUID id (happy path unaffected)', () => {
  const root = tmpRoot();
  const id = mem.newId();
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'implementer',
    name: 'n', description: 'd', metadata: { id, type: 'feedback', scope: 'implementer' },
    body: 'uuid record', now: '2026-09-16T00:00:00.000Z',
  });
  assert.ok(fs.existsSync(res.file));
  assert.strictEqual(path.basename(res.file), `${id}.md`);
  fs.rmSync(root, { recursive: true, force: true });
});

t('writeRecord throws on an id ending in .md (ambiguous with recordFileName)', () => {
  const root = tmpRoot();
  assert.throws(() => mem.writeRecord({
    root, plugin: 'forge', scope: 'implementer',
    name: 'n', description: 'd', metadata: { id: 'record.md', type: 'feedback', scope: 'implementer' },
    body: 'x', now: '2026-09-16T00:00:00.000Z',
  }), /unsafe record id/);
  fs.rmSync(root, { recursive: true, force: true });
});

t('isSafeId is exported and rejects/accepts as documented', () => {
  assert.strictEqual(mem.isSafeId('a-b'), true);
  assert.strictEqual(mem.isSafeId('a/b'), false);
  assert.strictEqual(mem.isSafeId('.'), false);
  assert.strictEqual(mem.isSafeId('..'), false);
  assert.strictEqual(mem.isSafeId('x.md'), false);
  assert.strictEqual(mem.isSafeId(mem.newId()), true);
});

// --- Copilot finding #2: non-atomic write (durability / data loss) --------

t('a normal upsert still produces byte-identical on-disk content', () => {
  const root = tmpRoot();
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'implementer',
    name: 'n', description: 'd', metadata: { id: 'atomic-1', type: 'feedback', scope: 'implementer' },
    body: 'stable body', now: '2026-09-16T00:00:00.000Z',
  });
  const onDisk = fs.readFileSync(res.file, 'utf8');
  const reparsed = mem.parseRecord(onDisk);
  const expected = mem.serializeRecord(reparsed);
  assert.strictEqual(onDisk, expected, 'on-disk bytes must equal a re-serialize of themselves');
  fs.rmSync(root, { recursive: true, force: true });
});

t('after a successful upsert no .tmp-* file remains in the scope dir', () => {
  const root = tmpRoot();
  mem.writeRecord({
    root, plugin: 'forge', scope: 'implementer',
    name: 'n', description: 'd', metadata: { id: 'atomic-2', type: 'feedback', scope: 'implementer' },
    body: 'v1', now: '2026-09-16T00:00:00.000Z',
  });
  // Overwrite the same id (upsert) to exercise the tmp-write+rename path twice.
  mem.writeRecord({
    root, plugin: 'forge', scope: 'implementer',
    name: 'n', description: 'd', metadata: { id: 'atomic-2', type: 'feedback', scope: 'implementer' },
    body: 'v2', now: '2026-09-16T01:00:00.000Z',
  });
  const dir = mem.scopeDir(root, 'forge', 'implementer');
  const names = fs.readdirSync(dir);
  assert.ok(!names.some((n) => n.includes('.tmp-')), `leftover tmp file: ${names.join(',')}`);
  const onDisk = fs.readFileSync(path.join(dir, 'atomic-2.md'), 'utf8');
  assert.ok(onDisk.includes('v2'), 'overwrite replaced content correctly');
  assert.ok(!onDisk.includes('v1'), 'old content must not linger');
  fs.rmSync(root, { recursive: true, force: true });
});

t('overwriting an existing id replaces content correctly (no stale merge)', () => {
  const root = tmpRoot();
  const write = (body) => mem.writeRecord({
    root, plugin: 'forge', scope: 'implementer',
    name: 'n', description: 'd', metadata: { id: 'overwrite-1', type: 'feedback', scope: 'implementer' },
    body, now: '2026-09-16T00:00:00.000Z',
  });
  write('first content');
  const res = write('second content, much longer than the first to catch truncation bugs');
  const onDisk = fs.readFileSync(res.file, 'utf8');
  assert.ok(onDisk.includes('second content'), onDisk);
  assert.ok(!onDisk.includes('first content'), onDisk);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- Copilot finding #3: symlink containment (security) -------------------

t('writeRecord throws when the scope dir is a symlink escaping root', () => {
  const root = tmpRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mem-outside-'));
  const linkPath = path.join(root, 'forge-implementer');
  fs.symlinkSync(outside, linkPath, 'dir');
  try {
    assert.throws(() => mem.writeRecord({
      root, plugin: 'forge', scope: 'implementer',
      name: 'n', description: 'd', metadata: { id: 'esc-1', type: 'feedback', scope: 'implementer' },
      body: 'x', now: '2026-09-16T00:00:00.000Z',
    }), /escapes root/);
    // The outside dir must remain empty — nothing was written through the symlink.
    assert.deepStrictEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

t('a normal (non-symlinked) scope dir still writes fine', () => {
  const root = tmpRoot();
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'implementer',
    name: 'n', description: 'd', metadata: { id: 'normal-1', type: 'feedback', scope: 'implementer' },
    body: 'ordinary', now: '2026-09-16T00:00:00.000Z',
  });
  assert.ok(fs.existsSync(res.file));
  fs.rmSync(root, { recursive: true, force: true });
});

t('readScope on a symlinked scope dir returns [] rather than throwing', () => {
  const root = tmpRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mem-outside-'));
  // Plant a real record OUTSIDE root, reachable only via the symlink.
  fs.writeFileSync(path.join(outside, 'sneaky.md'), [
    '---',
    'name: sneaky',
    'description: d',
    'metadata:',
    '  id: sneaky',
    '  type: feedback',
    '  scope: reviewer',
    '---',
    '',
    'should not be surfaced',
  ].join('\n'));
  const linkPath = path.join(root, 'forge-reviewer');
  fs.symlinkSync(outside, linkPath, 'dir');
  try {
    assert.deepStrictEqual(mem.readScope(root, 'forge', 'reviewer'), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// --- forge:reviewer finding #1 (SECURITY): frontmatter injection via a
// multiline `extra` string, `description`, or `metadata` value ------------

t('a multiline extra value cannot forge a sibling id: line (frontmatter injection)', () => {
  const root = tmpRoot();
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    name: 'n', description: 'd', metadata: { id: 'inj-1', type: 'feedback', scope: 'reviewer' },
    body: 'clean body',
    extra: { note: 'hello\nid: evil' },
    now: '2026-09-16T00:00:00.000Z',
  });
  const onDisk = fs.readFileSync(res.file, 'utf8');
  const parsed = mem.parseRecord(onDisk);
  assert.strictEqual(parsed.frontmatter.metadata.id, 'inj-1', onDisk);
  assert.notStrictEqual(parsed.frontmatter.metadata.id, 'evil');
  assert.strictEqual(parsed.extra.note, 'hello\nid: evil', 'note must round-trip to its original value');
  fs.rmSync(root, { recursive: true, force: true });
});

t('a multiline extra value cannot plant an early --- fence (frontmatter injection)', () => {
  const root = tmpRoot();
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    name: 'n', description: 'd', metadata: { id: 'inj-2', type: 'feedback', scope: 'reviewer' },
    body: 'original body must survive',
    extra: { note: 'x\n---\nplanted body' },
    now: '2026-09-16T00:00:00.000Z',
  });
  const onDisk = fs.readFileSync(res.file, 'utf8');
  const parsed = mem.parseRecord(onDisk);
  assert.strictEqual(parsed.malformed, false, onDisk);
  assert.strictEqual(parsed.frontmatter.metadata.id, 'inj-2', onDisk);
  assert.strictEqual(parsed.extra.note, 'x\n---\nplanted body');
  assert.ok(parsed.body.includes('original body must survive'), onDisk);
  fs.rmSync(root, { recursive: true, force: true });
});

t('a multiline description value cannot forge a sibling id: line (frontmatter injection)', () => {
  const root = tmpRoot();
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    name: 'n', description: 'hello\nid: evil',
    metadata: { id: 'inj-3', type: 'feedback', scope: 'reviewer' },
    body: 'clean body',
    now: '2026-09-16T00:00:00.000Z',
  });
  const onDisk = fs.readFileSync(res.file, 'utf8');
  const parsed = mem.parseRecord(onDisk);
  assert.strictEqual(parsed.frontmatter.metadata.id, 'inj-3', onDisk);
  assert.strictEqual(parsed.frontmatter.description, 'hello\nid: evil');
  fs.rmSync(root, { recursive: true, force: true });
});

t('a multiline metadata value cannot plant an early --- fence (frontmatter injection)', () => {
  const root = tmpRoot();
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    name: 'n', description: 'd',
    metadata: { id: 'inj-4', type: 'feedback', scope: 'reviewer', created: 'x\n---\nplanted body' },
    body: 'original body must survive',
    now: '2026-09-16T00:00:00.000Z',
  });
  const onDisk = fs.readFileSync(res.file, 'utf8');
  const parsed = mem.parseRecord(onDisk);
  assert.strictEqual(parsed.malformed, false, onDisk);
  assert.strictEqual(parsed.frontmatter.metadata.id, 'inj-4', onDisk);
  assert.strictEqual(parsed.frontmatter.metadata.created, 'x\n---\nplanted body');
  assert.ok(parsed.body.includes('original body must survive'), onDisk);
  fs.rmSync(root, { recursive: true, force: true });
});

t('the existing indented metadata: block still round-trips byte-stable (safe verbatim shape unaffected)', () => {
  const src = [
    '---',
    'name: safe-block-1',
    'description: d',
    'metadata:',
    '  type: feedback',
    '  scope: reviewer',
    '  id: safe-block-1',
    '  level: 3',
    '---',
    '',
    'body here',
  ].join('\n');
  const parsed = mem.parseRecord(src);
  const out = mem.serializeRecord(parsed);
  assert.strictEqual(out, src, `round-trip mismatch:\n---got---\n${out}\n---want---\n${src}`);
});

// --- forge:reviewer finding #2 (BUG): id re-scrubbed after isSafeId -------

t('writeRecord does not scrub the id even when it matches a redaction shape (bug #2)', () => {
  const root = tmpRoot();
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    name: 'n', description: 'd', metadata: { id: 'sk-1-lessons-about-review', type: 'feedback', scope: 'reviewer' },
    body: 'clean',
    now: '2026-09-16T00:00:00.000Z',
  });
  assert.strictEqual(path.basename(res.file), 'sk-1-lessons-about-review.md', res.file);
  const onDisk = fs.readFileSync(res.file, 'utf8');
  assert.ok(onDisk.includes('id: sk-1-lessons-about-review'), onDisk);
  assert.ok(!onDisk.includes('[REDACTED'), onDisk);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- forge:reviewer finding (SECURITY, task 1): unvalidated supersedes -----

t('writeRecord throws on a path-traversal supersedes in frontmatter, moves nothing outside scope', () => {
  const root = tmpRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mem-outside-'));
  fs.writeFileSync(path.join(outside, 'passwd.md'), 'not a record, just a target file');
  try {
    assert.throws(() => mem.writeRecord({
      root, plugin: 'forge', scope: 'reviewer',
      name: 'n', description: 'd',
      metadata: {
        id: 'sup-1', type: 'feedback', scope: 'reviewer',
        supersedes: '../../../etc/passwd',
      },
      body: 'x', now: '2026-09-16T00:00:00.000Z',
    }), /unsafe supersedes id/);
    // Nothing must have been created/moved outside the scope dir.
    assert.deepStrictEqual(fs.readdirSync(outside), ['passwd.md']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

t('writeRecord throws on a path-traversal opts.supersedesId', () => {
  const root = tmpRoot();
  assert.throws(() => mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    name: 'n', description: 'd', metadata: { id: 'sup-2', type: 'feedback', scope: 'reviewer' },
    supersedesId: '../../evil',
    body: 'x', now: '2026-09-16T00:00:00.000Z',
  }), /unsafe supersedes id/);
  fs.rmSync(root, { recursive: true, force: true });
});

t('a normal supersede of a real in-scope id still archives correctly (regression)', () => {
  const root = tmpRoot();
  mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    name: 'n', description: 'd', metadata: { id: 'ok-old', type: 'project', scope: 'reviewer' },
    body: 'v0', now: '2026-09-16T00:00:00.000Z',
  });
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    name: 'n', description: 'd', metadata: { id: 'ok-new', type: 'project', scope: 'reviewer', supersedes: 'ok-old' },
    body: 'v1', now: '2026-09-16T01:00:00.000Z',
  });
  assert.ok(res.archived, 'expected an archive path');
  assert.ok(fs.existsSync(res.archived));
  fs.rmSync(root, { recursive: true, force: true });
});

// --- forge:reviewer finding (SECURITY, task 2): readScope follows symlinks -

t('readScope skips a symlinked record file pointing outside the scope dir', () => {
  const root = tmpRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mem-outside-'));
  const outsideFile = path.join(outside, 'external.md');
  fs.writeFileSync(outsideFile, [
    '---',
    'name: external',
    'description: d',
    'metadata:',
    '  id: external',
    '  type: feedback',
    '  scope: reviewer',
    '---',
    '',
    'external content, must not be surfaced',
  ].join('\n'));
  const res = mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    name: 'n', description: 'd', metadata: { id: 'real-1', type: 'feedback', scope: 'reviewer' },
    body: 'real record', now: '2026-09-16T00:00:00.000Z',
  });
  const dir = path.dirname(res.file);
  const linkPath = path.join(dir, 'linked.md');
  fs.symlinkSync(outsideFile, linkPath, 'file');
  try {
    const recs = mem.readScope(root, 'forge', 'reviewer');
    assert.deepStrictEqual(recs.map((r) => r.frontmatter.metadata.id), ['real-1'], JSON.stringify(recs.map((r) => r.frontmatter.metadata.id)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// --- forge:reviewer finding (BUG, task 3): parseScalar round-trip ----------

t('parseScalar preserves values that do not round-trip exactly as numbers', () => {
  assert.strictEqual(mem.parseScalar('007'), '007');
  assert.strictEqual(mem.parseScalar('0.50'), '0.50');
  // Still coerces the values that DO round-trip exactly.
  assert.strictEqual(mem.parseScalar('7'), 7);
  assert.strictEqual(mem.parseScalar('0.5'), 0.5);
});

t('a leading-zero frontmatter/extra value round-trips byte-stable', () => {
  // A bare (unquoted) '007' on disk is parsed as the string '007' (not the
  // number 7, which would lose the leading zero — see parseScalar). Once
  // parsed, re-serializing quotes it (needsQuote treats any numeric-looking
  // scalar as needing quotes so a re-parse can't misread it as a number) —
  // that quoted form is still the value '007', and IT round-trips byte-stable
  // from then on: parse -> serialize -> parse yields the same value forever.
  const src = [
    '---',
    'name: lz-1',
    'description: d',
    'metadata:',
    '  id: lz-1',
    '  type: feedback',
    '  scope: reviewer',
    'code: 007',
    '---',
    '',
    'body',
  ].join('\n');
  const parsed = mem.parseRecord(src);
  assert.strictEqual(parsed.extra.code, '007', JSON.stringify(parsed.extra));
  const out = mem.serializeRecord(parsed);
  const reparsed = mem.parseRecord(out);
  assert.strictEqual(reparsed.extra.code, '007', JSON.stringify(reparsed.extra));
  // From the quoted form onward, serialize/parse is exactly byte-stable.
  assert.strictEqual(mem.serializeRecord(reparsed), out);
});

t('a leading-zero metadata sub-value round-trips byte-stable', () => {
  const src = [
    '---',
    'name: lz-2',
    'description: d',
    'metadata:',
    '  id: lz-2',
    '  type: feedback',
    '  scope: reviewer',
    '  code: 007',
    '---',
    '',
    'body',
  ].join('\n');
  const parsed = mem.parseRecord(src);
  assert.strictEqual(parsed.frontmatter.metadata.code, '007', JSON.stringify(parsed.frontmatter.metadata));
  const out = mem.serializeRecord(parsed);
  const reparsed = mem.parseRecord(out);
  assert.strictEqual(reparsed.frontmatter.metadata.code, '007', JSON.stringify(reparsed.frontmatter.metadata));
  assert.strictEqual(mem.serializeRecord(reparsed), out);
});

// --- forge:reviewer finding (task 4): deterministic read order -------------

t('readScope returns records in sorted filename order', () => {
  const root = tmpRoot();
  mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    name: 'n', description: 'd', metadata: { id: 'zzz-last', type: 'feedback', scope: 'reviewer' },
    body: 'z', now: '2026-09-16T00:00:00.000Z',
  });
  mem.writeRecord({
    root, plugin: 'forge', scope: 'reviewer',
    name: 'n', description: 'd', metadata: { id: 'aaa-first', type: 'feedback', scope: 'reviewer' },
    body: 'a', now: '2026-09-16T00:00:00.000Z',
  });
  const recs = mem.readScope(root, 'forge', 'reviewer');
  assert.deepStrictEqual(recs.map((r) => r.frontmatter.metadata.id), ['aaa-first', 'zzz-last']);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- forge:reviewer finding (task 5): reject negative uses -----------------

t('validateFrontmatter rejects a negative uses count', () => {
  const problems = mem.validateFrontmatter({ name: 'n', description: 'd', metadata: { id: 'x', type: 'feedback', scope: 's', uses: -1 } });
  assert.ok(problems.some((p) => /metadata\.uses must be a non-negative integer/.test(p)), problems.join(';'));
  assert.deepStrictEqual(mem.validateFrontmatter({ name: 'n', description: 'd', metadata: { id: 'x', type: 'feedback', scope: 's', uses: 0 } }), []);
  assert.deepStrictEqual(mem.validateFrontmatter({ name: 'n', description: 'd', metadata: { id: 'x', type: 'feedback', scope: 's', uses: 3 } }), []);
});

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
