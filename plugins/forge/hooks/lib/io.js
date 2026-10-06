'use strict';
// Shared hook I/O for the forge plugin. Node stdlib only (D11).
// Every function here fails open: a hook must never crash a session.
const fs = require('fs');
const os = require('os');
const path = require('path');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return '';
  }
}

function parsePayload(raw) {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    return {};
  }
}

// argv[2] (the substituted ${CLAUDE_PLUGIN_DATA}) wins, then the env var, then
// a temp-dir fallback so the hook still runs outside a plugin install.
function dataDir(argv) {
  const dir = (argv && argv[2]) || process.env.CLAUDE_PLUGIN_DATA
    || path.join(os.tmpdir(), 'forge-plugin-data');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    // fail open
  }
  return dir;
}

function appendLine(file, line) {
  try {
    fs.appendFileSync(file, line + '\n');
    return true;
  } catch (e) {
    return false;
  }
}

function emit(obj) {
  try {
    process.stdout.write(JSON.stringify(obj));
  } catch (e) {
    // fail open
  }
}

// PreToolUse deny. The reason string is what the model sees, so it states the
// rule AND the way forward.
function deny(reason, event) {
  emit({
    hookSpecificOutput: {
      hookEventName: event || 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

// PreToolUse ask: the app shows the human an approve/deny prompt. Only used
// where lib/merge-control.js knows an ask reaches the human (never under
// `auto` or `bypassPermissions` unless explicitly enabled after a live probe).
function ask(reason, event) {
  emit({
    hookSpecificOutput: {
      hookEventName: event || 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  });
}

// Non-blocking note back to the model. Ignored by Claude Code versions that do
// not support additionalContext on this event, which is the fail-open case.
function context(text, event) {
  emit({
    hookSpecificOutput: {
      hookEventName: event || 'PreToolUse',
      additionalContext: text,
    },
  });
}

// D10 telemetry. One JSON object per line; never throws, never blocks.
function telemetry(dir, record) {
  appendLine(path.join(dir, 'telemetry.jsonl'), JSON.stringify({
    ts: new Date().toISOString(),
    ...record,
  }));
}

// Per-session scratch state (used by the rules injector to inject once).
function sessionStateFile(dir, sessionId, name) {
  const safe = String(sessionId || 'no-session').replace(/[^A-Za-z0-9_.-]/g, '_');
  const sub = path.join(dir, 'state', safe);
  try {
    fs.mkdirSync(sub, { recursive: true });
  } catch (e) {
    // fail open
  }
  return path.join(sub, name);
}

module.exports = {
  readStdin, parsePayload, dataDir, appendLine, emit, deny, ask, context,
  telemetry, sessionStateFile,
};
