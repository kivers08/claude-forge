#!/usr/bin/env node
'use strict';
// Stop: the D29 telemetry flush emitter (Phase 2 unit 2).
//
// The other telemetry hooks (telemetry.js on PreToolUse, subagent-telemetry.js
// on SubagentStop) buffer records append-only to ${CLAUDE_PLUGIN_DATA}/
// telemetry.jsonl. This hook batches that buffer and POSTs it to the consuming
// project's ingest endpoint. It runs alongside stop-git-check.js on Stop.
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
//   - The ingest token is read from process.env[tokenEnv] and sent as a Bearer
//     header. It is never logged, printed, or included in any output.
//
// Durability model (hardening pass):
//   - ATOMIC ROTATION. Before reading, telemetry.jsonl is renamed to a unique
//     sibling (telemetry.jsonl.<pid>.<ts>.sending). Concurrent hooks then append
//     to a fresh empty telemetry.jsonl, so no record appended mid-flush is lost.
//     Only the rotated file is processed. Records that are NOT successfully sent
//     (non-sent event kinds, failed/unacked POSTs) are APPENDED back to the live
//     telemetry.jsonl (never overwritten), then the rotated file is removed.
//   - SESSION GROUPING. The buffer is shared across sessions; sent records are
//     grouped by their own session_id and one batch is built per session.
//   - BOUNDED CHUNKS. Each session's records are split into chunks whose
//     serialized batch JSON stays under telemetry.maxBatchBytes, so a single
//     unbounded POST cannot be permanently rejected (e.g. 413) as a whole. A
//     single record that alone exceeds the cap is dropped (and noted via the
//     telemetry log) to avoid permanent stranding.
//   - ACK HONORING. A 2xx clears records only when the response body is not JSON
//     with `accepted === false`. A sink may 2xx-accept the request but signal a
//     transient rejection with {accepted:false}; those records are retained.
const fs = require('fs');
const path = require('path');
const io = require('./lib/io');
const cfg = require('./lib/config');

const HTTP_TIMEOUT_MS = 2000;
// Generic default body cap when telemetry.maxBatchBytes is unset. Deliberately
// not any one consumer's exact limit — forge is stack-agnostic.
const DEFAULT_MAX_BATCH_BYTES = 90000;

// Pure, exported, unit-testable. Maps buffered telemetry records to the ingest
// batch shape. Allowlist only — the free-text `description` and any field not
// named below are dropped (D29 metadata-only). `outcomes` is populated (D30)
// from the OUTCOME hand-back block parsed onto each `unit_complete` record's
// `outcome` object by subagent-telemetry.js. It stays metadata-only: every
// outcome field copied is structured/enumerable (unit_label, agent_name,
// outcome enum, findings_confirmed int, tests_passed bool). The free-text
// `notes` field is deliberately NOT forwarded — it is unbounded worker text and
// could leak prompt/customer content; no free text is copied anywhere.
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

// Events the mapper actually consumes and POSTs. Every OTHER record in the
// buffer (session_start, guard_deny, guard_remind, rules_injected,
// memory-redaction, telemetry_flush_drop, etc.) is never sent and must survive
// a flush.
const SENT_EVENTS = new Set(['invocation', 'unit_complete']);

function isSentRecord(rec) {
  return !!rec && typeof rec === 'object' && SENT_EVENTS.has(rec.event);
}

// Pure, exported, unit-testable. Given the raw JSONL buffer text, return the
// lines to KEEP if only the sent event kinds were flushed: every non-empty line
// whose parsed record's `event` is NOT in SENT_EVENTS. Corrupt/unparseable
// lines are retained (never silently dropped). Retained lines keep their
// original JSON text verbatim. Returns a string ready to write back (trailing
// newline when non-empty). Kept for backward compatibility and unit testing;
// the main flush path uses the item-level retain built during rotation.
function retainUnsentLines(rawText) {
  const kept = [];
  for (const line of String(rawText == null ? '' : rawText).split('\n')) {
    if (!line.trim()) continue;
    let rec = null;
    try {
      rec = JSON.parse(line);
    } catch (e) {
      kept.push(line); // unparseable: keep as-is, we did not send it
      continue;
    }
    if (!isSentRecord(rec)) kept.push(line);
  }
  return kept.length ? kept.join('\n') + '\n' : '';
}

// Pure. Parse the append-only JSONL buffer into { raw, rec } items in file
// order. `raw` is the verbatim line (so a retained record is written back
// byte-for-byte); `rec` is the parsed object, or null when the line is not
// valid JSON (kept, never sent).
function parseItems(text) {
  const out = [];
  for (const line of String(text == null ? '' : text).split('\n')) {
    if (!line.trim()) continue;
    let rec = null;
    try {
      rec = JSON.parse(line);
    } catch (e) {
      rec = null;
    }
    out.push({ raw: line, rec });
  }
  return out;
}

