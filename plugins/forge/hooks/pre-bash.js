#!/usr/bin/env node
'use strict';
// PreToolUse on Bash: the guard dispatcher.
//
// Reads hooks/guards.json, splits the command into segments, and runs every
// guard whose `match` regex hits that segment (a null `match` means the guard
// always runs and decides for itself). The FIRST deny wins and is emitted
// immediately; reminders from all guards are concatenated into one
// additionalContext note.
//
// Fail-open contract: a malformed payload, an unreadable manifest, or a guard
// that throws must never block a command. A guard that WANTS to fail closed
// says so inside itself.
const fs = require('fs');
const path = require('path');
const io = require('./lib/io');
const cfg = require('./lib/config');
const seg = require('./lib/segment-split');

function main() {
  const payload = io.parsePayload(io.readStdin());
  const dataDir = io.dataDir(process.argv);
  const command = (payload.tool_input && payload.tool_input.command) || '';
  if (!command) return;

  const projectDir = cfg.projectDir(payload);
  const { config } = cfg.load(projectDir);

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'guards.json'), 'utf8'));
  } catch (e) {
    return; // fail open
  }
  const entries = Array.isArray(manifest.guards) ? manifest.guards : [];

  const reminders = [];
  for (const segment of seg.split(command)) {
    const segmentLower = segment.toLowerCase();
    const ctx = {
      segment,
      segmentLower,
      command,
      tokens: seg.tokenize(segment),
      paths: seg.extractPaths(segment),
      payload,
      config,
      projectDir,
      dataDir,
    };

    for (const entry of entries) {
      if (!entry || !entry.script) continue;
      if (entry.match) {
        let re;
        try {
          re = new RegExp(entry.match, 'i');
        } catch (e) {
          continue;
        }
        if (!re.test(segmentLower)) continue;
      }

      let guard;
      try {
        guard = require(path.join(__dirname, 'guards', entry.script));
      } catch (e) {
        continue; // a broken guard must not block work
      }

      let verdict = null;
      try {
        verdict = guard.check(ctx);
      } catch (e) {
        continue;
      }
      if (!verdict) continue;

      if (verdict.deny) {
        io.telemetry(dataDir, {
          event: 'guard_deny',
          guard: entry.name,
          session_id: payload.session_id || null,
          segment: segment.slice(0, 300),
        });
        io.deny(verdict.deny, 'PreToolUse');
        return;
      }
      if (verdict.remind) reminders.push(verdict.remind);
    }
  }

  if (reminders.length) {
    io.telemetry(dataDir, {
      event: 'guard_remind',
      session_id: payload.session_id || null,
      count: reminders.length,
    });
    io.context(reminders.join('\n\n'), 'PreToolUse');
  }
}

try {
  main();
} catch (e) {
  // fail open, always
}
process.exit(0);
