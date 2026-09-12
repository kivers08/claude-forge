#!/usr/bin/env node
'use strict';
// PreToolUse on Edit|Write|MultiEdit|NotebookEdit: the user-level-write guard
// for the file tools, which never pass through a Bash command string.
const io = require('./lib/io');
const cfg = require('./lib/config');
const guard = require('./guards/user-level-write');

function main() {
  const payload = io.parsePayload(io.readStdin());
  const dataDir = io.dataDir(process.argv);
  const input = payload.tool_input || {};
  const file = input.file_path || input.notebook_path || input.path;
  if (!file) return;

  const projectDir = cfg.projectDir(payload);
  if (!guard.isUserLevel(file, projectDir)) return;

  io.telemetry(dataDir, {
    event: 'guard_deny',
    guard: 'user-level-write',
    tool: payload.tool_name || null,
    session_id: payload.session_id || null,
    file,
  });
  io.deny(`${guard.reason} Blocked path: ${file}.`, 'PreToolUse');
}

try {
  main();
} catch (e) {
  // fail open
}
process.exit(0);
