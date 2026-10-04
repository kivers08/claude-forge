'use strict';
// `git push` that would land on the base branch needs the same human decision
// as a merge into it. Without this a `git push origin HEAD:main` is a side
// door around the merge gate.
//
// Destination forms recognised (the git-refspec guard already forces an
// explicit destination, so these are the shapes that arrive):
//   git push origin main              git push origin <src>:main
//   git push origin refs/heads/main   git push / git push origin   (current
//                                     branch IS the base branch)
// Deletes (`--delete`, `:main`) are treated as pushes to the base too: removing
// the base branch is at least as serious as writing to it.
const { get } = require('../lib/config');
const { subcommandAfter } = require('../lib/segment-split');
const mc = require('../lib/merge-control');
const { spawnSync } = require('child_process');

const GIT_FLAGS_WITH_VALUE = ['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'];

function currentBranch(cwd) {
  if (!cwd) return null;
  const r = spawnSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

function destinationsOf(rest) {
  // rest = tokens after `push`, quotes already normalised.
  const positional = rest.filter((w) => !w.startsWith('-'));
  const refs = positional.slice(1); // first positional is the remote
  return refs.map((r) => {
    const d = r.includes(':') ? r.split(':').pop() : r;
    return d.replace(/^refs\/heads\//, '').replace(/^\+/, '');
  });
}

module.exports = {
  name: 'push-base',
  check(ctx) {
    const found = subcommandAfter(ctx.tokens, 'git', GIT_FLAGS_WITH_VALUE);
    if (!found || found.sub !== 'push') return null;
    const base = get(ctx.config, 'git.baseBranch', 'main');
    // `git -C <dir> push`: judge the branch and the marker in THAT repository.
    const workDir = mc.gitWorkDir(ctx.tokens, ctx.projectDir);
    const rest = ctx.tokens.slice(found.index + 1).filter((t) => !t.quoted).map((t) => t.value);
    // `HEAD` means "the current branch", so resolve it before comparing.
    const dests = destinationsOf(rest).map((d) => (d === 'HEAD' ? currentBranch(workDir) || d : d));

    let hitsBase = dests.includes(base);
    if (!hitsBase && dests.length === 0) {
      // Bare `git push` / `git push origin`: goes where the current branch goes.
      hitsBase = currentBranch(workDir) === base;
    }
    if (!hitsBase) return null;
    return mc.gate({ ...ctx, projectDir: workDir }, { what: `\`git push\` to ${base}` });
  },
};
