#!/usr/bin/env node
'use strict';
// Hub-and-spoke memory (opusjevos D-BN, D-BO, D-BS).
//
// A SPOKE file holds entries. Each entry starts with a level-3 heading:
//
//   ### <ID> | <YYYY-MM-DD> | <label>[, <label>[, <label>]] | <one sentence>
//
// and runs until the next level-2 or level-3 heading. IDs are stable
// (D-BO, L-042) so a hub pointer never breaks when an entry is edited.
//
// A HUB file is generated: a short YAML header, a title, and a '## Index'
// section with one line per entry, newest first:
//
//   - <date> | <labels> | <sentence> | <spoke-file>#<ID>
//
// The '## Index' section is what forge's session-start injector already reads
// (Index Contract, D6), so a hub is loaded the same way lessons are.
//
// Usage (run from the repository root, or pass --root <dir>):
//   node hub.js build             rebuild every hub in .claude/forge.json "hubs"
//   node hub.js check             exit 1 if a hub is stale or an entry is invalid
//   node hub.js find <label>...   print the full entries carrying any label
//                                 (newest first; --limit N, default 10;
//                                 --hub <path> searches only that hub)
//
// Every configured path must stay inside the repository (no "..", no
// absolute path, no symlink leading out); a hub is never written through a
// symlink.
//
// Exit codes: 0 ok, 1 problems found (listed), 2 usage/config error.
// Node stdlib only (D11).
const fs = require('fs');
const path = require('path');

// How a reader runs this script from a project that installed forge.
const HUB_CMD = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hub/hub.js"';
const ENTRY_RE = /^###\s+([A-Z][A-Z0-9]*-[A-Z0-9][A-Z0-9.]*)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]*?)\s*\|\s*(.+?)\s*$/;
const HEADING3 = /^###\s+/;
const HEADING2 = /^##\s+/;
const LABEL_LINE = /^\s*[-*]\s+`?([a-z][a-z0-9-]*)`?\s*:/;

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
}

// Every configured path must stay inside the repository: no absolute paths,
// no "..", and no symlink (on the path or any parent) that points outside.
// Returns the absolute path, or throws with a plain reason.
function inRepo(root, rel, what) {
  if (typeof rel !== 'string' || !rel.trim()) throw new Error(`${what}: empty path`);
  if (path.isAbsolute(rel)) throw new Error(`${what}: ${rel} must be relative to the repository`);
  const realRoot = fs.realpathSync(root);
  const abs = path.resolve(realRoot, rel);
  const inside = (p) => p === realRoot || p.startsWith(realRoot + path.sep);
  if (!inside(abs)) throw new Error(`${what}: ${rel} is outside the repository`);
  // Resolve the deepest existing ancestor (or the file itself) through symlinks.
  let probe = abs;
  while (!fs.existsSync(probe) && probe !== realRoot) probe = path.dirname(probe);
  let real;
  try {
    real = fs.realpathSync(probe);
  } catch (e) {
    throw new Error(`${what}: ${rel} could not be resolved`);
  }
  if (!inside(real)) throw new Error(`${what}: ${rel} leads outside the repository through a symlink`);
  return abs;
}

function loadConfig(root) {
  const file = path.join(root, '.claude', 'forge.json');
  const text = readText(file);
  if (text === null) return { error: `${file} not found` };
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { error: `${file} is not valid JSON (${e.message})` };
  }
  const hubs = json.hubs;
  if (!hubs || !Array.isArray(hubs.files) || !hubs.files.length) return { error: 'no "hubs.files" in .claude/forge.json' };
  if (typeof hubs.labels !== 'string' || !hubs.labels) return { error: 'no "hubs.labels" in .claude/forge.json' };
  try {
    inRepo(root, hubs.labels, 'hubs.labels');
    for (const h of hubs.files) {
      if (!h || !Array.isArray(h.spokes) || !h.spokes.length) throw new Error('every hubs.files item needs a hub and at least one spoke');
      inRepo(root, h.hub, 'hub');
      for (const sp of h.spokes) inRepo(root, sp, 'spoke');
    }
  } catch (e) {
    return { error: e.message };
  }
  return { hubs };
}

