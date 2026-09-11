'use strict';
// Shared helpers for the smoke hooks. Node stdlib only.
const fs = require('fs');
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

// Data dir: argv[2] (substituted ${CLAUDE_PLUGIN_DATA}) wins, then the env var,
// then a fallback under the OS temp dir so the hook never crashes.
function dataDir(argv) {
  const fromArg = argv && argv[2];
  const dir = fromArg || process.env.CLAUDE_PLUGIN_DATA || path.join(require('os').tmpdir(), 'smoke-plugin-data');
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

module.exports = { readStdin, parsePayload, dataDir, appendLine };
