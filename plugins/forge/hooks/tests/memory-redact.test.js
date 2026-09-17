#!/usr/bin/env node
'use strict';
// Tests for hooks/memory-redact.js (D28.4): the PostToolUse hook that rescrubs
// any Write/Edit/MultiEdit target under .claude/agent-memory/**.
//
// Standalone rather than a cases.json entry: cases.json/run.js's `expect`
// assertions (fileExists/fileIncludes) only inspect CLAUDE_PLUGIN_DATA
// (telemetry), not the fixture's own working directory — and this hook's
// entire job is a side effect on a file IN that working directory. So this
// test spawns the hook script directly, the same way run.js does (payload on
// stdin, CLAUDE_PLUGIN_DATA via argv[2]), then asserts on the fixture file's
// bytes afterward.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'memory-redact.js');

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

// os.tmpdir() is itself behind a symlink on macOS (/tmp -> /private/tmp),
// and may be on Linux too (a symlinked /home, worktree parent, or checkout
// path). Realpath every fixture root up front so the suite actually
// exercises the hook's real containment/realpath logic on every platform,
// rather than happening to pass on Linux for the wrong reason (no symlink in
// the path to begin with) while silently not covering the bug the D28.4
// symlink fix and its follow-up fail-open regression fix are both about.
function mkRealTempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// Makes a fresh temp project dir with one file at `relPath` containing
// `content`, then runs the hook as if `toolName` had just written that file.
// Returns { status, stdout, dir, absPath }.
function run(toolName, relPath, content) {
  const dir = mkRealTempDir('memory-redact-test-');
  const absPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  if (content !== null) fs.writeFileSync(absPath, content, 'utf8');

  const dataDir = mkRealTempDir('memory-redact-data-');
  const payload = JSON.stringify({
    session_id: 'test-session',
    cwd: dir,
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: { file_path: absPath, content: 'x' },
    tool_response: { filePath: absPath, success: true },
  });

  const r = spawnSync(process.execPath, [HOOK, dataDir], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });

  return { status: r.status, stdout: r.stdout, stderr: r.stderr, dir, dataDir, absPath };
}

