#!/usr/bin/env node
'use strict';
// PreToolUse on Skill / Task / Agent: the D10 usage log.
//
// D23 is "measure before adding": a mechanism nobody invokes is a mechanism to
// retire, and without a log that judgement is guesswork. One JSON line per
// invocation to ${CLAUDE_PLUGIN_DATA}/telemetry.jsonl; /forge:audit-framework
// reads it back. Guard denies are logged by the dispatcher, not here.
//
// UNVERIFIED: the exact tool name for an agent spawn is not documented and has
// differed between surfaces (Task vs Agent). hooks.json matches both and this
// hook records payload.tool_name verbatim rather than assuming either.
// Never blocks; emits nothing.
const io = require('./lib/io');

function main() {
  const payload = io.parsePayload(io.readStdin());
  const dataDir = io.dataDir(process.argv);
  const tool = payload.tool_name || null;
  if (!tool) return;
  const input = payload.tool_input || {};

  io.telemetry(dataDir, {
    event: 'invocation',
    tool,
    session_id: payload.session_id || null,
    prompt_id: payload.prompt_id || null,
    // Skill invocations carry the skill name; agent spawns carry the type.
    skill: input.skill || input.name || null,
    agent_type: input.subagent_type || input.agent_type || null,
    model: input.model || null,
    description: typeof input.description === 'string' ? input.description.slice(0, 120) : null,
  });
}

try {
  main();
} catch (e) {
  // fail open
}
process.exit(0);
