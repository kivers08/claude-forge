'use strict';
// Nothing merges to the base branch without a fresh human decision.
//
// Marker: `.git/claude-human-merge-ok`, written by the human, valid for
// MARKER_MAX_AGE_MS after its mtime. A stale marker is not a decision — it is
// yesterday's decision — so age is checked, not just existence.
//
// Scope, deliberately narrow: `gh pr merge` is always gated. A local
// `git merge` is gated ONLY when the current branch is the base branch.
// Merging the base branch INTO a feature branch (the normal way to resolve a
// conflict) is not a merge to main and must not be blocked.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { get } = require('../lib/config');
const { hasUnquotedSequence, subcommandAfter } = require('../lib/segment-split');

const MARKER = 'claude-human-merge-ok';
const MARKER_MAX_AGE_MS = 15 * 60 * 1000;

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

module.exports = {
  name: 'merge-gate',
  // Also called directly by pre-merge-mcp.js for mcp__github__merge_pull_request.
  checkMerge(ctx, opts) {
    const o = opts || {};
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
      return module.exports.checkMerge(ctx, {
        what: '`gh pr merge`',
        requireSquash: true,
        isSquash: words.includes('--squash'),
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
