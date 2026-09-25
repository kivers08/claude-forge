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
const {
  mapRecordsToBatch, retainUnsentLines, parseItems,
  groupBySession, chunkSessionItems, isAcceptedBody, postBatch,
} = require('../telemetry-flush');

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

t('unit_complete without an outcome object yields no outcome entry', () => {
  const b = mapRecordsToBatch(
    [{ event: 'invocation', skill: 'x' }, { event: 'unit_complete', agent_type: 'y' }],
    'pk', 's1',
  );
  assert.deepStrictEqual(b.outcomes, []);
  // A null outcome, or a garbage/unknown outcome value, also produces nothing.
  const b2 = mapRecordsToBatch([
    { event: 'unit_complete', agent_type: 'y', outcome: null },
    { event: 'unit_complete', agent_type: 'z', outcome: { outcome: 'bogus', unit_label: 'x' } },
  ], 'pk', 's1');
  assert.deepStrictEqual(b2.outcomes, []);
});

t('unit_complete with an outcome object maps to an outcomes[] entry', () => {
  const b = mapRecordsToBatch([{
    event: 'unit_complete',
    agent_type: 'implementer',
    outcome: {
      outcome: 'success',
      unit_label: 'forge-outcome-telemetry',
      tests_passed: true,
      findings_confirmed: 3,
      notes: 'all green',
    },
  }], 'pk', 's1');
  // The complete event is still emitted alongside the outcome.
  assert.strictEqual(b.events.length, 1);
  assert.strictEqual(b.events[0].phase, 'complete');
  assert.deepStrictEqual(b.outcomes[0], {
    unit_label: 'forge-outcome-telemetry',
    agent_name: 'implementer',
    outcome: 'success',
    findings_confirmed: 3,
    tests_passed: true,
  });
  // Free-text notes must NEVER be forwarded, even when present on the record.
  assert.ok(!('notes' in b.outcomes[0]), 'notes must not appear in outcomes[]');
  assert.ok(!JSON.stringify(b).includes('all green'), 'notes value must not appear anywhere in the batch');
});

