'use strict';
// Naive comma splitting of a CSV is wrong the moment a field is quoted or
// contains a comma or newline. Deny `awk -F,` / `cut -d,` aimed at a .csv.
const RE_AWK = /\bawk\b[^|;]*-f\s*['"]?,/;
const RE_CUT = /\bcut\b[^|;]*-d\s*['"]?,/;

function runsUnquoted(tokens, program) {
  return tokens.some((t) => !t.quoted && t.value.toLowerCase() === program);
}

module.exports = {
  name: 'csv-parse',
  check(ctx) {
    const seg = ctx.segmentLower;
    const isAwk = RE_AWK.test(seg) && runsUnquoted(ctx.tokens, 'awk');
    const isCut = RE_CUT.test(seg) && runsUnquoted(ctx.tokens, 'cut');
    if (!isAwk && !isCut) return null;
    if (!ctx.paths.some((p) => /\.csv$/i.test(p))) return null;
    return {
      deny: 'forge csv-parse guard: splitting a CSV on commas with awk/cut breaks '
        + 'on quoted fields, embedded commas and embedded newlines, and it fails '
        + 'silently — the row count still looks right. Parse it with a real CSV '
        + 'reader instead (a short Node script using a parser, or python3 -c '
        + "'import csv, sys; ...'), or state in your report that the file is "
        + 'known to have no quoted fields and re-run with that noted.',
    };
  },
};
