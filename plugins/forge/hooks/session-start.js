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
// Modes: `index` (the ## Index section), `open-items` (unchecked checkboxes),
// `head-N` (first N lines). Default when unset: `index`, except `todo`, whose
// documented exception is `open-items`.
const fs = require('fs');
const path = require('path');
const io = require('./lib/io');
const cfg = require('./lib/config');

const DEFAULT_BUDGET = 8192;
const DEFAULT_MODES = { lessons: 'index', todo: 'open-items', sprint: 'index' };

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
  for (const key of ['lessons', 'todo', 'sprint']) {
    const rel = taskFiles && taskFiles[key];
    if (typeof rel !== 'string' || !rel) continue;
    const cap = caps && caps[key];
    named.push(`${key}: ${rel}${cap ? ` (cap ${cap} lines)` : ''}`);
  }
  if (named.length) lines.push(`Task files — ${named.join('; ')}. These are grep-only: grep for an anchor, then read that range.`);

  const decisionsLog = cfg.get(config, 'taskFiles.decisionsLog', null);
  if (decisionsLog) lines.push(`Decisions log: ${decisionsLog}`);

  let used = lines.join('\n').length;
  const skipped = [];
  for (const key of ['lessons', 'todo', 'sprint']) {
    const rel = taskFiles && taskFiles[key];
    if (typeof rel !== 'string' || !rel) continue;
    const text = readFileSafe(path.join(projectDir, rel));
    if (text === null) { skipped.push(`${rel} (missing)`); continue; }
    const mode = (modes && modes[key]) || DEFAULT_MODES[key] || 'index';
    const body = sliceFor(mode, text);
    if (!body) { skipped.push(`${rel} (no ${mode} content)`); continue; }
    const block = `\n\n${rel} [${mode}]:\n${body}`;
    if (used + block.length > budget) { skipped.push(`${rel} (over injectionBudget)`); continue; }
    used += block.length;
    lines.push(block.trim());
  }
  if (skipped.length) lines.push(`Not injected: ${skipped.join(', ')}. Grep them directly if needed.`);

  io.telemetry(dataDir, {
    event: 'session_start',
    session_id: payload.session_id || null,
    source: payload.source || null,
    bytes_injected: used,
    node: process.version,
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