t('outcome field coercion: tests_passed/findings/label/notes null-fallbacks', () => {
  const b = mapRecordsToBatch([{
    event: 'unit_complete',
    // no agent_type -> agent_name falls back to 'unknown'
    outcome: {
      outcome: 'fail',
      unit_label: null,
      tests_passed: false,
      findings_confirmed: null,
      notes: null,
    },
  }, {
    event: 'unit_complete',
    agent_type: 'bug-fixer',
    outcome: {
      outcome: 'partial',
      unit_label: 'p',
      tests_passed: 'n/a', // non-boolean -> null
      findings_confirmed: 0,
      notes: '',
    },
  }], 'pk', 's1');
  assert.deepStrictEqual(b.outcomes[0], {
    unit_label: null, agent_name: 'unknown', outcome: 'fail',
    findings_confirmed: null, tests_passed: false,
  });
  assert.deepStrictEqual(b.outcomes[1], {
    unit_label: 'p', agent_name: 'bug-fixer', outcome: 'partial',
    findings_confirmed: 0, tests_passed: null,
  });
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

// ---- retainUnsentLines: successful flush must not drop unsent records ------

t('retainUnsentLines drops the sent events (invocation, unit_complete)', () => {
  const raw = [
    JSON.stringify({ event: 'invocation', tool: 'Bash' }),
    JSON.stringify({ event: 'unit_complete', agent_type: 'x' }),
  ].join('\n') + '\n';
  assert.strictEqual(retainUnsentLines(raw), '');
});

t('retainUnsentLines keeps every non-sent D10 record verbatim', () => {
  const keepLines = [
    JSON.stringify({ event: 'session_start', session_id: 's1' }),
    JSON.stringify({ event: 'guard_deny', rule: 'r' }),
    JSON.stringify({ event: 'guard_remind' }),
    JSON.stringify({ event: 'rules_injected', n: 3 }),
    JSON.stringify({ event: 'memory-redaction' }),
  ];
  const raw = [
    JSON.stringify({ event: 'invocation', tool: 'Bash' }),
    keepLines[0],
    JSON.stringify({ event: 'unit_complete', agent_type: 'x' }),
    keepLines[1],
    keepLines[2],
    keepLines[3],
    keepLines[4],
  ].join('\n') + '\n';
  const kept = retainUnsentLines(raw);
  assert.strictEqual(kept, keepLines.join('\n') + '\n');
  // Original JSON preserved verbatim.
  for (const line of keepLines) assert.ok(kept.includes(line));
});

t('retainUnsentLines is safe on empty / null / garbage input', () => {
  assert.strictEqual(retainUnsentLines(''), '');
  assert.strictEqual(retainUnsentLines(null), '');
  assert.strictEqual(retainUnsentLines(undefined), '');
  assert.strictEqual(retainUnsentLines('   \n  \n'), '');
  // Unparseable lines are retained (we did not send them), never silently lost.
  const raw = 'not json\n' + JSON.stringify({ event: 'invocation' }) + '\n';
  assert.strictEqual(retainUnsentLines(raw), 'not json\n');
  // Records with no/unknown event are kept too.
  const raw2 = JSON.stringify({ event: 'other' }) + '\n' + JSON.stringify({ foo: 1 }) + '\n';
  assert.strictEqual(retainUnsentLines(raw2), raw2);
});

// ---- https gate: a plaintext http:// sink must be rejected -----------------

t('https gate: http:// sink is refused, buffer left intact', () => {
  const { r, original, after } = runGate({
    version: 1,
    telemetry: {
      enabled: true, sinkUrl: 'http://insecure.example/ingest',
      tokenEnv: 'FORGE_TEST_TOKEN', projectKey: 'pk',
    },
  });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  assert.strictEqual(after, original, 'buffer must survive when sink is not HTTPS');
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

// ---- isAcceptedBody: honor a 2xx {accepted:false} rejection ----------------

t('isAcceptedBody: 2xx with {accepted:false} is NOT success', () => {
  assert.strictEqual(isAcceptedBody(JSON.stringify({ accepted: false })), false);
  assert.strictEqual(isAcceptedBody('{"accepted":false,"reason":"backpressure"}'), false);
});

t('isAcceptedBody: empty / non-JSON / missing-field / accepted:true all count as success', () => {
  assert.strictEqual(isAcceptedBody(''), true);
  assert.strictEqual(isAcceptedBody('   '), true);
  assert.strictEqual(isAcceptedBody(null), true);
  assert.strictEqual(isAcceptedBody(undefined), true);
  assert.strictEqual(isAcceptedBody('OK'), true); // non-JSON body
  assert.strictEqual(isAcceptedBody('not json {'), true);
  assert.strictEqual(isAcceptedBody(JSON.stringify({ status: 'ok' })), true); // no accepted field
  assert.strictEqual(isAcceptedBody(JSON.stringify({ accepted: true })), true);
  assert.strictEqual(isAcceptedBody(JSON.stringify({ accepted: 'no' })), true); // only strict false rejects
  assert.strictEqual(isAcceptedBody('[1,2,3]'), true); // JSON but not an object with accepted:false
});

// ---- groupBySession: shared buffer split into one batch per session --------

t('groupBySession: records from two sessions produce two groups keyed correctly', () => {
  const items = parseItems([
    JSON.stringify({ event: 'invocation', tool: 'Bash', session_id: 'A' }),
    JSON.stringify({ event: 'unit_complete', agent_type: 'x', session_id: 'B' }),
    JSON.stringify({ event: 'invocation', tool: 'Read', session_id: 'A' }),
  ].join('\n') + '\n');
  const groups = groupBySession(items);
  assert.strictEqual(groups.length, 2);
  const a = groups.find((g) => g.sessionId === 'A');
  const b = groups.find((g) => g.sessionId === 'B');
  assert.strictEqual(a.items.length, 2);
  assert.strictEqual(b.items.length, 1);
  // Each group builds a batch keyed to its own session_id.
  const batchA = mapRecordsToBatch(a.items.map((it) => it.rec), 'pk', a.sessionId);
  const batchB = mapRecordsToBatch(b.items.map((it) => it.rec), 'pk', b.sessionId);
  assert.strictEqual(batchA.session_id, 'A');
  assert.strictEqual(batchB.session_id, 'B');
  assert.strictEqual(batchA.events.length, 2);
  assert.strictEqual(batchB.events.length, 1);
});

t('groupBySession: numeric and string session ids are kept distinct (no string coercion)', () => {
  const items = parseItems([
    JSON.stringify({ event: 'invocation', tool: 'Bash', session_id: 1 }),
    JSON.stringify({ event: 'invocation', tool: 'Read', session_id: '1' }),
    JSON.stringify({ event: 'invocation', tool: 'Edit', session_id: 1 }),
  ].join('\n') + '\n');
  const groups = groupBySession(items);
  assert.strictEqual(groups.length, 2, 'numeric 1 and string "1" must not merge');
  const numeric = groups.find((g) => g.sessionId === 1);
  const string = groups.find((g) => g.sessionId === '1');
  assert.ok(numeric && string, 'both a numeric and a string group exist');
  assert.strictEqual(numeric.items.length, 2);
  assert.strictEqual(string.items.length, 1);
});

t('groupBySession: an object session_id with a non-callable toString does not throw', () => {
  // A stringify of this key would throw; using the value itself as the Map key must not.
  const weird = { toString: null };
  const items = [
    { raw: 'x', rec: { event: 'invocation', tool: 'Bash', session_id: weird } },
    { raw: 'y', rec: { event: 'invocation', tool: 'Read', session_id: weird } },
  ];
  let groups;
  assert.doesNotThrow(() => { groups = groupBySession(items); });
  assert.strictEqual(groups.length, 1, 'same object identity groups together');
  assert.strictEqual(groups[0].items.length, 2);
});

t('groupBySession: records without a session_id fall under the null group', () => {
  const items = parseItems([
    JSON.stringify({ event: 'invocation', tool: 'Bash' }),
    JSON.stringify({ event: 'invocation', tool: 'Read', session_id: null }),
  ].join('\n') + '\n');
  const groups = groupBySession(items);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].sessionId, null);
  assert.strictEqual(groups[0].items.length, 2);
});

// ---- chunkSessionItems: bounded request chunks -----------------------------

t('chunkSessionItems: records over the cap split into multiple chunks, each under cap', () => {
  // Build many records; pick a cap that forces several chunks.
  const items = parseItems(Array.from({ length: 40 }, (_, i) =>
    JSON.stringify({ event: 'invocation', tool: 'Bash', session_id: 's', n: i })).join('\n') + '\n');
  const cap = 400;
  const { chunks, oversized } = chunkSessionItems(items, cap, 'pk', 's');
  assert.strictEqual(oversized.length, 0);
  assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
  // Every chunk's serialized batch stays at/under the cap.
  for (const chunk of chunks) {
    const bytes = Buffer.byteLength(JSON.stringify(
      mapRecordsToBatch(chunk.map((x) => x.rec), 'pk', 's')), 'utf8');
    assert.ok(bytes <= cap, `chunk of ${chunk.length} is ${bytes} bytes > cap ${cap}`);
  }
  // No record is lost or duplicated across chunks.
  const total = chunks.reduce((n, c) => n + c.length, 0);
  assert.strictEqual(total, items.length);
});

t('chunkSessionItems: a single oversized record is set aside, not stranded in a chunk', () => {
  const items = parseItems([
    JSON.stringify({ event: 'invocation', tool: 'Bash', session_id: 's' }),
    JSON.stringify({ event: 'invocation', tool: 'x'.repeat(5000), session_id: 's' }),
    JSON.stringify({ event: 'invocation', tool: 'Read', session_id: 's' }),
  ].join('\n') + '\n');
  const cap = 300;
  const { chunks, oversized } = chunkSessionItems(items, cap, 'pk', 's');
  assert.strictEqual(oversized.length, 1, 'the huge record is oversized');
  // The two normal records still get chunked and are sendable.
  const sent = chunks.reduce((n, c) => n + c.length, 0);
  assert.strictEqual(sent, 2);
  for (const chunk of chunks) {
    const bytes = Buffer.byteLength(JSON.stringify(
      mapRecordsToBatch(chunk.map((x) => x.rec), 'pk', 's')), 'utf8');
    assert.ok(bytes <= cap);
  }
});

t('chunkSessionItems: an unset/invalid cap falls back to the generic default', () => {
  const items = parseItems(JSON.stringify({ event: 'invocation', tool: 'Bash', session_id: 's' }) + '\n');
  // Default (90000) easily fits one small record in one chunk.
  for (const bad of [undefined, null, 0, -5, 1.5, 'big']) {
    const { chunks, oversized } = chunkSessionItems(items, bad, 'pk', 's');
    assert.strictEqual(oversized.length, 0);
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].length, 1);
  }
});