// Pure, exported, unit-testable. Group sendable items by their own session_id.
// Items whose record has no session_id group under a single null sentinel.
// Returns an array of { sessionId, items } preserving first-seen order.
//
// The session_id VALUE itself is used as the Map key (Map keys may be of any
// type). We never coerce an untrusted session_id to a string: string coercion
// could (a) merge distinct ids that stringify alike — numeric 1 vs string "1" —
// and (b) THROW on an object whose toString is missing/non-callable, which would
// abort the whole flush and strand the rotated file. Using the raw value as the
// key sidesteps both. null/undefined normalize to one shared sentinel so absent
// ids group together. Grouping must never throw.
const NULL_SESSION = Symbol('null-session');
function groupBySession(items) {
  const order = [];
  const byKey = new Map();
  for (const it of items) {
    const sid = (it && it.rec && it.rec.session_id != null) ? it.rec.session_id : null;
    const key = sid === null ? NULL_SESSION : sid;
    if (!byKey.has(key)) {
      byKey.set(key, { sessionId: sid, items: [] });
      order.push(key);
    }
    byKey.get(key).items.push(it);
  }
  return order.map((k) => byKey.get(k));
}

// Pure, exported, unit-testable. Split a session's items into chunks whose
// serialized batch JSON stays at/under maxBytes. Greedy: accumulate records
// into a chunk until adding the next would exceed the cap, then start a new one.
// A single record whose own one-record batch already exceeds the cap is
// pathological and cannot ever be sent within the cap, so it is collected in
// `oversized` (the caller drops it to avoid permanent stranding) rather than
// stranding a chunk forever. Returns { chunks: [[item,...],...], oversized: [item,...] }.
function chunkSessionItems(items, maxBytes, projectKey, sessionId) {
  const cap = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BATCH_BYTES;
  const chunks = [];
  const oversized = [];
  const batchBytes = (recs) => Buffer.byteLength(
    JSON.stringify(mapRecordsToBatch(recs, projectKey, sessionId)), 'utf8',
  );
  let current = [];
  for (const it of items) {
    const alone = batchBytes([it.rec]);
    if (alone > cap) {
      oversized.push(it);
      continue;
    }
    const trial = current.concat(it);
    if (current.length && batchBytes(trial.map((x) => x.rec)) > cap) {
      chunks.push(current);
      current = [it];
    } else {
      current = trial;
    }
  }
  if (current.length) chunks.push(current);
  return { chunks, oversized };
}

// Pure, exported, unit-testable. Decide whether a 2xx response body counts as a
// successful acknowledgment. A body that is JSON with `accepted === false` is a
// transient rejection: NOT success. Anything else on a 2xx (empty body,
// non-JSON body, JSON without `accepted`, JSON with a truthy/other `accepted`)
// is treated as success — generic sinks may not return the field. Never throws.
function isAcceptedBody(bodyText) {
  if (bodyText == null || String(bodyText).trim() === '') return true;
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch (e) {
    return true; // non-JSON body on a 2xx: success
  }
  if (parsed && typeof parsed === 'object' && parsed.accepted === false) return false;
  return true;
}

