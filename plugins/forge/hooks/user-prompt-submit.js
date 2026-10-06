#!/usr/bin/env node
'use strict';
// UserPromptSubmit: the spoken "merge" (M1, opusjevos D-J/D-P).
//
// OFF unless the project sets merge.spokenWord: true in .claude/forge.json.
// It ships off because the Claude Code docs do not say whether this hook can
// tell a message the human typed from one the harness injected (PR-event
// notices, other sessions' messages). Turn it on only after the live probe in
// docs/plans/merge-control.md shows it can, or accept that risk knowingly.
//
// When on: if the WHOLE prompt is a merge command, write a single-use,
// 15-minute marker into the plugin data dir. Examples that count: "merge",
// "Merge to main", "merge it", "merge PR 12", "merge #12". Anything longer or
// different writes nothing, so "should I merge?" or a pasted comment containing
// the word never counts. The agent cannot write the marker (marker-write guard
// + pre-write guard).
//
// Never blocks the prompt; fails open (a missed marker just means the guard
// asks or denies, which is the safe direction).
const fs = require('fs');
const path = require('path');
const io = require('./lib/io');
const cfg = require('./lib/config');
const mc = require('./lib/merge-control');

const RE = /^(?:please\s+)?merge(?:\s+(?:it|this|that))?(?:\s+to\s+main)?(?:\s+(?:pr|pull request)?\s*#?\s*(\d+))?\s*[.!]*$/i;

function parse(prompt) {
  const text = String(prompt || '').trim();
  if (!text || text.length > 60 || /\n/.test(text)) return null;
  const m = RE.exec(text);
  if (!m) return null;
  return { pr: m[1] ? Number(m[1]) : null, text };
}

function main() {
  const payload = io.parsePayload(io.readStdin());
  const dataDir = io.dataDir(process.argv);
  const projectDir = cfg.projectDir(payload);
  const { config } = cfg.load(projectDir);
  if (cfg.get(config, 'merge.spokenWord', false) !== true) return;
  // The field name is not pinned down in the docs: accept both spellings.
  const prompt = payload.prompt !== undefined ? payload.prompt : payload.user_input;
  const hit = parse(prompt);
  if (!hit) return;
  const file = path.join(dataDir, mc.SPOKEN);
  // PR numbers are per repository: record which repositories the session
  // can see; the guard honours the marker only when that is exactly one and
  // it is the merge's target.
  fs.writeFileSync(file, JSON.stringify({
    pr: hit.pr, repos: mc.sessionRepoSlugs(projectDir), text: hit.text, session_id: payload.session_id || null, ts: new Date().toISOString(),
  }));
  io.telemetry(dataDir, { event: 'merge_word', pr: hit.pr, session_id: payload.session_id || null });
}

try {
  main();
} catch (e) {
  // fail open
}
process.exit(0);