// ---- retain-on-failure: a failed chunk's records are preserved -------------

// Mirrors main()'s retain composition: non-sent records are always retained,
// plus every item in a chunk whose POST did not succeed. Proves the verbatim
// lines that would be appended back to the live buffer.
t('retain-on-failure: failed chunk records + non-sent records are kept verbatim, sent-ok dropped', () => {
  const nonSent = JSON.stringify({ event: 'session_start', session_id: 'A' });
  const failLine = JSON.stringify({ event: 'invocation', tool: 'Bash', session_id: 'A' });
  const okLine = JSON.stringify({ event: 'unit_complete', agent_type: 'x', session_id: 'B' });
  const items = parseItems([nonSent, failLine, okLine].join('\n') + '\n');

  const retain = new Set();
  for (const it of items) {
    const sent = it.rec && (it.rec.event === 'invocation' || it.rec.event === 'unit_complete');
    if (!sent) retain.add(it); // non-sent always kept
  }
  // Simulate: session A's chunk POST failed, session B's succeeded.
  for (const g of groupBySession(items.filter((it) =>
    it.rec && (it.rec.event === 'invocation' || it.rec.event === 'unit_complete')))) {
    const failed = g.sessionId === 'A';
    const { chunks } = chunkSessionItems(g.items, 90000, 'pk', g.sessionId);
    if (failed) for (const c of chunks) for (const it of c) retain.add(it);
  }
  const kept = items.filter((it) => retain.has(it)).map((it) => it.raw);
  assert.deepStrictEqual(kept, [nonSent, failLine]);
  assert.ok(!kept.includes(okLine), 'a successfully sent record must not be retained');
});

