'use strict';
// `git push` must name its destination unambiguously.
//
// A bare `git push origin <name>` resolves <name> through the remote's push
// rules: it can land on an unexpected ref when a tag shares the branch name,
// and it silently creates a remote branch with no upstream set, so the next
// bare `git push` may go somewhere else again. Accepted forms:
//   git push -u origin <branch>        (sets upstream; the house convention)
//   git push origin <src>:<dst>        (explicit both ends)
//   git push origin refs/heads/<b>     (fully qualified)
//   git push                           (uses the configured upstream)
// Deletes, --tags, --all and --mirror are branch policy, not this guard.
const { subcommandAfter } = require('../lib/segment-split');

const GIT_FLAGS_WITH_VALUE = ['-c', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'];
const EXEMPT = new Set(['--delete', '-d', '--mirror', '--all', '--tags', '--prune']);

module.exports = {
  name: 'git-refspec',
  check(ctx) {
    const found = subcommandAfter(ctx.tokens, 'git', GIT_FLAGS_WITH_VALUE);
    if (!found || found.sub !== 'push') return null;

    const rest = ctx.tokens.slice(found.index + 1).filter((t) => !t.quoted).map((t) => t.value);
    const flags = rest.filter((w) => w.startsWith('-'));
    const operands = rest.filter((w) => !w.startsWith('-'));

    if (flags.some((f) => f === '-u' || f === '--set-upstream')) return null;
    if (flags.some((f) => EXEMPT.has(f))) return null;
    if (operands.length < 2) return null; // `git push` / `git push origin`: upstream decides

    const bare = operands.slice(1).filter((r) => !r.includes(':') && !r.startsWith('refs/'));
    if (!bare.length) return null;

    return {
      deny: `forge git-refspec guard: "${bare.join(' ')}" is a bare refspec. `
        + 'A bare branch name can resolve to the wrong ref and leaves no upstream '
        + 'set, so the next plain `git push` may go somewhere else. Use '
        + `\`git push -u origin ${bare[0]}\`, or spell the refspec out `
        + `(\`origin ${bare[0]}:${bare[0]}\` or \`origin refs/heads/${bare[0]}\`).`,
    };
  },
};
