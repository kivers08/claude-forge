'use strict';
// Reminder, not a deny: the coordinator edits only what delegation.inlineAllow
// covers; everything else goes to a worker agent. A deny here would be wrong —
// the coordinator legitimately edits outside that set while fixing a guard or
// resolving a conflict — so this states the rule and leaves the call.
const { get } = require('../lib/config');
const glob = require('../lib/glob');

const WRITE_VERBS = /\b(cp|mv|rm|tee|install|touch|mkdir|truncate|dd)\b/;
const REDIRECT = />>?/;
const INPLACE = /\b(sed|perl|awk)\b[^|;]*\s-i\b/;

module.exports = {
  name: 'delegation',
  check(ctx) {
    const inlineAllow = get(ctx.config, 'delegation.inlineAllow', null);
    if (!Array.isArray(inlineAllow) || !inlineAllow.length) return null;
    const writes = WRITE_VERBS.test(ctx.segmentLower) || REDIRECT.test(ctx.segment) || INPLACE.test(ctx.segmentLower);
    if (!writes) return null;

    const projectRel = (p) => {
      const norm = glob.normalize(p);
      const proj = glob.normalize(ctx.projectDir);
      return norm.startsWith(proj + '/') ? norm.slice(proj.length + 1) : norm;
    };
    const outside = ctx.paths
      .map(projectRel)
      .filter((p) => !p.startsWith('/') && !p.startsWith('..'))
      .filter((p) => !glob.matchAny(p, inlineAllow));
    if (!outside.length) return null;

    const delegated = get(ctx.config, 'delegation.delegatedPaths', []);
    const mustDelegate = outside.filter((p) => glob.matchAny(p, delegated));
    const which = mustDelegate.length ? mustDelegate : outside;
    return {
      remind: `forge delegation: ${which.join(', ')} ${which.length === 1 ? 'is' : 'are'} `
        + `outside delegation.inlineAllow${mustDelegate.length ? ' and inside delegation.delegatedPaths' : ''}. `
        + 'Hand this edit to a worker agent rather than doing it inline, unless you '
        + 'are fixing the framework itself.',
    };
  },
};
