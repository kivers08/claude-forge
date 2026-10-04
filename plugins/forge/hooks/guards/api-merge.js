'use strict';
// Raw GitHub API routes that merge or write the base branch without going
// through `gh pr merge`: `gh api .../pulls/N/merge`, `.../merges`,
// `.../git/refs/heads/<base>`, and the same with curl. Matched on what the
// request DOES (its path), not on how the command is spelled (D27).
const { get } = require('../lib/config');
const mc = require('../lib/merge-control');

module.exports = {
  name: 'api-merge',
  check(ctx) {
    const lower = ctx.segmentLower;
    if (!/\b(gh\s+api|curl|wget|http)\b/.test(lower) && !/\bgh\b.*\bapi\b/.test(ctx.tokens.map((t) => t.value).join(' ').toLowerCase())) return null;
    const base = get(ctx.config, 'git.baseBranch', 'main');
    const hay = `${lower} ${ctx.tokens.map((t) => t.value).join(' ').toLowerCase()}`;
    const merges = /\/pulls\/\d+\/merge\b/.test(hay) || /\/merges\b/.test(hay) || /\/enable[-_]?auto[-_]?merge/.test(hay)
      || /enablepullrequestautomerge|mergepullrequest/.test(hay);
    const refWrite = hay.includes(`git/refs/heads/${base}`) || hay.includes(`git/refs/heads%2f${base}`);
    if (!merges && !refWrite) return null;
    return mc.gate(ctx, { what: 'a raw GitHub API call that merges or writes the base branch' });
  },
};