function readTelemetry(dataDir) {
  const file = path.join(dataDir, 'telemetry.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

t('AWS access key in an agent-memory .md file is scrubbed', () => {
  const before = 'leaked key AKIAABCDEFGHIJKLMNOP here\n';
  const r = run('Write', '.claude/agent-memory/forge-implementer/x.md', before);
  assert.strictEqual(r.status, 0);
  const after = fs.readFileSync(r.absPath, 'utf8');
  assert.ok(after.includes('[REDACTED:aws-access-key]'), after);
  assert.ok(!after.includes('AKIAABCDEFGHIJKLMNOP'), after);
});

t('GitHub token in an agent-memory .md file is scrubbed', () => {
  const before = 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked\n';
  const r = run('Write', '.claude/agent-memory/forge-implementer/x.md', before);
  assert.strictEqual(r.status, 0);
  const after = fs.readFileSync(r.absPath, 'utf8');
  assert.ok(after.includes('[REDACTED:github-token]'), after);
  assert.ok(!after.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), after);
});

t('a PEM private key block in an agent-memory .md file is scrubbed', () => {
  const before = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n';
  const r = run('Write', '.claude/agent-memory/forge-implementer/x.md', before);
  assert.strictEqual(r.status, 0);
  const after = fs.readFileSync(r.absPath, 'utf8');
  assert.ok(after.includes('[REDACTED:pem]'), after);
  assert.ok(!after.includes('MIIEpAIBAAKCAQEA'), after);
});

t('a FOO_SECRET= assignment in an agent-memory .md file is scrubbed', () => {
  const before = 'DEPLOY_SECRET=supersecretvalue123\n';
  const r = run('Write', '.claude/agent-memory/forge-implementer/x.md', before);
  assert.strictEqual(r.status, 0);
  const after = fs.readFileSync(r.absPath, 'utf8');
  assert.ok(after.includes('DEPLOY_SECRET=[REDACTED:secret-assignment]'), after);
  assert.ok(!after.includes('supersecretvalue123'), after);
});

t('a quoted FOO_SECRET= assignment preserves its surrounding quotes', () => {
  const before = 'FOO_SECRET="abc123def456"\n';
  const r = run('Write', '.claude/agent-memory/forge-implementer/x.md', before);
  assert.strictEqual(r.status, 0);
  const after = fs.readFileSync(r.absPath, 'utf8');
  assert.ok(after.includes('FOO_SECRET="[REDACTED:secret-assignment]"'), after);
  assert.ok(!after.includes('abc123def456'), after);
});

t('a single-quoted FOO_SECRET= assignment preserves its surrounding single quotes', () => {
  const before = "FOO_SECRET='abc123def456'\n";
  const r = run('Write', '.claude/agent-memory/forge-implementer/x.md', before);
  assert.strictEqual(r.status, 0);
  const after = fs.readFileSync(r.absPath, 'utf8');
  assert.ok(after.includes("FOO_SECRET='[REDACTED:secret-assignment]'"), after);
  assert.ok(!after.includes('abc123def456'), after);
});

t('prose using an identifier-shaped keyword is left byte-identical (github-token: rotated ...)', () => {
  const before = 'github-token: rotated last week\n';
  const r = run('Write', '.claude/agent-memory/forge-implementer/x.md', before);
  assert.strictEqual(r.status, 0);
  const after = fs.readFileSync(r.absPath, 'utf8');
  assert.strictEqual(after, before);
});

t('a clean agent-memory .md file is left byte-identical', () => {
  const before = '---\nname: clean\ndescription: nothing sensitive\n---\n\nJust plain notes.\n';
  const r = run('Write', '.claude/agent-memory/forge-implementer/clean.md', before);
  assert.strictEqual(r.status, 0);
  const after = fs.readFileSync(r.absPath, 'utf8');
  assert.strictEqual(after, before);
});

t('Edit tool target under agent-memory is also rescrubbed', () => {
  const before = 'AKIAABCDEFGHIJKLMNOP\n';
  const r = run('Edit', '.claude/agent-memory/forge-implementer/x.md', before);
  assert.strictEqual(r.status, 0);
  const after = fs.readFileSync(r.absPath, 'utf8');
  assert.ok(after.includes('[REDACTED:aws-access-key]'), after);
});

t('MultiEdit tool target under agent-memory is also rescrubbed', () => {
  const dir = mkRealTempDir('memory-redact-test-');
  const relPath = '.claude/agent-memory/forge-implementer/x.md';
  const absPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, 'AKIAABCDEFGHIJKLMNOP\n', 'utf8');
  const dataDir = mkRealTempDir('memory-redact-data-');
  const payload = JSON.stringify({
    session_id: 'test-session',
    cwd: dir,
    hook_event_name: 'PostToolUse',
    tool_name: 'MultiEdit',
    tool_input: { file_path: absPath, edits: [{ old_string: 'a', new_string: 'b' }] },
  });
  const r = spawnSync(process.execPath, [HOOK, dataDir], {
    input: payload, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });
  assert.strictEqual(r.status, 0);
  const after = fs.readFileSync(absPath, 'utf8');
  assert.ok(after.includes('[REDACTED:aws-access-key]'), after);
});

t('a local-scope agent-memory-local write is also scrubbed', () => {
  const before = 'leaked key AKIAABCDEFGHIJKLMNOP here\n';
  const r = run('Write', '.claude/agent-memory-local/forge-implementer/x.md', before);
  assert.strictEqual(r.status, 0);
  const after = fs.readFileSync(r.absPath, 'utf8');
  assert.ok(after.includes('[REDACTED:aws-access-key]'), after);
  assert.ok(!after.includes('AKIAABCDEFGHIJKLMNOP'), after);
});

t('a path.. traversal that resolves OUTSIDE agent-memory is ignored, not scrubbed', () => {
  // A relative path spelled to LOOK like it starts under .claude/agent-memory/
  // but that actually escapes it via `..` must not be treated as in-scope.
  const before = 'AKIAABCDEFGHIJKLMNOP\n';
  const dir = mkRealTempDir('memory-redact-test-');
  const relPath = 'notes/scratch.md';
  const absPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, before, 'utf8');
  const dataDir = mkRealTempDir('memory-redact-data-');
  // tool_input.file_path spelled as a traversal OUT of agent-memory into notes/.
  const traversal = '.claude/agent-memory/forge-implementer/../../../notes/scratch.md';
  const payload = JSON.stringify({
    session_id: 'test-session',
    cwd: dir,
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: traversal, content: 'x' },
  });
  const r = spawnSync(process.execPath, [HOOK, dataDir], {
    input: payload, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });
  assert.strictEqual(r.status, 0);
  const after = fs.readFileSync(absPath, 'utf8');
  assert.strictEqual(after, before, 'a path that resolves outside agent-memory must be left untouched');
});

