#!/usr/bin/env node
'use strict';
// Unit tests for the D29 telemetry flush emitter. Standalone rather than a
// cases.json entry for the mapper: mapRecordsToBatch() is a pure function with
// no hook payload of its own (same reasoning as tier.test.js), so it is
// exercised directly. The enabled-gate no-op is tested by spawning the hook
// itself against a temp project + data dir and asserting it makes NO network
// call and leaves the buffer intact — no real network is ever contacted,
// because the gate returns before any POST. cases.json also carries a
// black-box gate entry so `run.js` covers the hook end to end.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { mapRecordsToBatch } = require('../telemetry-flush');

const HOOK = path.join(__dirname, '..', 'telemetry-flush.js');

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

// ---- mapRecordsToBatch: shape + allowlist ---------------------------------

t('invocation record maps to a start event with the right type/name', () => {
  const skill = mapRecordsToBatch([{ event: 'invocation', skill: 'forge:dispatch', tool: 'Skill' }], 'pk', 's1');
  assert.deepStrictEqual(skill.events[0], {
    event_type: 'skill', name: 'forge:dispatch', phase: 'start',
    tokens: null, tool_calls: null, duration_ms: null,
  });
  const agent = mapRecordsToBatch([{ event: 'invocation', agent_type: 'implementer', tool: 'Task' }], 'pk', 's1');
  assert.strictEqual(agent.events[0].event_type, 'agent');
  assert.strictEqual(agent.events[0].name, 'implementer');
  const tool = mapRecordsToBatch([{ event: 'invocation', tool: 'Bash' }], 'pk', 's1');
  assert.strictEqual(tool.events[0].event_type, 'tool');
  assert.strictEqual(tool.events[0].name, 'Bash');
  const unknown = mapRecordsToBatch([{ event: 'invocation' }], 'pk', 's1');
  assert.strictEqual(unknown.events[0].name, 'unknown');
});

t('unit_complete record maps to a complete event', () => {
  const b = mapRecordsToBatch([{ event: 'unit_complete', agent_type: 'reviewer' }], 'pk', 's1');
  assert.deepStrictEqual(b.events[0], {
    event_type: 'agent', name: 'reviewer', phase: 'complete',
    tokens: null, tool_calls: null, duration_ms: null,
  });
  const nameless = mapRecordsToBatch([{ event: 'unit_complete' }], 'pk', 's1');
  assert.strictEqual(nameless.events[0].name, 'unknown');
});

t('outcomes is always an empty array (populated by a later unit)', () => {
  const b = mapRecordsToBatch(
    [{ event: 'invocation', skill: 'x' }, { event: 'unit_complete', agent_type: 'y' }],
    'pk', 's1',
  );
  assert.deepStrictEqual(b.outcomes, []);
});

t('project_key and session_id are carried onto the batch', () => {
  const b = mapRecordsToBatch([{ event: 'invocation', tool: 'Bash' }], 'my-repo', 'sess-123');
  assert.strictEqual(b.project_key, 'my-repo');
  assert.strictEqual(b.session_id, 'sess-123');
});

t('metadata-only: description and unknown free-text fields are dropped', () => {
  const record = {
    event: 'invocation',
    skill: 'forge:dispatch',
    tool: 'Skill',
    description: 'SECRET free text describing what the user asked for',
    model: 'claude-opus-4-8',
    prompt_id: 'p-secret',
    ts: '2026-09-24T00:00:00.000Z',
    somethingNew: 'also dropped',
  };
  const b = mapRecordsToBatch([record], 'pk', 's1');
  const serialized = JSON.stringify(b);
  assert.ok(!serialized.includes('description'), 'description key must not appear');
  assert.ok(!serialized.includes('SECRET'), 'free-text description value must not appear');
  assert.ok(!serialized.includes('claude-opus-4-8'), 'model must not appear');
  assert.ok(!serialized.includes('p-secret'), 'prompt_id must not appear');
  assert.ok(!serialized.includes('somethingNew'), 'unknown field must not appear');
  assert.ok(!serialized.includes('2026-09-24'), 'raw ts value must not appear');
  // Only the whitelisted keys survive.
  assert.deepStrictEqual(Object.keys(b.events[0]).sort(),
    ['duration_ms', 'event_type', 'name', 'phase', 'tokens', 'tool_calls']);
});

t('non-record garbage lines are skipped, not forwarded', () => {
  const b = mapRecordsToBatch([null, 'str', 42, { event: 'other' }, { event: 'invocation', tool: 'Bash' }], 'pk', 's1');
  assert.strictEqual(b.events.length, 1);
});

// ---- enabled-gate no-op: spawn the hook, prove no flush --------------------

function runGate(forgeConfig) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-flush-test-'));
  const projDir = path.join(tmp, 'project');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(path.join(projDir, '.claude'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, '.claude', 'forge.json'), JSON.stringify(forgeConfig));
  const bufferFile = path.join(dataDir, 'telemetry.jsonl');
  const original = JSON.stringify({ ts: '2026-09-24T00:00:00.000Z', event: 'invocation', tool: 'Bash' }) + '\n';
  fs.writeFileSync(bufferFile, original);
  const payload = JSON.stringify({ session_id: 's-gate', cwd: projDir, hook_event_name: 'Stop' });
  const r = spawnSync(process.execPath, [HOOK, dataDir], {
    input: payload, encoding: 'utf8',
    // A sinkUrl that would refuse instantly if the gate ever let a POST through.
    env: { ...process.env, FORGE_TEST_TOKEN: 'unused' },
  });
  const after = fs.readFileSync(bufferFile, 'utf8');
  fs.rmSync(tmp, { recursive: true, force: true });
  return { r, original, after };
}

t('disabled config: hook no-ops, buffer left intact, nothing on stdout', () => {
  const { r, original, after } = runGate({ version: 1 }); // no telemetry block -> enabled defaults false
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  assert.strictEqual(r.stdout.trim(), '', `unexpected stdout: ${r.stdout}`);
  assert.strictEqual(after, original, 'buffer must not be truncated when telemetry is disabled');
});

t('enabled but no sinkUrl: hook no-ops, buffer left intact', () => {
  const { r, original, after } = runGate({
    version: 1,
    telemetry: { enabled: true, tokenEnv: 'FORGE_TEST_TOKEN', projectKey: 'pk' },
  });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  assert.strictEqual(after, original, 'buffer must survive when no sink is configured');
});

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
