'use strict';
// Raw GitHub API routes that merge or write the base branch without going
// through the merge command: `gh api .../pulls/N/merge`, `.../merges`,
// `.../git/refs/heads/<base>`, the auto-merge GraphQL mutations, and the same
// with curl. Matched on what the request DOES (its path), not on how the
// command is spelled (D27).
//
// A pull request merge through the API is judged like any other PR merge:
// its destination is resolved; a merge into a non-base branch must pass the
// child test rule; a merge into the base branch needs the human decision AND a
// provable squash (`merge_method=squash` in the request). Everything else
// (branch merges, ref writes, auto-merge mutations) is a direct write to the
// base branch and needs the human decision.
const { get } = require('../lib/config');
const mc = require('../lib/merge-control');
const mergeGate = require('./merge-gate');

module.exports = {
  name: 'api-merge',
  check(ctx) {
    const lower = ctx.segmentLower;
    const joined = ctx.tokens.map((t) => t.value).join(' ').toLowerCase();
    if (!/\b(gh\s+api|curl|wget|http)\b/.test(lower) && !/\bgh\b.*\bapi\b/.test(joined)) return null;
    const base = get(ctx.config, 'git.baseBranch', 'main');
    const hay = `${lower} ${joined}`;

    const pull = hay.match(/repos\/([^/\s]+\/[^/\s]+)\/pulls\/(\d+)\/merge\b/);
    if (pull) {
      const slug = pull[1];
      const pr = Number(pull[2]);
      const target = mergeGate.resolvePrBaseBranch(ctx.projectDir, pr, slug);
      if (target && target !== base) {
        return mc.childVerdict(ctx, pr, slug, `PR #${pr} (merged through the raw API)`);
      }
      return mc.gate(ctx, {
        what: `merging PR #${pr} through a raw GitHub API call`,
        pr,
        slug,
        targetBranch: target,
        requireSquash: true,
        isSquash: /merge_method[\s"'=:]+squash\b/.test(hay),
      });
    }

    const other = /\/pulls\/\d+\/merge\b/.test(hay) || /\/merges\b/.test(hay)
      || /\/enable[-_]?auto[-_]?merge/.test(hay) || /enablepullrequestautomerge|mergepullrequest/.test(hay)
      || hay.includes(`git/refs/heads/${base}`) || hay.includes(`git/refs/heads%2f${base}`);
    if (!other) return null;
    return mc.gate(ctx, { what: 'a raw GitHub API call that merges or writes the base branch' });
  },
};
