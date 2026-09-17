#!/usr/bin/env node
'use strict';
// PostToolUse on Edit|Write|MultiEdit: redaction-on-write for native Claude
// Code subagent memory (D28.4).
//
// A subagent with `memory: project` in its frontmatter writes agent memory to
// .claude/agent-memory/<plugin>-<agent>/ via the ordinary file tools, with NO
// secret redaction of its own — that scrubbing lived in the memory-v2 custom
// storage engine (plugins/forge/hooks/lib/memory.js), which has since been
// retired in favor of the native mechanism. This hook is what replaces it.
//
// Design: PostToolUse re-scrub of the file ON DISK, not a PreToolUse rewrite
// of tool_input. A PreToolUse hook can only allow/deny/annotate a call — it
// cannot substitute different bytes for what Write/Edit/MultiEdit actually
// writes (verified against the other forge PreToolUse hooks in this plugin:
// io.deny()/io.context() are the only two response shapes any of them use).
// So the write happens first, unredacted, and this hook then reads the
// resulting file back, scrubs it, and rewrites it in place only if the scrub
// changed anything. The window between "written" and "rescrubbed" is a single
// synchronous hook invocation, not a background job.
//
// Scope is deliberately narrow and defensive: only Write/Edit/MultiEdit,
// only a path under .claude/agent-memory/ (any depth), only a `.md` file
// (the only shape native memory writes). Anything else is left untouched.
//
// Fails open on every error: a hook must never crash or block a session, and
// this one additionally must never be the reason a legitimate memory write is
// lost — if the scrub itself throws, the on-disk file is left exactly as the
// tool wrote it.
const fs = require('fs');
const path = require('path');
const io = require('./lib/io');
const cfg = require('./lib/config');
const redact = require('./lib/redact');

const MEMORY_DIR_RE = /(^|\/)\.claude\/agent-memory\//;

// Resolves tool_input's file path against the project dir the same way
// guards/user-level-write.js does for Edit/Write/MultiEdit: normalize
// backslashes (D13), then join onto projectDir only when the path is not
// already absolute.
function resolvePath(filePath, projectDir) {
  const norm = String(filePath || '').replace(/\\/g, '/');
  if (!norm) return null;
  if (path.posix.isAbsolute(norm) || /^[A-Za-z]:\//.test(norm)) return norm;
  if (!projectDir) return null;
  return path.posix.join(String(projectDir).replace(/\\/g, '/'), norm);
}

function isAgentMemoryMarkdown(absPath) {
  const norm = String(absPath || '').replace(/\\/g, '/');
  return MEMORY_DIR_RE.test(norm) && norm.endsWith('.md');
}

function main() {
  const payload = io.parsePayload(io.readStdin());
  const toolName = payload.tool_name;
  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit') return;

  const input = payload.tool_input || {};
  const filePath = input.file_path || input.path;
  if (!filePath) return;

  const projectDir = cfg.projectDir(payload);
  const absPath = resolvePath(filePath, projectDir);
  if (!absPath) return;
  if (!isAgentMemoryMarkdown(absPath)) return;

  let original;
  try {
    original = fs.readFileSync(absPath, 'utf8');
  } catch (e) {
    return; // file missing/unreadable: nothing to scrub, fail open
  }

  const { text, redactions } = redact.scrubSecrets(original);
  if (text === original || !redactions.length) return; // byte-identical: no write

  fs.writeFileSync(absPath, text, 'utf8');

  const dataDir = io.dataDir(process.argv);
  const counts = {};
  for (const r of redactions) counts[r.kind] = (counts[r.kind] || 0) + 1;
  // Repo-relative path only (never the secret, never a full machine path):
  // matches the D10 telemetry norm of logging what was affected, not what
  // was in it.
  const projRel = projectDir
    ? absPath.replace(String(projectDir).replace(/\\/g, '/') + '/', '')
    : absPath;
  io.telemetry(dataDir, {
    event: 'memory_redacted',
    session_id: payload.session_id || null,
    tool: toolName,
    file: projRel,
    kinds: counts,
    total: redactions.length,
  });
}

try {
  main();
} catch (e) {
  // fail open
}
process.exit(0);
