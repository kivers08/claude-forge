#!/usr/bin/env node
'use strict';
// PreToolUse on mcp__github__merge_pull_request: the merge gate again.
//
// The Bash guard only sees `gh pr merge`. A merge through the GitHub MCP server
// never touches Bash, so without this the gate has a hole wide enough to merge
// through.
//
// This hook fails CLOSED, unlike every other hook here. An unreadable payload
// means the marker cannot be checked, and "we could not verify the human said
// merge" must not resolve to "merge it". The cost of the wrong call is one
// denied merge and a re-run; the cost the other way is an unreviewed merge to
// the base branch.
const io = require('./lib/io');
const cfg = require('./lib/config');
const guard = require('./guards/merge-gate');

function main() {
  const payload = io.parsePayload(io.readStdin());
  const dataDir = io.dataDir(process.argv);
  const projectDir = cfg.projectDir(payload);
  const { config } = cfg.load(projectDir);
  const input = payload.tool_input || {};

  const method = String(input.merge_method || input.mergeMethod || '').toLowerCase();
  const verdict = guard.checkMerge({ config, projectDir }, {
    what: `merging PR #${input.pullNumber || input.pull_number || '?'} through the GitHub MCP server`,
    requireSquash: true,
    // An unset merge_method means the repository default, which is not
    // provably a squash: treat it as not-a-squash and make the caller say so.
    isSquash: method === 'squash',
  });
  if (!verdict) return;

  io.telemetry(dataDir, {
    event: 'guard_deny',
    guard: 'merge-gate',
    tool: payload.tool_name || 'mcp__github__merge_pull_request',
    session_id: payload.session_id || null,
  });
  io.deny(verdict.deny, 'PreToolUse');
}

try {
  main();
} catch (e) {
  // fail open
}
process.exit(0);
