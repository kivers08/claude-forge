'use strict';
// The merge markers are the HUMAN's decision. An agent that can write one has
// decided for itself, so any Bash command that names a marker file is denied.
// (String match: a command that builds the name by concatenation could evade it;
// real enforcement of "nothing reaches main" is GitHub branch protection. This
// guard closes the plain, accidental and lazy routes.)
module.exports = {
  name: 'marker-write',
  check(ctx) {
    const text = `${ctx.segmentLower} ${ctx.tokens.map((t) => t.value).join(' ').toLowerCase()}`;
    if (!/claude-human-merge-ok|merge-ok\.json/.test(text)) return null;
    // Only a command that could WRITE counts: a redirect or a write-capable
    // program. Reading it, grepping for it, or merely mentioning the name in a
    // commit message or document is harmless.
    const writes = />|(^|[\s;&|(])(touch|tee|rm|mv|cp|ln|truncate|install|dd|unlink|sed|python3?|node|perl|ruby|printf|echo|chmod|chown)(\s|$)/.test(text);
    if (!writes || /^\s*git\s+(-[^\s]+\s+)*(commit|add|log|diff|show|status)\b/.test(ctx.segmentLower)) return null;
    return {
      deny: 'forge marker-write guard: the merge marker records the HUMAN\'s decision and may not be '
        + 'created, edited or removed by the agent. Ask the human to say "merge" (when the project has '
        + 'enabled merge.spokenWord) or to approve the prompt.',
    };
  },
};
