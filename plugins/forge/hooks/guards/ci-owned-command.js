'use strict';
// Some commands belong to CI: a full test suite, a full build, a deploy. Run
// locally they burn minutes and tokens to reproduce what CI will say anyway.
// Config-driven: commands.ciOwned regexes. No config, no guard.
const { get, regexList } = require('../lib/config');

module.exports = {
  name: 'ci-owned-command',
  check(ctx) {
    const patterns = regexList(ctx.config, 'commands.ciOwned');
    if (!patterns.length) return null;
    const hit = patterns.find((p) => p.re.test(ctx.segmentLower));
    if (!hit) return null;
    const example = get(ctx.config, 'commands.scopedTestExample', '');
    const suffix = example
      ? ` Run a scoped command instead, e.g. \`${example}\`, and let CI run the full pass.`
      : ' Run a scoped version instead and let CI run the full pass.';
    return {
      deny: `forge ci-owned-command guard: this command matches commands.ciOwned `
        + `(/${hit.source}/) in .claude/forge.json — CI owns it.${suffix}`,
    };
  },
};
