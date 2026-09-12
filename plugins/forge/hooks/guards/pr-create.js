'use strict';
// `gh pr create` must be a draft: PRs are always opened as DRAFT.
// Config: git.draftPrRequired, default true.
const { get } = require('../lib/config');
const { hasUnquotedSequence } = require('../lib/segment-split');

module.exports = {
  name: 'pr-create',
  check(ctx) {
    if (get(ctx.config, 'git.draftPrRequired', true) !== true) return null;
    if (!hasUnquotedSequence(ctx.tokens, ['gh', 'pr', 'create'])) return null;
    const hasDraft = ctx.tokens.some((t) => !t.quoted && (t.value === '--draft' || t.value === '-d'));
    if (hasDraft) return null;
    return {
      deny: 'forge pr-create guard: pull requests are always opened as drafts. '
        + 'Re-run the same command with --draft added. If this PR genuinely must '
        + 'open ready-for-review, set "git": {"draftPrRequired": false} in '
        + '.claude/forge.json first.',
    };
  },
};
