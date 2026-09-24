#!/usr/bin/env node
'use strict';
// Stop: the D29 telemetry flush emitter (Phase 2 unit 2).
//
// The other telemetry hooks (telemetry.js on PreToolUse, subagent-telemetry.js
// on SubagentStop) buffer records append-only to ${CLAUDE_PLUGIN_DATA}/
// telemetry.jsonl. This hook batches that buffer and POSTs it to the consuming
// project's ingest endpoint, then truncates the buffer on success so the next
// turn starts clean. It runs alongside stop-git-check.js on Stop.
//
// Everything about it is opt-in and best-effort:
//   - INERT unless telemetry.enabled === true in the project's forge.json, and
//     unless a sinkUrl and a readable ingest token are both configured. Forge
//     ships no URL and no token; the consuming project supplies both.
//   - METADATA-ONLY (D29 mode: 'metadata-only'). The mapper below is an
//     allowlist: it copies only enumerable/structured fields into the batch and
//     NEVER forwards the free-text `description` field (or any other free text).
//     Anything not explicitly whitelisted is dropped.
//   - NON-BLOCKING and NEVER THROWS. Any error — bad config, unreadable file,
//     network failure, non-2xx — is swallowed and the hook exits 0. A telemetry
//     failure must never affect the session.
//   - The buffer is truncated ONLY on a 2xx response. On any failure the file is
//     left intact so the next flush retries the same records (at-least-once).
//   - The ingest token is read from process.env[tokenEnv] and sent as a Bearer
//     header. It is never logged, printed, or included in any output.
const fs = require('fs');
const path = require('path');
const io = require('./lib/io');
const cfg = require('./lib/config');

const HTTP_TIMEOUT_MS = 2000;

// Pure, exported, unit-testable. Maps buffered telemetry records to the
// bluegrass ingest batch shape. Allowlist only — the free-text `description`
// and any field not named below are dropped (D29 metadata-only). `outcomes` is
// populated (D30) from the OUTCOME hand-back block parsed onto each
// `unit_complete` record's `outcome` object by subagent-telemetry.js. It stays
// metadata-only: `notes` is the only free-ish field, and it comes straight from
// the OUTCOME block (agents keep it metadata); no other free text is copied.
function mapRecordsToBatch(records, projectKey, sessionId) {
  const events = [];
  const outcomes = [];
  const list = Array.isArray(records) ? records : [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    if (r.event === 'invocation') {
      events.push({
        event_type: r.skill ? 'skill' : r.agent_type ? 'agent' : 'tool',
        name: r.skill || r.agent_type || r.tool || 'unknown',
        phase: 'start',
        tokens: null,
        tool_calls: null,
        duration_ms: null,
      });
    } else if (r.event === 'unit_complete') {
      events.push({
        event_type: 'agent',
        name: r.agent_type || 'unknown',
        phase: 'complete',
        tokens: null,
        tool_calls: null,
        duration_ms: null,
      });
      const o = r.outcome;
      if (o && typeof o === 'object'
        && (o.outcome === 'success' || o.outcome === 'fail' || o.outcome === 'partial')) {
        outcomes.push({
          unit_label: o.unit_label || null,
          agent_name: r.agent_type || 'unknown',
          outcome: o.outcome,
          findings_confirmed: o.findings_confirmed ?? null,
          tests_passed: o.tests_passed === true ? true : o.tests_passed === false ? false : null,
          notes: o.notes || null,
        });
      }
    }
  }
  return {
    project_key: projectKey || null,
    session_id: sessionId || null,
    events,
    outcomes,
  };
}

// Parse the append-only JSONL buffer into records, skipping unparseable lines.
function parseRecords(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch (e) {
      // skip a corrupt line rather than abort the whole flush
    }
  }
  return out;
}

// POST the batch. Resolves { ok } where ok is true only on a 2xx. Never throws;
// any error resolves { ok: false } so the caller leaves the buffer intact.
async function postBatch(url, token, batch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(batch),
      signal: controller.signal,
    });
    return { ok: res.status >= 200 && res.status < 300 };
  } catch (e) {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const payload = io.parsePayload(io.readStdin());
  const cfgObj = cfg.load(cfg.projectDir(payload)).config;

  // Gate: inert unless opted in with a sink and a token env var configured.
  if (cfg.get(cfgObj, 'telemetry.enabled', false) !== true) return;
  const sinkUrl = cfg.get(cfgObj, 'telemetry.sinkUrl', null);
  const tokenEnv = cfg.get(cfgObj, 'telemetry.tokenEnv', null);
  if (!sinkUrl || !tokenEnv) return;
  const token = process.env[tokenEnv];
  if (!token) return;

  const file = path.join(io.dataDir(process.argv), 'telemetry.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return; // absent buffer: nothing to flush
  }
  if (!raw || !raw.trim()) return; // empty buffer

  const records = parseRecords(raw);
  if (!records.length) return;

  const projectKey = cfg.get(cfgObj, 'telemetry.projectKey', null);
  const sessionId = payload.session_id
    || (records[0] && records[0].session_id)
    || null;

  const batch = mapRecordsToBatch(records, projectKey, sessionId);
  const { ok } = await postBatch(sinkUrl, token, batch);

  // Truncate only on success; leave the buffer to retry on any failure.
  if (ok) {
    try {
      fs.writeFileSync(file, '');
    } catch (e) {
      // fail open: a failed truncate just means the next flush re-sends
    }
  }
}

main()
  .catch(() => {
    // fail open: telemetry must never affect the session
  })
  .finally(() => process.exit(0));

module.exports = { mapRecordsToBatch };
