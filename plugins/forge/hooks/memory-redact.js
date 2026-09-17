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
// only a path under .claude/agent-memory/ or .claude/agent-memory-local/ (any
// depth — native writes project-scope memory to the former and local-scope
// memory, gitignored, to the latter; both need the same scrub), only a `.md`
// file (the only shape native memory writes). Anything else is left
// untouched.
//
// User-scope memory (~/.claude/agent-memory/) is intentionally NOT covered
// here, by design rather than oversight: forge's user-level-write guard
// already blocks writes under ~/.claude, so this hook could never rewrite a
// file there anyway, and user-scope memory is machine-local/personal, not
// the committed/shared surface this hook exists to protect.
//
// The containment test resolves the target to a real absolute path FIRST
// (path.resolve, which collapses `..` and mixed separators) and then checks
// containment with path.relative against each memory root — mirroring the
// anchored style of guards/user-level-write.js / guards/worktree-commit.js —
// rather than testing a regex or doing an unanchored string replace/prefix
// check against the raw, possibly-relative path. A non-normalized check here
// is a security gap in both directions: a real agent-memory write that spells
// its path with a `..` segment could evade the scrub, and a path merely
// starting with the same characters outside the tree could be mistaken for
// one inside it.
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

// Cap the file we'll read/scrub/write: this hook runs synchronously inside
// the session (D28.4 design note above). The real ReDoS mitigation is the
// bounded quantifiers in lib/redact.js's patterns (a legitimate match can
// only ever backtrack across a bounded window regardless of input size) —
// this cap is defense-in-depth on top of that, sized to real agent-memory
// note sizes rather than to the old unbounded-regex worst case. A file this
// large under agent-memory is almost certainly not one this hook should be
// touching in-band.
const MAX_SCRUB_BYTES = 64 * 1024;

const MEMORY_SUBDIRS = ['.claude/agent-memory', '.claude/agent-memory-local'];

// Resolves tool_input's file path to a real absolute path: normalize
// backslashes (D13), join onto the resolved project dir when relative, then
// path.resolve so any `..` segments are actually collapsed rather than left
// in the string for a later substring/prefix check to be fooled by.
function resolvePath(filePath, projectDir) {
  const norm = String(filePath || '').replace(/\\/g, '/');
  if (!norm) return null;
  const joined = path.posix.isAbsolute(norm) || /^[A-Za-z]:\//.test(norm)
    ? norm
    : projectDir
      ? path.posix.join(String(projectDir).replace(/\\/g, '/'), norm)
      : null;
  if (!joined) return null;
  return path.resolve(joined).replace(/\\/g, '/');
}

// True when `absPath` (already resolved by resolvePath) is genuinely inside
// one of MEMORY_SUBDIRS under `projectDir`, and ends in .md. Containment is
// path.relative(root, absPath): anything that starts with `..` or is itself
// absolute means absPath escaped root (or was never inside it), never a
// string prefix/regex test on the unresolved path.
function isAgentMemoryMarkdown(absPath, projectDir) {
  if (!absPath || !absPath.endsWith('.md')) return false;
  if (!projectDir) return false;
  const proj = path.resolve(String(projectDir).replace(/\\/g, '/')).replace(/\\/g, '/');
  for (const sub of MEMORY_SUBDIRS) {
    const root = path.resolve(proj, sub).replace(/\\/g, '/');
    const rel = path.relative(root, absPath).replace(/\\/g, '/');
    if (rel === '') continue; // absPath IS the root dir itself, not a file in it
    if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) continue;
    return true;
  }
  return false;
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
  if (!isAgentMemoryMarkdown(absPath, projectDir)) return;

  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch (e) {
    return; // file missing/unreadable: nothing to scrub, fail open
  }
  if (stat.size > MAX_SCRUB_BYTES) return; // too large to scrub in-session; see MAX_SCRUB_BYTES above

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
  // was in it. Anchored path.relative, not an unanchored string replace, so
  // this can't produce a bogus relative path if absPath merely happens to
  // start with the same characters as projectDir without truly being inside it.
  const proj = projectDir ? path.resolve(String(projectDir).replace(/\\/g, '/')).replace(/\\/g, '/') : null;
  const projRel = proj ? path.relative(proj, absPath).replace(/\\/g, '/') : absPath;
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