// POST one batch. Resolves { ok } where ok is true only on a 2xx that is not
// explicitly {accepted:false}. Never throws; any error resolves { ok: false }
// so the caller retains those records.
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
    const twoXx = res.status >= 200 && res.status < 300;
    if (!twoXx) return { ok: false };
    let body;
    try {
      body = await res.text();
    } catch (e) {
      // A 2xx whose body READ throws is NOT a confirmed ack: we cannot tell
      // whether the sink signalled {accepted:false}. Treat as not-acked so the
      // chunk is retained and retried, rather than silently dropped. (A 2xx with
      // a successfully-read empty/non-JSON/missing-accepted body still counts as
      // success via isAcceptedBody — only a body-read error flips to not-ok.)
      return { ok: false };
    }
    return { ok: isAcceptedBody(body) };
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
  // Enforce HTTPS: never send a Bearer token over plaintext HTTP.
  if (!/^https:\/\//i.test(String(sinkUrl))) return;
  const token = process.env[tokenEnv];
  if (!token) return;

  const dir = io.dataDir(process.argv);
  const file = path.join(dir, 'telemetry.jsonl');

  // Recover orphaned snapshots from crashed prior runs. If a previous flush was
  // killed after renaming telemetry.jsonl -> *.sending but before it finished,
  // that snapshot is stranded forever. Before rotating, scan dataDir for any
  // pre-existing *.sending file (excluding the one we are about to create — it
  // does not exist yet, but we filter by our own pid/ts marker to be safe) and
  // APPEND its contents back into the live buffer (never overwrite), then unlink
  // it, so its records are processed in the rotation below. Best-effort: any
  // per-file error is ignored (fail open); recovery must never throw.
  const rotated = `${file}.${process.pid}.${Date.now()}.sending`;
  try {
    const base = path.basename(file); // telemetry.jsonl
    const ownMarker = path.basename(rotated);
    for (const name of fs.readdirSync(dir)) {
      if (name === ownMarker) continue;
      if (!name.startsWith(`${base}.`) || !name.endsWith('.sending')) continue;
      const stale = path.join(dir, name);
      try {
        const contents = fs.readFileSync(stale, 'utf8');
        if (contents) fs.appendFileSync(file, contents.endsWith('\n') ? contents : `${contents}\n`);
        fs.unlinkSync(stale);
      } catch (e) {
        // ignore this file; keep going
      }
    }
  } catch (e) {
    // dataDir unreadable: skip recovery, proceed to rotation (fail open)
  }

  // Atomic rotation: rename the live buffer out of the way so concurrent hooks
  // append to a fresh telemetry.jsonl while we process the rotated snapshot. If
  // the rename fails (buffer absent, or lost a race to another flush), no-op.
  //
  // ACCEPTED BEST-EFFORT LIMITATION (inode-level writer race): a concurrent hook
  // can open telemetry.jsonl for append microseconds before this rename and then
  // write to the old inode AFTER the rename, so those records land in the fresh
  // live buffer's predecessor and are lost from this snapshot. Fully closing this
  // window requires a lock protocol (e.g. flock/lockfile around every append and
  // the rotate). That is deliberately out of scope: this telemetry is
  // non-critical, metadata-only, lossy-tolerant, at-least-once delivery — a tiny
  // concurrent-write loss window is acceptable, and a lock protocol would be
  // over-engineering for it.
  try {
    fs.renameSync(file, rotated);
  } catch (e) {
    return; // nothing to flush, or another flush already claimed it
  }

  let raw;
  try {
    raw = fs.readFileSync(rotated, 'utf8');
  } catch (e) {
    // Rotated file unreadable: remove it and bail (fail open).
    try { fs.unlinkSync(rotated); } catch (e2) { /* ignore */ }
    return;
  }

  const items = parseItems(raw);
  if (!items.length) {
    try { fs.unlinkSync(rotated); } catch (e) { /* ignore */ }
    return;
  }

  const projectKey = cfg.get(cfgObj, 'telemetry.projectKey', null);
  const maxBatchBytes = cfg.get(cfgObj, 'telemetry.maxBatchBytes', DEFAULT_MAX_BATCH_BYTES);

  // Records the mapper does not consume (session_start, guard_*, etc.) and
  // unparseable lines are never sent — retain them all verbatim.
  const sendable = [];
  const retain = new Set();
  for (const it of items) {
    if (isSentRecord(it.rec)) sendable.push(it);
    else retain.add(it);
  }

  let droppedOversized = 0;
  for (const group of groupBySession(sendable)) {
    const { chunks, oversized } = chunkSessionItems(
      group.items, maxBatchBytes, projectKey, group.sessionId,
    );
    // A single record that can never fit the cap is dropped to avoid permanent
    // stranding; it is counted and noted below via the telemetry log.
    droppedOversized += oversized.length;
    for (const chunk of chunks) {
      const batch = mapRecordsToBatch(chunk.map((x) => x.rec), projectKey, group.sessionId);
      const { ok } = await postBatch(sinkUrl, token, batch); // eslint-disable-line no-await-in-loop
      if (!ok) for (const it of chunk) retain.add(it);
    }
  }

  // Append retained records back to the LIVE buffer (never overwrite: concurrent
  // hooks may have appended since rotation). Preserve original order and verbatim
  // JSON text. Then remove the rotated snapshot.
  const keptLines = items.filter((it) => retain.has(it)).map((it) => it.raw);
  let appendedOk = true;
  if (keptLines.length) {
    try {
      fs.appendFileSync(file, keptLines.join('\n') + '\n');
    } catch (e) {
      appendedOk = false; // keep the rotated file so retained records aren't lost
    }
  }
  if (appendedOk) {
    try { fs.unlinkSync(rotated); } catch (e) { /* ignore */ }
  }

  // Note any oversized drops via the telemetry log mechanism (metadata-only,
  // no free text) rather than throwing. This survives the next flush.
  if (droppedOversized > 0) {
    io.telemetry(dir, { event: 'telemetry_flush_drop', reason: 'oversized', count: droppedOversized });
  }
}

// Run only when invoked as a script (node telemetry-flush.js), not when this
// module is require()d by the unit tests. Auto-running on require would call
// process.exit(0) mid-test and kill any asynchronous test still in flight.
if (require.main === module) {
  main()
    .catch(() => {
      // fail open: telemetry must never affect the session
    })
    .finally(() => process.exit(0));
}

module.exports = {
  mapRecordsToBatch,
  retainUnsentLines,
  parseItems,
  groupBySession,
  chunkSessionItems,
  isAcceptedBody,
  postBatch,
};
