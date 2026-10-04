'use strict';
// Nothing merges INTO THE BASE BRANCH without a fresh human decision.
//
// The decision itself (legacy marker, spoken marker, one-tap ask, single-use,
// 15-minute lifetime) lives in lib/merge-control.js and is shared with the
// other routes onto the base branch (push, raw API, GitHub file tools).
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
const { spawnSync } = require('child_process');
const { get } = require('../lib/config');
const { hasUnquotedSequence, subcommandAfter } = require('../lib/segment-split');
const mc = require('../lib/merge-control');

// Resolves the PR's base ref (the branch it merges INTO) via `gh pr view`.
// Returns null when it cannot be determined — caller treats null as "assume
// the base branch" (fail-safe, see comment above).
function resolvePrBaseBranch(cwd, identifier, slug) {
  const args = ['pr', 'view'];
  if (identifier) args.push(String(identifier));
  args.push('--json', 'baseRefName', '-q', '.baseRefName');
  if (slug) args.push('--repo', slug);
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

function currentBranch(cwd) {
  if (!cwd) return null;
  const r = spawnSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
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
    return mc.gate(ctx, o);
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
      const num = Number(identifier);
      return module.exports.checkMerge(ctx, {
        what: '`gh pr merge`',
        pr: Number.isFinite(num) && /^\d+$/.test(String(identifier)) ? num : undefined,
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
