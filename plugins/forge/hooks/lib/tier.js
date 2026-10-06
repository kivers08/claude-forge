'use strict';
// Resolves the risk tier (D17) for a set of changed paths against the
// project's `.claude/forge.json` `tiers.<T>.paths` glob lists (see
// forge.schema.json's own `tiers` block and dispatch/SKILL.md's "Resolve
// the tier" step, which this module exists to give a single, reusable
// implementation of instead of leaving every caller — merge-gate.js, the
// D19 CI notifier, dispatch itself — to reimplement the same match loop).
//
// Highest matching tier wins: T0 < T1 < T2 < T3 in caution, so if a diff's
// changed paths match both a T0 pattern and a T3 pattern, T3 wins — the
// more cautious tier always wins a tie, never the more permissive one.
//
// No `tiers` config at all, or changed paths that match none of them,
// resolves to T2 (app code) — the safe default named explicitly in D17.
// This must never silently resolve to T0: an unconfigured project must not
// get the lightest gates just because nothing told it otherwise.
const { get } = require('./config');
const { matchAny } = require('./glob');

const TIERS = ['T0', 'T1', 'T2', 'T3'];
const DEFAULT_TIER = 'T2';

// (config, changedPaths) -> 'T0'|'T1'|'T2'|'T3'. Pure: callers resolve the
// actual changed paths themselves (e.g. via `git diff --name-only` or
// `gh pr diff --name-only`) and pass them in, matching this repo's lib/
// convention of keeping process/IO out of lib modules (see config.js,
// glob.js — neither shells out either).
// Resolution is PER PATH, then the maximum across paths — not "which tiers
// did any path match". The difference is the whole safety property: a path
// matching no tier is itself T2, so a PR touching one doc plus one
// unclassified source file is T2, not T0. Scanning tiers globally instead
// let that PR resolve to T0 (only T0's globs matched anything, and an
// unmatched path contributed nothing), which gave arbitrary source
// the lightest (docs-only) gates — exactly the "must never
// silently resolve to T0" failure this module's header warns about.
function resolveTier(config, changedPaths) {
  const paths = Array.isArray(changedPaths) ? changedPaths.filter(Boolean) : [];
  if (paths.length === 0) return DEFAULT_TIER;
  const defaultIdx = TIERS.indexOf(DEFAULT_TIER);
  let best = -1;
  for (const p of paths) {
    // Per path, the highest matching tier wins; no match at all is the
    // default tier, never "no opinion".
    let idx = defaultIdx;
    for (let i = 0; i < TIERS.length; i += 1) {
      const globs = get(config, `tiers.${TIERS[i]}.paths`, null);
      if (Array.isArray(globs) && globs.length > 0 && matchAny(p, globs)) idx = i;
    }
    if (idx > best) best = idx;
  }
  return TIERS[best];
}

module.exports = { resolveTier, TIERS, DEFAULT_TIER };
