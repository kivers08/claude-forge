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
  // Kept byte-for-byte in step with scripts/reviewer-clean-check.js:parseSummary
  // — the D23 metric must record findings for exactly the summaries that gate
  // accepts, no more, no less. The plugin can't require() across the
  // plugin/scripts boundary (it must stay self-contained), so the pattern is
  // duplicated; if one changes, change both. The `ann` group is why: a real
  // reviewer wrote "4 security issues (1 pre-existing)," and the old `\D*?`
  // separators cannot cross the digit inside that annotation, so D23 recorded
  // null for precisely the reports whose findings were worth annotating.
  const ann = '(?:\\s*\\([^)]*\\))?';
  const re = new RegExp(
    `(\\d+)\\s+bugs?${ann},\\s*(\\d+)\\s+security\\s+issues?${ann},\\s*`
    + `(\\d+)\\s+convention\\s+violations?${ann},?\\s*(?:and\\s+)?(\\d+)\\s+suggestions?`,
    'gi',
  );
  let match = null;
  let m;
  while ((m = re.exec(text)) !== null) match = m; // last match: the closing line
  if (!match) return null;
  return {
    bugs: Number(match[1]),
    security: Number(match[2]),
    convention: Number(match[3]),
    suggestions: Number(match[4]),
  };
}

// Parses the shared OUTCOME hand-back block (D29/D30) out of an agent's final
// message. Agents emit this EXACT block; we parse it verbatim:
//
//   ### OUTCOME
//   outcome: success | fail | partial
//   unit_label: <short-kebab-slug>
//   tests_passed: true | false | n/a
//   findings_confirmed: <integer> | n/a
//   notes: <short metadata>
//
// Returns { outcome, unit_label, tests_passed, findings_confirmed, notes } with
// normalized values, or null if the block is absent. Fail-open: never throws.
// `outcome` is kept only if in {success,fail,partial} else null; `tests_passed`
// coerces "true"->true / "false"->false / "n/a"|missing->null;
// `findings_confirmed` is an integer or null; `unit_label`/`notes` are trimmed
// strings or null. Mirrors the style of parseFindings above.
function parseOutcome(text) {
  if (typeof text !== 'string') return null;
  if (!/^\s*#{1,6}\s+OUTCOME\s*$/im.test(text)) return null;

  const field = (name) => {
    const re = new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`, 'im');
    const m = re.exec(text);
    if (!m) return null;
    const v = m[1].trim();
    return v === '' ? null : v;
  };

  const rawOutcome = field('outcome');
  const outcome = rawOutcome && /^(success|fail|partial)$/i.test(rawOutcome)
    ? rawOutcome.toLowerCase()
    : null;

  const rawTests = field('tests_passed');
  let tests_passed = null;
  if (rawTests !== null) {
    if (/^true$/i.test(rawTests)) tests_passed = true;
    else if (/^false$/i.test(rawTests)) tests_passed = false;
    else tests_passed = null; // "n/a" or anything else -> null
  }

  const rawFindings = field('findings_confirmed');
  let findings_confirmed = null;
  if (rawFindings !== null && /^-?\d+$/.test(rawFindings)) {
    findings_confirmed = Number(rawFindings);
  }

  return {
    outcome,
    unit_label: field('unit_label'),
    tests_passed,
    findings_confirmed,
    notes: field('notes'),
  };
}

function main() {
  const payload = io.parsePayload(io.readStdin());
  const dataDir = io.dataDir(process.argv);
  const agentType = payload.agent_type || null;
  const message = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : null;

  let outcome = null;
  try {
    outcome = parseOutcome(message);
  } catch (e) {
    outcome = null; // fail open
  }

  io.telemetry(dataDir, {
    event: 'unit_complete',
    agent_type: agentType,
    session_id: payload.session_id || null,
    agent_id: payload.agent_id || null,
    output_chars: message === null ? null : message.length,
    findings: isReviewer(agentType) ? parseFindings(message) : null,
    outcome,
  });
}

// Exported for unit testing as a pure function. The module also runs main()
// when invoked directly as a hook.
module.exports = { parseOutcome, parseFindings, isReviewer };

if (require.main === module) {
  try {
    main();
  } catch (e) {
    // fail open
  }
  process.exit(0);
}