// Allowed labels: every '- <label>: meaning' line in labels.md.
function parseLabels(text) {
  const out = new Set();
  for (const line of String(text || '').split('\n')) {
    const m = LABEL_LINE.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

// Entries of one spoke file. Returns { entries, problems }.
function parseSpoke(text, rel) {
  const entries = [];
  const problems = [];
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let cur = null;
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) {
      if (cur) cur.body.push(line);
      return;
    }
    if (HEADING3.test(line)) {
      const m = ENTRY_RE.exec(line);
      if (!m) {
        problems.push(`${rel}:${i + 1}: entry heading must be "### <ID> | <YYYY-MM-DD> | <labels> | <one sentence>": ${line.slice(0, 120)}`);
        cur = null;
        return;
      }
      const labels = m[3].split(',').map((l) => l.trim()).filter(Boolean);
      cur = { id: m[1], date: m[2], labels, sentence: m[4], file: rel, line: i + 1, heading: line, body: [] };
      entries.push(cur);
      return;
    }
    if (HEADING2.test(line) || /^#\s+/.test(line)) {
      cur = null;
      return;
    }
    if (cur) cur.body.push(line);
  });
  return { entries, problems };
}

function validate(entries, allowed) {
  const problems = [];
  const seen = new Map();
  for (const e of entries) {
    const where = `${e.file}:${e.line} ${e.id}`;
    if (seen.has(e.id)) problems.push(`${where}: duplicate ID (also ${seen.get(e.id)})`);
    else seen.set(e.id, `${e.file}:${e.line}`);
    if (e.labels.length < 1 || e.labels.length > 3) problems.push(`${where}: needs 1 to 3 labels, has ${e.labels.length}`);
    for (const l of e.labels) if (!allowed.has(l)) problems.push(`${where}: label "${l}" is not in the labels file`);
    const t = Date.parse(`${e.date}T00:00:00Z`);
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== e.date) problems.push(`${where}: date ${e.date} is not a real date`);
  }
  return problems;
}

// Newest first; same date keeps spoke order reversed (later entry = newer).
function sortNewest(entries) {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.date === b.e.date ? b.i - a.i : (a.e.date < b.e.date ? 1 : -1)))
    .map((x) => x.e);
}

function hubLine(e) {
  return `- ${e.date} | ${e.labels.join(', ')} | ${e.sentence} | ${e.file}#${e.id}`;
}

function renderHub(hubRel, spokes, entries) {
  // No wall-clock values: `check` re-renders and compares byte for byte, so
  // an empty hub simply has no date until its first entry.
  const newest = entries.length ? sortNewest(entries)[0].date : null;
  return [
    '---',
    `id: ${path.basename(hubRel, '.md')}`,
    ...(newest ? [`date: ${newest}`] : []),
    'status: generated',
    'labels: []',
    '---',
    `# Hub: ${spokes.join(', ')}`,
    '',
    `Generated by the forge hub script (\`${HUB_CMD} build\`). Do not edit by hand: edit the spoke entry, then rebuild.`,
    `Line format: date | labels | one sentence | spoke-file#ID. Newest first. Full entries by label: \`${HUB_CMD} find <label>\`, or grep the ID.`,
    '',
    '## Index',
    '',
    ...sortNewest(entries).map(hubLine),
    '',
  ].join('\n');
}

// Everything about one repository's hubs. Returns { hubs: [{ rel, text, entries }], problems }.
function analyse(root) {
  const { hubs, error } = loadConfig(root);
  if (error) return { error };
  const labelsText = readText(path.join(root, hubs.labels));
  if (labelsText === null) return { error: `labels file ${hubs.labels} not found` };
  const allowed = parseLabels(labelsText);
  if (!allowed.size) return { error: `labels file ${hubs.labels} lists no labels ("- <label>: <meaning>" lines)` };
  const problems = [];
  const out = [];
  for (const h of hubs.files) {
    const all = [];
    for (const rel of h.spokes) {
      const text = readText(path.join(root, rel));
      if (text === null) {
        problems.push(`${rel}: spoke file not found (hub ${h.hub})`);
        continue;
      }
      const r = parseSpoke(text, rel);
      problems.push(...r.problems);
      all.push(...r.entries);
    }
    problems.push(...validate(all, allowed));
    out.push({ rel: h.hub, text: renderHub(h.hub, h.spokes, all), entries: all });
  }
  return { hubs: out, problems, allowed };
}

