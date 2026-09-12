'use strict';
// Loads the project's .claude/forge.json (D12). Fails open to {}: a project
// without the config still gets the guards that need no config.
const fs = require('fs');
const path = require('path');

// Payload `cwd` is the documented source of the project directory for a plugin
// hook (verified fact 1). CLAUDE_PROJECT_DIR works in practice but is not
// documented, so it is only a fallback.
//
// Returns null when neither is available — deliberately NOT process.cwd(). A
// hook's own working directory is not guaranteed to be the project, and falling
// back to it turns "the payload was unreadable" into "act on whatever directory
// we happen to be in", which is how a fail-open hook starts inspecting the
// wrong repository. Callers decide what null means for them.
function projectDir(payload) {
  return (payload && payload.cwd) || process.env.CLAUDE_PROJECT_DIR || null;
}

function load(dir) {
  if (!dir) return { config: {}, file: null, error: null };
  const file = path.join(dir, '.claude', 'forge.json');
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return { config: v, file, error: null };
    return { config: {}, file, error: 'forge.json is not an object' };
  } catch (e) {
    // Missing file is the normal case for an unconfigured project.
    return { config: {}, file, error: e.code === 'ENOENT' ? null : e.message };
  }
}

// Dotted lookup with a default: get(cfg, 'git.draftPrRequired', true).
function get(config, dotted, fallback) {
  let node = config;
  for (const key of String(dotted).split('.')) {
    if (node === null || typeof node !== 'object' || !(key in node)) return fallback;
    node = node[key];
  }
  return node === undefined ? fallback : node;
}

// Compile a list of config-supplied regex strings, skipping any that do not
// compile rather than crashing the hook.
function regexList(config, dotted) {
  const raw = get(config, dotted, []);
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const src of raw) {
    try {
      out.push({ source: String(src), re: new RegExp(String(src), 'i') });
    } catch (e) {
      // skip an unparseable pattern; audit-framework reports it separately
    }
  }
  return out;
}

module.exports = { projectDir, load, get, regexList };
