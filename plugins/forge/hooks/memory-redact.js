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
// The containment test resolve-then-compares (as in guards/worktree-commit.js):
// resolve the target to an absolute path FIRST (path.resolve, which collapses
// `..` and mixed separators), then check containment with an anchored
// path.relative against each memory root, tightened further with
// fs.realpathSync (see the realpath comment below) — rather than testing a
// regex or doing an unanchored string replace/prefix check against the raw,
// possibly-relative path. A non-normalized check here is a security gap in
// both directions: a real agent-memory write that spells its path with a
// `..` segment could evade the scrub, and a path merely starting with the
// same characters outside the tree could be mistaken for one inside it.
//
// path.resolve alone does not follow symlinks, though: a symlink placed
// INSIDE agent-memory (e.g. .claude/agent-memory/forge-x/note.md -> some file
// outside the repo) would pass the path.resolve-based containment check even
// though readFileSync/writeFileSync follow the symlink and act on the
// external target. So the real path (fs.realpathSync) is what containment is
// actually tested against, and what is read/written — see main() below.
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

  // path.resolve (above) collapses `..` but does NOT follow symlinks. A
  // symlink planted INSIDE agent-memory whose target is OUTSIDE it would
  // pass the isAgentMemoryMarkdown check above on its own (symlink) path,
  // yet fs.readFileSync/writeFileSync below follow the link and act on the
  // real, external file. So the containment check is re-run on the REAL
  // path, and the real path is what's stat'd/read/written from here on.
  // Fails open on a realpath error (e.g. broken symlink, race) the same way
  // every other step in this hook does: skip, never crash/block.
  let real;
  try {
    real = fs.realpathSync(absPath).replace(/\\/g, '/');
  } catch (e) {
    return;
  }

  // The second containment check MUST be run against a realpath'd project
  // root, not the raw projectDir: `real` above has every symlink component
  // resolved (e.g. macOS /tmp -> /private/tmp, or a symlinked /home, worktree
  // parent, or checkout path on Linux), so comparing it against an
  // unresolved projectDir makes path.relative produce a spurious `../…` and
  // containment fail even for a perfectly legitimate write — silently
  // disabling the scrub with no telemetry. Resolve projectDir the same way
  // exactly once here and use THIS resolved root for both the check and the
  // telemetry path below. Fails open to the unresolved dir on a realpath
  // error, same posture as everywhere else in this hook.
  let projReal = projectDir;
  try {
    projReal = fs.realpathSync(String(projectDir).replace(/\\/g, '/')).replace(/\\/g, '/');
  } catch (e) {
    // fail open to the unresolved dir
  }
  if (!isAgentMemoryMarkdown(real, projReal)) return;

  const dataDir = io.dataDir(process.argv);
  // Repo-relative path only (never the secret, never a full machine path):
  // matches the D10 telemetry norm of logging what was affected, not what
  // was in it. Anchored path.relative, not an unanchored string replace, so
  // this can't produce a bogus relative path if `real` merely happens to
  // start with the same characters as projReal without truly being inside it.
  const proj = projReal ? path.resolve(String(projReal).replace(/\\/g, '/')).replace(/\\/g, '/') : null;
  const projRel = proj ? path.relative(proj, real).replace(/\\/g, '/') : real;

  // Open the real (already-resolved) path with O_NOFOLLOW on the final
  // component for both the read and the write: fs.realpathSync above only
  // tells us what `real` pointed to at that instant, but between then and
  // the fs.readFileSync/fs.writeFileSync that used to follow directly, the
  // final path component could be swapped out for a symlink (TOCTOU) that a
  // plain write would happily follow and clobber. Opening with O_NOFOLLOW
  // makes the OS refuse (ELOOP) if that component is ever a symlink at open
  // time, and the read/write below operate on the fd, not the path, so
  // there's no further path-based race after this point. Fails open (skip,
  // never throw/block) on ENOENT/ELOOP/any other open error.
  let fd;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    return; // ENOENT/ELOOP/etc: fail open, nothing to scrub
  }

  let stat;
  try {
    stat = fs.fstatSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    return;
  }
  if (stat.size > MAX_SCRUB_BYTES) {
    fs.closeSync(fd);
    // Silent skip here would mean a file with secrets can be committed
    // unscrubbed with no record of it — a D10 telemetry gap, not just a
    // functional limit. Kind/counts only: no content, no full path.
    io.telemetry(dataDir, {
      event: 'memory_redact_skipped',
      reason: 'size',
      session_id: payload.session_id || null,
      bytes: stat.size,
      file: projRel,
    });
    return; // too large to scrub in-session; see MAX_SCRUB_BYTES above
  }

  let original;
  try {
    const buf = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, read);
      if (n === 0) break; // EOF short of stat.size: file shrank underneath us
      read += n;
    }
    original = buf.slice(0, read).toString('utf8');
  } catch (e) {
    fs.closeSync(fd);
    return; // read failure: nothing to scrub, fail open
  }

  const { text, redactions } = redact.scrubSecrets(original);
  if (text === original || !redactions.length) {
    fs.closeSync(fd);
    return; // byte-identical: no write
  }

  try {
    const outFd = fs.openSync(real, fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
    try {
      fs.writeSync(outFd, text, 0, 'utf8');
    } finally {
      fs.closeSync(outFd);
    }
  } catch (e) {
    fs.closeSync(fd);
    return; // write failure: fail open, on-disk file left as-is or partially truncated only by OS-level failure
  }
  fs.closeSync(fd);

  const counts = {};
  for (const r of redactions) counts[r.kind] = (counts[r.kind] || 0) + 1;
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
