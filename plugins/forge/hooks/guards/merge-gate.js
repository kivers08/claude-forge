'use strict';
// Nothing merges INTO THE BASE BRANCH without a fresh human decision.
//
// Marker: `.git/claude-human-merge-ok`, written by the human, valid for
// MARKER_MAX_AGE_MS after its mtime. A stale marker is not a decision — it is
// yesterday's decision — so age is checked, not just existence.
//
// Scope, deliberately narrow: the gate is about the DESTINATION branch, not
// the tool. A merge (gh pr merge, the MCP merge, or a local git merge) is
// gated only when it lands on `git.baseBranch` (default "main"). A PR or
// merge landing on any other branch — e.g. a child unit merging into an
// owner-chosen integration branch — is not a merge to the base branch and
// must not be blocked. Merging the base branch INTO a feature branch (the
// normal way to resolve a conflict) was never gated either way.
//
// For `gh pr merge` and the MCP merge, the destination isn't visible in the
// command/tool_input itself — it's the PR's own base ref on GitHub. Resolved
// via `gh pr view --json baseRefName`, best-effort: when that can't be
// determined (no `gh` on PATH, no network, an unreadable payload), the
// destination is UNKNOWN, and unknown resolves to gated — the cost of an
// extra confirmation is one denied merge and a re-run; the cost the other
// way is an unreviewed merge to the base branch slipping through because a
// lookup happened to fail.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { get } = require('../lib/config');
const { hasUnquotedSequence, subcommandAfter } = require('../lib/segment-split');

const MARKER = 'claude-human-merge-ok';
const MARKER_MAX_AGE_MS = 15 * 60 * 1000;

// Resolves the PR's base ref (the branch it merges INTO) via `gh pr view`.
// Returns null when it cannot be determined — caller treats null as "assume
// the base branch" (fail-safe, see comment above).
function resolvePrBaseBranch(cwd, identifier) {
  const args = ['pr', 'view'];
  if (identifier) args.push(String(identifier));
  args.push('--json', 'baseRefName', '-q', '.baseRefName');
  let r;
  try {
    r = spawnSync('gh', args, { cwd: cwd || undefined, encoding: 'utf8' });
  } catch (e) {
    return null;
  }
  if (!r || r.status !== 0 || !r.stdout) return null;
  const branch = r.stdout.trim();
  return branch || null;
}

function gitDir(cwd) {
  if (!cwd) return null;
  const r = spawnSync('git', ['rev-parse', '--git-dir'], { cwd, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  const d = r.stdout.trim();
  return path.isAbsolute(d) ? d : path.join(cwd, d);
}

function currentBranch(cwd) {
  if (!cwd) return null;
  const r = spawnSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

function markerState(cwd) {
  const dir = gitDir(cwd);
  if (!dir) return { ok: false, why: 'not a git repository, so no merge marker could be read' };
  const file = path.join(dir, MARKER);
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return { ok: false, why: `no ${MARKER} marker`, file };
  }
  const age = Date.now() - st.mtimeMs;
  if (age > MARKER_MAX_AGE_MS) {
    return { ok: false, why: `the ${MARKER} marker is ${Math.round(age / 60000)} minutes old`, file };
  }
  return { ok: true, file };
}

// First unquoted, non-flag token after a `gh pr merge` sequence — the PR
// number, URL, or branch name `gh pr merge` accepts. Absent means "the
// current branch's PR", which `gh pr view` (no identifier) also resolves.
function ghMergeIdentifier(tokens) {
  for (let i = 0; i + 3 <= tokens.length; i++) {
    if (tokens[i].quoted || tokens[i].value.toLowerCase() !== 'gh') continue;
    if (tokens[i + 1].quoted || tokens[i + 1].value.toLowerCase() !== 'pr') continue;
    if (tokens[i + 2].quoted || tokens[i + 2].value.toLowerCase() !== 'merge') continue;
    for (let j = i + 3; j < tokens.length; j++) {
      const t = tokens[j];
      if (!t.quoted && !t.value.startsWith('-')) return t.value;
    }
    return undefined;
  }
  return undefined;
}

module.exports = {
  name: 'merge-gate',
  resolvePrBaseBranch,
  // Also called directly by pre-merge-mcp.js for mcp__github__merge_pull_request.
  checkMerge(ctx, opts) {
    const o = opts || {};
    // Destination unresolved (undefined passed in, meaning the caller didn't
    // even try) is treated the same as "resolved to null": assume the base
    // branch. Only a POSITIVELY resolved, DIFFERENT branch skips the gate.
    const base = get(ctx.config, 'git.baseBranch', 'main');
    if (o.targetBranch && o.targetBranch !== base) return null;
    const state = markerState(ctx.projectDir);
    if (!state.ok) {
      return {
        deny: `forge merge-gate guard: ${o.what || 'this merge'} is blocked because `
          + `${state.why}. Merging to the base branch is the human's call, not the `
          + 'coordinator\'s. Ask for an explicit "merge", and have it run '
          + `\`touch .git/${MARKER}\` (valid for ${MARKER_MAX_AGE_MS / 60000} minutes).`,
      };
    }
    if (o.requireSquash && get(ctx.config, 'git.squashOnly', true) === true) {
      if (!o.isSquash) {
        return {
          deny: 'forge merge-gate guard: this repository squash-merges only. '
            + 'Re-run with --squash (or set "git": {"squashOnly": false} in '
            + '.claude/forge.json if that policy has genuinely changed).',
        };
      }
    }
    return null;
  },
  check(ctx) {
    const words = ctx.tokens.filter((t) => !t.quoted).map((t) => t.value);
    const isGhMerge = hasUnquotedSequence(ctx.tokens, ['gh', 'pr', 'merge']);
    const gitSub = subcommandAfter(ctx.tokens, 'git', ['-C', '-c', '--git-dir', '--work-tree']);
    const isGitMerge = !!gitSub && gitSub.sub === 'merge';
    if (!isGhMerge && !isGitMerge) return null;

    if (isGhMerge) {
      const identifier = ghMergeIdentifier(ctx.tokens);
      const targetBranch = resolvePrBaseBranch(ctx.projectDir, identifier);
      return module.exports.checkMerge(ctx, {
        what: '`gh pr merge`',
        requireSquash: true,
        isSquash: words.includes('--squash'),
        targetBranch,
      });
    }

    // Local git merge: only gated on the base branch itself.
    const base = get(ctx.config, 'git.baseBranch', 'main');
    const branch = currentBranch(ctx.projectDir);
    if (branch === null) return null; // fail open: detached HEAD or no git
    if (branch !== base) return null;
    return module.exports.checkMerge(ctx, {
      what: `a \`git merge\` while ${base} is checked out`,
      requireSquash: true,
      isSquash: words.includes('--squash'),
    });
  },
};