t('a real agent-memory write reached via a redundant .. segment is still scrubbed', () => {
  // The mirror case: a path that legitimately resolves INSIDE agent-memory,
  // just spelled with a harmless .. detour, must still be scrubbed.
  const before = 'AKIAABCDEFGHIJKLMNOP\n';
  const dir = mkRealTempDir('memory-redact-test-');
  const relPath = '.claude/agent-memory/forge-implementer/x.md';
  const absPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, before, 'utf8');
  const dataDir = mkRealTempDir('memory-redact-data-');
  const spelled = '.claude/agent-memory/forge-implementer/../forge-implementer/x.md';
  const payload = JSON.stringify({
    session_id: 'test-session',
    cwd: dir,
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: spelled, content: 'x' },
  });
  const r = spawnSync(process.execPath, [HOOK, dataDir], {
    input: payload, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });
  assert.strictEqual(r.status, 0);
  const after = fs.readFileSync(absPath, 'utf8');
  assert.ok(after.includes('[REDACTED:aws-access-key]'), after);
});

t('a symlink inside agent-memory pointing OUTSIDE it is not read or rewritten', () => {
  // .claude/agent-memory/forge-x/note.md -> ../../../outside/secret.md, where
  // outside/ is NOT under any MEMORY_SUBDIR. path.resolve alone would see the
  // symlink's own (in-tree) path and pass containment; only resolving the
  // REAL target with fs.realpathSync catches that it points elsewhere.
  const dir = mkRealTempDir('memory-redact-test-');
  const outsideDir = path.join(dir, 'outside');
  fs.mkdirSync(outsideDir, { recursive: true });
  const externalFile = path.join(outsideDir, 'secret.md');
  const externalBefore = 'leaked key AKIAABCDEFGHIJKLMNOP here\n';
  fs.writeFileSync(externalFile, externalBefore, 'utf8');

  const linkDir = path.join(dir, '.claude', 'agent-memory', 'forge-x');
  fs.mkdirSync(linkDir, { recursive: true });
  const linkPath = path.join(linkDir, 'note.md');
  fs.symlinkSync(externalFile, linkPath);

  const dataDir = mkRealTempDir('memory-redact-data-');
  const payload = JSON.stringify({
    session_id: 'test-session',
    cwd: dir,
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: linkPath, content: 'x' },
  });
  const r = spawnSync(process.execPath, [HOOK, dataDir], {
    input: payload, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });
  assert.strictEqual(r.status, 0);
  const after = fs.readFileSync(externalFile, 'utf8');
  assert.strictEqual(after, externalBefore, 'a symlink escape must leave the external file byte-identical');
});

t('a file larger than the size guard is left untouched', () => {
  const dir = mkRealTempDir('memory-redact-test-');
  const relPath = '.claude/agent-memory/forge-implementer/big.md';
  const absPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const big = 'x'.repeat(512 * 1024 + 1) + '\nAKIAABCDEFGHIJKLMNOP\n';
  fs.writeFileSync(absPath, big, 'utf8');
  const dataDir = mkRealTempDir('memory-redact-data-');
  const payload = JSON.stringify({
    session_id: 'test-session',
    cwd: dir,
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: absPath, content: 'x' },
  });
  const r = spawnSync(process.execPath, [HOOK, dataDir], {
    input: payload, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });
  assert.strictEqual(r.status, 0);
  const after = fs.readFileSync(absPath, 'utf8');
  assert.strictEqual(after, big, 'a file over the size guard must be left byte-identical');
});

t('an oversize agent-memory file records a memory_redact_skipped telemetry event', () => {
  const dir = mkRealTempDir('memory-redact-test-');
  const relPath = '.claude/agent-memory/forge-implementer/big.md';
  const absPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const big = 'x'.repeat(65 * 1024) + '\nAKIAABCDEFGHIJKLMNOP\n';
  fs.writeFileSync(absPath, big, 'utf8');
  const dataDir = mkRealTempDir('memory-redact-data-');
  const payload = JSON.stringify({
    session_id: 'test-session',
    cwd: dir,
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: absPath, content: 'x' },
  });
  const r = spawnSync(process.execPath, [HOOK, dataDir], {
    input: payload, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });
  assert.strictEqual(r.status, 0);
  const after = fs.readFileSync(absPath, 'utf8');
  assert.strictEqual(after, big, 'an oversize file must still be left byte-identical');
  const records = readTelemetry(dataDir).filter((rec) => rec.event === 'memory_redact_skipped');
  assert.strictEqual(records.length, 1, JSON.stringify(records));
  assert.strictEqual(records[0].reason, 'size');
  assert.ok(records[0].bytes > 0, JSON.stringify(records[0]));
  assert.ok(records[0].file.endsWith('big.md'), JSON.stringify(records[0]));
  const raw = fs.readFileSync(path.join(dataDir, 'telemetry.jsonl'), 'utf8');
  assert.ok(!raw.includes('AKIAABCDEFGHIJKLMNOP'), 'telemetry must never contain file content');
});

