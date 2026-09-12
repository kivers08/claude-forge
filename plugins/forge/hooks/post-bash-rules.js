#!/usr/bin/env node
'use strict';
// PostToolUse on Bash: the rules injector (D7).
//
// Path-scoped rules (`paths:` frontmatter in .claude/rules/*.md) are documented
// to trigger on the Read tool. They are NOT documented to trigger on Bash, and
// Phase 0 did not test it — so a file touched only by `sed -i`, `cat` or a test
// command gets no rule. This hook closes that gap: it pulls file-ish operands
// out of tool_input.command, matches them against each rule's globs, and
// returns the rule body as additionalContext.
//
// Injected at most ONCE per rule per session (state under
// ${CLAUDE_PLUGIN_DATA}/state/<session>/rules-injected.json), because the same
// rule re-injected on every Bash call is just context burn.
const fs = require('fs');
const path = require('path');
const io = require('./lib/io');
const cfg = require('./lib/config');
const seg = require('./lib/segment-split');
const glob = require('./lib/glob');

const MAX_RULE_BYTES = 4096;
const MAX_RULES_PER_CALL = 3;

// Parse just enough frontmatter to read `paths:`. Flow form
// (`paths: ["a/**", "b"]`) and block form (`  - "a/**"`) are both accepted.
function parseRule(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const fm = text.slice(text.indexOf('\n') + 1, end);
  const body = text.slice(end + 4).replace(/^\s*\n/, '');

  const paths = [];
  const flow = /^paths:\s*\[(.*)\]\s*$/m.exec(fm);
  if (flow) {
    for (const raw of flow[1].split(',')) {
      const v = raw.trim().replace(/^['"]|['"]$/g, '');
      if (v) paths.push(v);
    }
  } else if (/^paths:\s*$/m.test(fm)) {
    const lines = fm.split('\n');
    let collecting = false;
    for (const line of lines) {
      if (/^paths:\s*$/.test(line)) { collecting = true; continue; }
      if (!collecting) continue;
      const item = /^\s+-\s+(.*)$/.exec(line);
      if (!item) break;
      const v = item[1].trim().replace(/^['"]|['"]$/g, '');
      if (v) paths.push(v);
    }
  }
  if (!paths.length) return null;
  return { paths, body: body.slice(0, MAX_RULE_BYTES) };
}

function loadInjected(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(v) ? new Set(v) : new Set();
  } catch (e) {
    return new Set();
  }
}

function main() {
  const payload = io.parsePayload(io.readStdin());
  const command = (payload.tool_input && payload.tool_input.command) || '';
  if (!command) return;

  const projectDir = cfg.projectDir(payload);
  const rulesDir = path.join(projectDir, '.claude', 'rules');
  let files;
  try {
    files = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.md')).sort();
  } catch (e) {
    return; // no rules directory: nothing to do
  }
  if (!files.length) return;

  const touched = seg.extractPaths(command).map((p) => {
    const norm = glob.normalize(p);
    const proj = glob.normalize(projectDir);
    return norm.startsWith(proj + '/') ? norm.slice(proj.length + 1) : norm;
  });
  if (!touched.length) return;

  const dataDir = io.dataDir(process.argv);
  const stateFile = io.sessionStateFile(dataDir, payload.session_id, 'rules-injected.json');
  const injected = loadInjected(stateFile);

  const blocks = [];
  for (const f of files) {
    const id = f;
    if (injected.has(id)) continue;
    const rule = parseRule(path.join(rulesDir, f));
    if (!rule) continue;
    const hit = touched.find((p) => glob.matchAny(p, rule.paths));
    if (!hit) continue;
    injected.add(id);
    blocks.push(`Rule .claude/rules/${f} (matched ${hit}):\n${rule.body.trim()}`);
    if (blocks.length >= MAX_RULES_PER_CALL) break;
  }
  if (!blocks.length) return;

  try {
    fs.writeFileSync(stateFile, JSON.stringify([...injected]));
  } catch (e) {
    // If state cannot be written the rule may repeat; that is the safe direction.
  }

  io.telemetry(dataDir, {
    event: 'rules_injected',
    session_id: payload.session_id || null,
    rules: blocks.length,
  });
  io.context(
    'forge rules injector: the last Bash command touched files covered by these '
    + 'project rules. They apply for the rest of this session.\n\n' + blocks.join('\n\n'),
    'PostToolUse',
  );
}

try {
  main();
} catch (e) {
  // fail open
}
process.exit(0);
