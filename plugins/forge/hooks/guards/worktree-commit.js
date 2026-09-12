'use strict';
// Committing a branch that another worktree also has checked out produces two
// divergent views of the same ref: one worktree commits, the other still shows
// the old HEAD and its index goes stale. Git itself only refuses `checkout`,
// not `commit`, so this is the gap.
const path = require('path');
const { spawnSync } = require('child_process');
const { subcommandAfter } = require('../lib/segment-split');

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

function samePath(a, b) {
  const norm = (p) => path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
  return norm(a) === norm(b);
}

module.exports = {
  name: 'worktree-commit',
  check(ctx) {
    const found = subcommandAfter(ctx.tokens, 'git', ['-C', '-c', '--git-dir', '--work-tree']);
    if (!found || found.sub !== 'commit') return null;

    const branch = (git(ctx.projectDir, ['branch', '--show-current']) || '').trim();
    if (!branch) return null; // detached HEAD or no git: fail open

    const porcelain = git(ctx.projectDir, ['worktree', 'list', '--porcelain']);
    if (!porcelain) return null;

    // Records are blank-line separated: `worktree <path>` then `branch refs/heads/<name>`.
    let currentPath = null;
    for (const record of porcelain.split(/\n\s*\n/)) {
      let wtPath = null;
      let wtBranch = null;
      for (const line of record.split('\n')) {
        if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length).trim();
        else if (line.startsWith('branch ')) wtBranch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      }
      if (!wtPath || wtBranch !== branch) continue;
      if (samePath(wtPath, ctx.projectDir)) { currentPath = wtPath; continue; }
      return {
        deny: `forge worktree-commit guard: branch "${branch}" is also checked out in `
          + `the worktree at ${wtPath}. Committing from here leaves that worktree `
          + 'pointing at a stale HEAD with a stale index. Either commit from that '
          + 'worktree, or switch this one to its own branch '
          + `(\`git switch -c <new-branch>\`) before committing.`,
      };
    }
    void currentPath;
    return null;
  },
};
