'use strict';
// Reminder, not a deny: a long command run in the foreground blocks the session
// and risks a timeout that loses its output entirely.
const { regexList } = require('../lib/config');

module.exports = {
  name: 'slow-command',
  check(ctx) {
    const patterns = regexList(ctx.config, 'commands.slow');
    if (!patterns.length) return null;
    const hit = patterns.find((p) => p.re.test(ctx.segmentLower));
    if (!hit) return null;
    return {
      remind: `forge slow-command: this matches commands.slow (/${hit.source}/). `
        + 'Run it in the background and poll, rather than blocking the session on it. '
        + 'If it is already backgrounded, ignore this.',
    };
  },
};
