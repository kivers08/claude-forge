#!/usr/bin/env node
'use strict';
// SessionStart: the session-context injector.
//
// Emits, as additionalContext: the project's task-file paths and line caps, the
// stack line, and — per taskFiles.injectionMode — a slice of each task file, so
// the coordinator starts a session knowing what is open without reading whole
// files (D6). Everything emitted is charged against taskFiles.injectionBudget
// bytes; past the budget, files are named but not quoted.
//
// The first line is always "forge <version> (<commit>) loaded" (lib/version.js),
// plus an OUT OF DATE warning when the marketplace clone is ahead of the
// installed commit: a session must say which forge it runs (opusjevos D-W).
//
// Modes: `index` (the ## Index section), `open-items` (unchecked checkboxes),
// `head-N` (first N lines). Default when unset: `index`, except `todo`, whose
// documented exception is `open-items`, and `handoff` (`head-25`).
//
// Hubs (`hubs.files`, opusjevos D-BN): each hub's ## Index is injected after
// the to-dos and the handoff. An Index that does not fit the remaining budget
// is cut to its first (newest) lines with a notice, instead of being dropped.
//
// Conflict-check trigger (opusjevos D-BM): when the handoff's YAML header
// carries `forge_version` and it differs from the running forge, say so: the
// conflict check runs before other work, then wrap-up records the new version.
const fs = require('fs');
const path = require('path');
const io = require('./lib/io');
const cfg = require('./lib/config');
const version = require('./lib/version');

const DEFAULT_BUDGET = 8192;
const DEFAULT_MODES = { lessons: 'index', todo: 'open-items', sprint: 'index', handoff: 'head-25' };
// Injection priority when the budget runs short (opusjevos D-BN): open
// to-dos, the top of the handoff note, the hubs, then lessons and sprint.
const ORDER = ['todo', 'handoff', 'lessons', 'sprint'];

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
}

function sliceIndex(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s+Index\s*$/i.test(l.trim()));
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  const body = out.join('\n').trim();
  return body || null;
}

function sliceOpenItems(text) {
  const items = text.split('\n').filter((l) => /^\s*[-*]\s+\[\s\]\s+/.test(l));
  return items.length ? items.join('\n') : null;
}

function sliceHead(text, n) {
  return text.split('\n').slice(0, n).join('\n').trim() || null;
}