t('a write OUTSIDE .claude/agent-memory/ is ignored', () => {
  const before = 'AKIAABCDEFGHIJKLMNOP\n';
  const r = run('Write', 'notes/scratch.md', before);
  assert.strictEqual(r.status, 0);
  const after = fs.readFileSync(r.absPath, 'utf8');
  assert.strictEqual(after, before);
});

t('a non-.md file under .claude/agent-memory/ is ignored', () => {
  const before = '{"secret": "AKIAABCDEFGHIJKLMNOP"}\n';
  const r = run('Write', '.claude/agent-memory/forge-implementer/x.json', before);
  assert.strictEqual(r.status, 0);
  const after = fs.readFileSync(r.absPath, 'utf8');
  assert.strictEqual(after, before);
});

t('a missing file fails open (no throw, exit 0)', () => {
  const r = run('Write', '.claude/agent-memory/forge-implementer/does-not-exist.md', null);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.existsSync(r.absPath), false);
});

t('a malformed stdin payload fails open (no throw, exit 0)', () => {
  const dataDir = mkRealTempDir('memory-redact-data-');
  const r = spawnSync(process.execPath, [HOOK, dataDir], {
    input: 'not json at all {{{',
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });
  assert.strictEqual(r.status, 0);
});

t('a tool other than Write/Edit/MultiEdit is ignored', () => {
  const before = 'AKIAABCDEFGHIJKLMNOP\n';
  const r = run('Read', '.claude/agent-memory/forge-implementer/x.md', before);
  assert.strictEqual(r.status, 0);
  const after = fs.readFileSync(r.absPath, 'utf8');
  assert.strictEqual(after, before);
});

t('a redaction is recorded in telemetry by kind, never the secret text', () => {
  const before = 'AKIAABCDEFGHIJKLMNOP\n';
  const r = run('Write', '.claude/agent-memory/forge-implementer/x.md', before);
  assert.strictEqual(r.status, 0);
  const records = readTelemetry(r.dataDir).filter((rec) => rec.event === 'memory_redacted');
  assert.strictEqual(records.length, 1, JSON.stringify(records));
  assert.strictEqual(records[0].kinds['aws-access-key'], 1);
  assert.strictEqual(records[0].total, 1);
  const raw = fs.readFileSync(path.join(r.dataDir, 'telemetry.jsonl'), 'utf8');
  assert.ok(!raw.includes('AKIAABCDEFGHIJKLMNOP'), 'telemetry must never contain the secret itself');
});

t('a project dir reached via a SYMLINKED path still gets its agent-memory file scrubbed (fail-open regression)', () => {
  // Regression for the realpath-mismatch bug: the hook used to realpath the
  // FILE (`real`) but re-check containment against the RAW, un-realpath'd
  // projectDir. If projectDir's path has a symlinked component — exactly
  // what happens here, and unconditionally on macOS (/tmp -> /private/tmp)
  // — `real` comes back fully resolved while the containment root doesn't,
  // path.relative(root, real) yields a spurious `../…`, containment reports
  // "outside", and the hook silently skips the scrub with no telemetry at
  // all. This test builds the project dir behind a symlink and asserts the
  // secret IS scrubbed; before the projectDir-realpath fix this failed.
  const realDir = mkRealTempDir('memory-redact-real-');
  const linkParent = mkRealTempDir('memory-redact-linkparent-');
  const symlinkedProjectDir = path.join(linkParent, 'project-via-symlink');
  fs.symlinkSync(realDir, symlinkedProjectDir, 'dir');

  const relPath = '.claude/agent-memory/forge-implementer/x.md';
  // Write the fixture file through the REAL path (as if it already existed
  // on disk from an earlier tool call) but tell the hook about it via the
  // SYMLINKED project dir, the way cfg.projectDir(payload) would surface a
  // symlinked CLAUDE_PROJECT_DIR/cwd in a real session.
  const realAbsPath = path.join(realDir, relPath);
  fs.mkdirSync(path.dirname(realAbsPath), { recursive: true });
  const before = 'leaked key AKIAABCDEFGHIJKLMNOP here\n';
  fs.writeFileSync(realAbsPath, before, 'utf8');

  const symlinkedAbsPath = path.join(symlinkedProjectDir, relPath);
  const dataDir = mkRealTempDir('memory-redact-data-');
  const payload = JSON.stringify({
    session_id: 'test-session',
    cwd: symlinkedProjectDir,
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: symlinkedAbsPath, content: 'x' },
  });
  const r = spawnSync(process.execPath, [HOOK, dataDir], {
    input: payload, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });
  assert.strictEqual(r.status, 0);
  const after = fs.readFileSync(realAbsPath, 'utf8');
  assert.ok(after.includes('[REDACTED:aws-access-key]'), after);
  assert.ok(!after.includes('AKIAABCDEFGHIJKLMNOP'), after);
});

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