// Hub lines whose pointer names no existing entry (an edited/removed ID).
function brokenPointers(hubText, entries) {
  const ids = new Set(entries.map((e) => `${e.file}#${e.id}`));
  const out = [];
  for (const line of String(hubText || '').split('\n')) {
    const m = /\|\s*(\S+#[A-Z][A-Z0-9]*-[A-Z0-9.]+)\s*$/.exec(line);
    if (m && !ids.has(m[1])) out.push(m[1]);
  }
  return out;
}

function cmdBuild(root) {
  const a = analyse(root);
  if (a.error) return fail(2, a.error);
  if (a.problems.length) return fail(1, `hub build refused, fix these first:\n${a.problems.map((p) => `  ${p}`).join('\n')}`);
  // Check every hub target first, then write: a bad second hub must not
  // leave the first one already rewritten.
  const targets = [];
  for (const h of a.hubs) {
    const file = inRepo(root, h.rel, 'hub');
    let isLink = false;
    try {
      isLink = fs.lstatSync(file).isSymbolicLink();
    } catch (e) {
      isLink = false;
    }
    if (isLink) return fail(2, `hub ${h.rel} is a symlink; refusing to write through it (nothing written)`);
    targets.push({ h, file });
  }
  for (const { h, file } of targets) {
    const before = readText(file);
    if (before !== h.text) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, h.text);
      console.log(`hub: wrote ${h.rel} (${h.entries.length} entries, ${Buffer.byteLength(h.text)} bytes)`);
    } else {
      console.log(`hub: ${h.rel} up to date (${h.entries.length} entries)`);
    }
  }
  return 0;
}

function cmdCheck(root) {
  const a = analyse(root);
  if (a.error) return fail(2, a.error);
  const problems = [...a.problems];
  for (const h of a.hubs) {
    const current = readText(path.join(root, h.rel));
    if (current === null) {
      problems.push(`${h.rel}: hub missing; run hub.js build`);
      continue;
    }
    for (const p of brokenPointers(current, h.entries)) problems.push(`${h.rel}: points at ${p}, which no spoke entry has`);
    if (current !== h.text) problems.push(`${h.rel}: out of date with its spokes; run hub.js build`);
  }
  if (problems.length) return fail(1, `hub check: ${problems.length} problem(s)\n${problems.map((p) => `  ${p}`).join('\n')}`);
  console.log(`hub check: ok (${a.hubs.map((h) => `${h.rel} ${h.entries.length}`).join(', ')})`);
  return 0;
}

function cmdFind(root, labels, limit, hubSel) {
  const a = analyse(root);
  if (a.error) return fail(2, a.error);
  const pool = hubSel ? a.hubs.filter((h) => h.rel === hubSel) : a.hubs;
  if (hubSel && !pool.length) return fail(2, `no hub ${hubSel} in .claude/forge.json (have: ${a.hubs.map((h) => h.rel).join(', ')})`);
  const unknown = labels.filter((l) => !a.allowed.has(l));
  if (unknown.length) return fail(2, `unknown label(s): ${unknown.join(', ')}. Allowed: ${[...a.allowed].join(', ')}`);
  const want = new Set(labels);
  const all = sortNewest(pool.flatMap((h) => h.entries)).filter((e) => e.labels.some((l) => want.has(l)));
  const shown = all.slice(0, limit);
  for (const e of shown) {
    console.log(`${e.heading}\n${e.body.join('\n').trim()}\n(${e.file}:${e.line})\n`);
  }
  console.log(`${shown.length} of ${all.length} matching entr${all.length === 1 ? 'y' : 'ies'}${all.length > shown.length ? ` (raise --limit for older ones)` : ''}.`);
  return 0;
}

function fail(code, msg) {
  console.error(msg);
  return code;
}

function main(argv) {
  const args = argv.slice(2);
  let root = process.cwd();
  let limit = 10;
  let hubSel = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') root = path.resolve(args[++i] || '.');
    else if (args[i] === '--limit') {
      limit = Number(args[++i]);
      if (!Number.isInteger(limit) || limit < 1) return fail(2, '--limit needs a whole number of 1 or more');
    }
    else if (args[i] === '--hub') hubSel = args[++i] || null;
    else rest.push(args[i]);
  }
  const [cmd, ...more] = rest;
  if (cmd === 'build') return cmdBuild(root);
  if (cmd === 'check') return cmdCheck(root);
  if (cmd === 'find' && more.length) return cmdFind(root, more, limit, hubSel);
  return fail(2, 'usage: hub.js build | check | find <label>... [--hub <hub path>] [--limit N] [--root DIR]');
}

if (require.main === module) {
  process.exitCode = main(process.argv);
} else {
  module.exports = { parseLabels, parseSpoke, validate, renderHub, sortNewest, hubLine, brokenPointers, analyse, main };
}