// ---- orphaned *.sending recovery on startup --------------------------------

t('startup recovery: a stranded *.sending snapshot is appended back and re-processed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-flush-recover-'));
  const projDir = path.join(tmp, 'project');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(path.join(projDir, '.claude'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  // Fully enabled config so main() runs past the gate to the recovery/rotation.
  fs.writeFileSync(path.join(projDir, '.claude', 'forge.json'), JSON.stringify({
    version: 1,
    telemetry: {
      enabled: true, sinkUrl: 'https://127.0.0.1:1/ingest',
      tokenEnv: 'FORGE_TEST_TOKEN', projectKey: 'pk',
    },
  }));
  const bufferFile = path.join(dataDir, 'telemetry.jsonl');
  // Live buffer holds one non-sent record (survives a flush untouched).
  const liveLine = JSON.stringify({ event: 'session_start', session_id: 's-live' });
  fs.writeFileSync(bufferFile, liveLine + '\n');
  // A stranded snapshot from a crashed prior run, also non-sent so no POST is made.
  const staleFile = path.join(dataDir, 'telemetry.jsonl.99999.1.sending');
  const staleLine = JSON.stringify({ event: 'guard_deny', rule: 'r', session_id: 's-stale' });
  fs.writeFileSync(staleFile, staleLine + '\n');

  const payload = JSON.stringify({ session_id: 's-run', cwd: projDir, hook_event_name: 'Stop' });
  const r = spawnSync(process.execPath, [HOOK, dataDir], {
    input: payload, encoding: 'utf8',
    env: { ...process.env, FORGE_TEST_TOKEN: 'unused' },
  });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  const after = fs.readFileSync(bufferFile, 'utf8');
  // Both the original live record and the recovered stale record are present.
  assert.ok(after.includes(liveLine), 'original live record retained');
  assert.ok(after.includes(staleLine), 'stranded snapshot record recovered into live buffer');
  // The stale snapshot file is gone.
  assert.ok(!fs.existsSync(staleFile), 'stale *.sending file must be unlinked');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- ack handling: postBatch retain/clear with a stubbed global fetch -------

async function tAsync(name, fn) {
  ran++;
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n  ${e.message}`);
  }
}

async function runAsyncTests() {
  const realFetch = global.fetch;
  const batch = mapRecordsToBatch([{ event: 'invocation', tool: 'Bash', session_id: 's' }], 'pk', 's');

  await tAsync('ack: 2xx {accepted:false} -> not ok (records retained)', async () => {
    global.fetch = async () => ({ status: 200, text: async () => JSON.stringify({ accepted: false }) });
    const { ok } = await postBatch('https://sink.example/ingest', 't', batch);
    assert.strictEqual(ok, false, 'a 2xx {accepted:false} must not clear records');
  });

  await tAsync('ack: 2xx {accepted:true} / empty / non-JSON -> ok (records cleared)', async () => {
    for (const body of [JSON.stringify({ accepted: true }), '', 'OK']) {
      global.fetch = async () => ({ status: 200, text: async () => body }); // eslint-disable-line no-loop-func
      const { ok } = await postBatch('https://sink.example/ingest', 't', batch); // eslint-disable-line no-await-in-loop
      assert.strictEqual(ok, true, `body ${JSON.stringify(body)} should count as success`);
    }
  });

  await tAsync('ack: 2xx but res.text() throws -> not ok (records retained)', async () => {
    global.fetch = async () => ({
      status: 200,
      text: async () => { throw new Error('body read failed'); },
    });
    const { ok } = await postBatch('https://sink.example/ingest', 't', batch);
    assert.strictEqual(ok, false, 'an unreadable 2xx body must be treated as not-acked');
  });

  global.fetch = realFetch;
}

runAsyncTests().then(() => {
  console.log(`\n${ran - failed}/${ran} passed`);
  process.exit(failed ? 1 : 0);
});
