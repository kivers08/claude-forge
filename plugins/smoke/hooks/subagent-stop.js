#!/usr/bin/env node
'use strict';
// SubagentStop: dump the raw stdin payload to ${CLAUDE_PLUGIN_DATA}/subagentstop.json
// and append a one-line summary (field names, whether last_assistant_message is
// present) to subagentstop.log. Proves check 8. Never blocks.
const fs = require('fs');
const path = require('path');
const { readStdin, parsePayload, dataDir, appendLine } = require('./lib/io');

const raw = readStdin();
const payload = parsePayload(raw);
const dir = dataDir(process.argv);
try {
  fs.writeFileSync(path.join(dir, 'subagentstop.json'), raw);
} catch (e) {
  // fail open
}
appendLine(path.join(dir, 'subagentstop.log'), JSON.stringify({
  ts: new Date().toISOString(),
  fields: Object.keys(payload).sort(),
  agent_type: payload.agent_type || null,
  has_last_assistant_message: typeof payload.last_assistant_message === 'string',
  last_assistant_message_len: typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message.length : 0,
  has_agent_transcript_path: typeof payload.agent_transcript_path === 'string',
}));
process.exit(0);
