#!/usr/bin/env node
'use strict';
// SessionStart: record the resolved plugin data dir, plugin root, node version
// and platform to ${CLAUDE_PLUGIN_DATA}/session.log so check 11 (data dir
// stable across restart) and the Node >= 20 prerequisite can be read off a
// file. Emits one line of additionalContext naming the log path so the owner
// can ask for it. Fails open.
const path = require('path');
const { readStdin, parsePayload, dataDir, appendLine } = require('./lib/io');

const payload = parsePayload(readStdin());
const dir = dataDir(process.argv);
const major = Number((process.version.match(/^v(\d+)/) || [])[1] || 0);
appendLine(path.join(dir, 'session.log'), JSON.stringify({
  ts: new Date().toISOString(),
  source: payload.source || null,
  session_id: payload.session_id || null,
  cwd: payload.cwd || null,
  plugin_root: process.env.CLAUDE_PLUGIN_ROOT || null,
  plugin_data: dir,
  node: process.version,
  platform: process.platform,
}));
const warn = major < 20 ? ` WARNING: node ${process.version} is below the required 20.` : '';
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: `SMOKE-SESSION-MARKER-2d9f: smoke plugin loaded; data dir ${dir}; node ${process.version}.${warn}`,
  },
}));
process.exit(0);
