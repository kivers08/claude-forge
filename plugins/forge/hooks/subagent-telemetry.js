#!/usr/bin/env node
'use strict';
// SubagentStop: the D23 "unit_complete" telemetry event, a second event type
// alongside the "invocation" event telemetry.js writes on PreToolUse. Same
// file, same append-only log (${CLAUDE_PLUGIN_DATA}/telemetry.jsonl), so a
// consumer can pair `unit_complete` and `invocation` rows by session_id.
//
// D23 is "measure before adding": tokens-per-unit and review-findings-per-unit
// are the two numbers it names. What this hook can genuinely populate:
//
// - tokens-per-unit: NOT populated. VERIFIED (docs/phase0-results.md check 8,
//   and plugins/smoke/hooks/subagent-stop.js's recorded fixture payload,
//   tests/payloads/subagent-stop-linux.json in that plugin): the SubagentStop
//   payload on this Claude Code version carries session_id, agent_id,
//   agent_type, agent_transcript_path, and last_assistant_message -- no
//   token/usage field of any kind. Recording a fabricated number here would
//   defeat D23's own premise ("measure", not guess). Instead this hook logs
//   `output_chars` (the length of last_assistant_message) as a real, if
//   rough, proxy for output volume -- explicitly not a token count. The `ts`
//   field (stamped by io.telemetry on every record, including the existing
//   `invocation` rows) lets a consumer diff wall-clock time between an
//   `invocation` row and this `unit_complete` row sharing a session_id as a
//   duration proxy; that pairing is best-effort (a session can dispatch more
//   than one agent), not exact.
//
// - review-findings-per-unit: populated when agent_type is the reviewer
//   agent, by parsing its documented one-line summary ("N bugs, N security
//   issues, N convention violations, N suggestions" -- see agents/reviewer.md
//   Report format) out of last_assistant_message. If that text doesn't match
//   the documented shape, `findings` is null -- never guessed.
//
// Never blocks; emits nothing; fails open on any error.
const io = require('./lib/io');

function isReviewer(agentType) {
  return typeof agentType === 'string' && /(^|[:/])reviewer$/i.test(agentType);
}

// Parses the reviewer's documented summary line out of free-form report text.
// Returns { bugs, security, convention, suggestions } or null when the text
// doesn't contain that exact four-category shape (in order, per
// agents/reviewer.md). Picks the LAST match in the text, since the summary
// line comes at the end of the report and earlier prose could otherwise
// coincidentally match.
function parseFindings(text) {
  if (typeof text !== 'string') return null;
  const re = /(\d+)\s+bugs?\D*?(\d+)\s+security\s+issues?\D*?(\d+)\s+convention\s+violations?\D*?(\d+)\s+suggestions?/gis;
  let match = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    match = m;
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width loops
  }
  if (!match) return null;
  return {
    bugs: Number(match[1]),
    security: Number(match[2]),
    convention: Number(match[3]),
    suggestions: Number(match[4]),
  };
}

function main() {
  const payload = io.parsePayload(io.readStdin());
  const dataDir = io.dataDir(process.argv);
  const agentType = payload.agent_type || null;
  const message = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : null;

  io.telemetry(dataDir, {
    event: 'unit_complete',
    agent_type: agentType,
    session_id: payload.session_id || null,
    agent_id: payload.agent_id || null,
    output_chars: message === null ? null : message.length,
    findings: isReviewer(agentType) ? parseFindings(message) : null,
  });
}

try {
  main();
} catch (e) {
  // fail open
}
process.exit(0);
