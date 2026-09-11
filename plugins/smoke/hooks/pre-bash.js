#!/usr/bin/env node
'use strict';
// PreToolUse Bash: append one line to ${CLAUDE_PLUGIN_DATA}/smoke.log.
// Proves: exec-form Node hooks fire (check 4); data dir writable and its
// resolved path (check 11). Never blocks; fails open.
const path = require('path');
const { readStdin, parsePayload, dataDir, appendLine } = require('./lib/io');

const payload = parsePayload(readStdin());
const dir = dataDir(process.argv);
const cmd = String((payload.tool_input && payload.tool_input.command) || '').replace(/\s+/g, ' ').slice(0, 120);
appendLine(path.join(dir, 'smoke.log'), JSON.stringify({
  ts: new Date().toISOString(),
  event: payload.hook_event_name || 'PreToolUse',
  session_id: payload.session_id || null,
  cwd: payload.cwd || null,
  plugin_root: process.env.CLAUDE_PLUGIN_ROOT || null,
  plugin_data_arg: process.argv[2] || null,
  plugin_data_env: process.env.CLAUDE_PLUGIN_DATA || null,
  node: process.version,
  platform: process.platform,
  command: cmd,
}));
process.exit(0);
