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

// Makes a fresh temp project dir with one file at `relPath` containing
// `content`, then runs the hook as if `toolName` had just written that file.
// Returns { status, stdout, dir, absPath }.
function run(toolName, relPath, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-redact-test-'));
  const absPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  if (content !== null) fs.writeFileSync(absPath, content, 'utf8');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-redact-data-'));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-redact-test-'));
  const relPath = '.claude/agent-memory/forge-implementer/x.md';
  const absPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, 'AKIAABCDEFGHIJKLMNOP\n', 'utf8');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-redact-data-'));
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-redact-data-'));
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

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