// The YAML header's `key: value` (first block only, flat keys).
function yamlField(text, key) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return null;
  const line = m[1].split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
  if (!line) return null;
  let v = line.slice(key.length + 1).trim();
  if (/^["']/.test(v)) v = v.replace(/^(["'])(.*?)\1.*$/, '$2');
  else v = v.replace(/\s+#.*$/, '').trim();
  return v || null;
}

// Cut an index body to its first (newest, by the hub contract) lines so that
// head + kept lines + the notice fit `room` BYTES. Returns the block text, or
// null when not even one line fits.
function fitLines(head, body, room, rel) {
  const all = body.split('\n');
  const bytes = (t) => Buffer.byteLength(t, 'utf8');
  const notice = (left) => `\n(${left} older line(s) not injected: grep ${rel} or run the hub script's find <label>.)`;
  for (let n = all.length - 1; n >= 1; n--) {
    const text = `${head}${all.slice(0, n).join('\n')}${notice(all.length - n)}`;
    if (bytes(text) <= room) return text;
  }
  return null;
}

function sliceFor(mode, text) {
  if (mode === 'open-items') return sliceOpenItems(text);
  const head = /^head-(\d+)$/.exec(mode || '');
  if (head) return sliceHead(text, Number(head[1]));
  return sliceIndex(text);
}

function main() {
  const payload = io.parsePayload(io.readStdin());
  const dataDir = io.dataDir(process.argv);
  const projectDir = cfg.projectDir(payload);
  const { config, error } = cfg.load(projectDir);

  const lines = [];
  let ver = null;
  try {
    ver = version.info();
    lines.push(...version.lines(ver));
  } catch (e) {
    lines.push('forge WARNING: the forge version could not be determined. Say so to the human.');
  }
  const major = Number((process.version.match(/^v(\d+)/) || [])[1] || 0);
  if (major < 20) {
    lines.push(`forge WARNING: node ${process.version} is below the required 20 (D11). Hooks may misbehave.`);
  }
  if (error) {
    lines.push(`forge WARNING: .claude/forge.json could not be read (${error}). Running with defaults.`);
  }

  const stackLine = cfg.get(config, 'stack.line', null);
  if (stackLine) lines.push(`Stack: ${stackLine}`);

  const taskFiles = cfg.get(config, 'taskFiles', {});
  const caps = cfg.get(config, 'taskFiles.caps', {});
  const modes = cfg.get(config, 'taskFiles.injectionMode', {});
  const budget = cfg.get(config, 'taskFiles.injectionBudget', DEFAULT_BUDGET);

  const named = [];
  for (const key of ORDER) {
    const rel = taskFiles && taskFiles[key];
    if (typeof rel !== 'string' || !rel) continue;
    const cap = caps && caps[key];
    named.push(`${key}: ${rel}${cap ? ` (cap ${cap} lines)` : ''}`);
  }
  if (named.length) lines.push(`Task files — ${named.join('; ')}. These are grep-only: grep for an anchor, then read that range.`);

  const decisionsLog = cfg.get(config, 'taskFiles.decisionsLog', null);
  if (decisionsLog) lines.push(`Decisions log: ${decisionsLog}`);

  const handoffRel = taskFiles && typeof taskFiles.handoff === 'string' ? taskFiles.handoff : null;
  if (handoffRel && ver && ver.version) {
    const seen = yamlField(readFileSafe(path.join(projectDir, handoffRel)), 'forge_version');
    if (seen && seen !== ver.version) {
      lines.push(`forge version changed since the last session (${handoffRel} says ${seen}, running ${ver.version}). `
        + 'Run the conflict check (/forge:conflict-check) before other work, and tell the human its result in the first reply; '
        + `session wrap-up then records forge_version: ${ver.version} in the handoff.`);
    }
  }

  const hubFiles = cfg.get(config, 'hubs.files', []);
  const sources = [];
  // A file is injected once: a taskFiles key naming a hub (or one of its
  // spokes, which carry no ## Index) is covered by that hub.
  const hubPaths = new Set();
  for (const h of Array.isArray(hubFiles) ? hubFiles : []) {
    if (h && typeof h.hub === 'string') hubPaths.add(h.hub);
    for (const sp of (h && Array.isArray(h.spokes) ? h.spokes : [])) hubPaths.add(sp);
  }
  const addKey = (key) => {
    const rel = taskFiles && taskFiles[key];
    if (typeof rel !== 'string' || !rel || hubPaths.has(rel) || sources.some((x) => x.rel === rel)) return;
    sources.push({ rel, mode: (modes && modes[key]) || DEFAULT_MODES[key] || 'index' });
  };
  addKey('todo');
  addKey('handoff');
  for (const h of Array.isArray(hubFiles) ? hubFiles : []) {
    if (h && typeof h.hub === 'string' && h.hub && !sources.some((x) => x.rel === h.hub)) sources.push({ rel: h.hub, mode: 'index', hub: true });
  }
  addKey('lessons');
  addKey('sprint');

  // Budget is in BYTES (taskFiles.injectionBudget); count UTF-8 bytes, not
  // UTF-16 code units, so non-ASCII text cannot overrun it.
  const bytes = (t) => Buffer.byteLength(t, 'utf8');
  let used = bytes(lines.join('\n'));
  const skipped = [];
  for (const src of sources) {
    const { rel, mode } = src;
    const text = readFileSafe(path.join(projectDir, rel));
    if (text === null) { skipped.push(`${rel} (missing)`); continue; }
    const body = sliceFor(mode, text);
    if (!body) { skipped.push(`${rel} (no ${mode} content)`); continue; }
    const head = `\n\n${rel} [${src.hub ? 'hub index, newest first' : mode}]:\n`;
    let block = head + body;
    if (used + bytes(block) > budget) {
      const fit = src.hub ? fitLines(head, body, budget - used, rel) : null;
      if (!fit) { skipped.push(`${rel} (over injectionBudget)`); continue; }
      block = fit;
    }
    used += bytes(block);
    lines.push(block.trim());
  }
  if (skipped.length) lines.push(`Not injected: ${skipped.join(', ')}. Grep them directly if needed.`);

  io.telemetry(dataDir, {
    event: 'session_start',
    session_id: payload.session_id || null,
    source: payload.source || null,
    bytes_injected: used,
    node: process.version,
    forge_version: ver ? ver.version : null,
    forge_commit: ver ? ver.commit : null,
  });

  if (!lines.length) return;
  io.context(`forge session context (project ${projectDir}):\n${lines.join('\n')}`, 'SessionStart');
}

try {
  main();
} catch (e) {
  // fail open
}
process.exit(0);
