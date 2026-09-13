#!/usr/bin/env node
'use strict';
// D19 T0 auto-merge notifier: runs in CI on `pull_request` events. When the
// PR's changed paths resolve (D17, via plugins/forge/hooks/lib/tier.js —
// reused here, not reimplemented) to tier T0 (docs/bookkeeping), this
// enables GitHub's own auto-merge (`gh pr merge --auto --squash`) and posts
// a PR comment naming the owner, so the T0 exception documented in D19
// (auto-merge relies on GitHub's own wait for required checks in place of
// the human-merge marker) is never a silent merge. The merge-gate HOOK has
// no tier exception at all (D19, revised) — this CI job is the only T0 path.
//
// Every other tier: no grant is ADDED and no comment is posted; the explicit
// human "merge" + merge-gate marker requirement is unaffected. The one thing
// this script does to a T1-T3 PR is WITHDRAW a grant it made itself on an
// earlier run (a PR that was T0 and then gained higher-tier paths) — never a
// grant a human enabled by hand, which it can tell apart by `enabledBy`.
//
// Node builtins only (fs, path, child_process), matching every other script
// in this repo. Reuses `gh` (already required by ci.yml's other steps and
// by merge-gate.js itself) rather than talking to the GitHub API directly.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveTier } = require('../plugins/forge/hooks/lib/tier');

// Normally the repo root two levels up from this file. FORGE_REPO_ROOT lets
// the workflow run a base-ref COPY of this script (see ci.yml) while still
// pointing git at the real checkout.
const ROOT = process.env.FORGE_REPO_ROOT
  ? path.resolve(process.env.FORGE_REPO_ROOT)
  : path.resolve(__dirname, '..');

// Derived from `gh api user` (the authenticated owner's own CLI identity)
// during this unit's implementation, not from any pre-existing in-repo
// PR-comment convention — none existed to reuse (see this unit's report).
// Overridable per-repo via the FORGE_OWNER_HANDLE variable so this isn't
// hardcoded for forks/other consumers of this workflow.
const DEFAULT_OWNER_HANDLE = 'kivers08';

function log(msg) {
  console.log(`t0-auto-merge: ${msg}`);
}

function readEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return null;
  try {
    return JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function ghChangedPaths(prNumber) {
  const r = spawnSync('gh', ['pr', 'diff', String(prNumber), '--name-only'], { encoding: 'utf8' });
  if (r.status !== 0) {
    log(`could not read PR #${prNumber}'s diff (gh exit ${r.status}): ${(r.stderr || '').trim()}`);
    return null;
  }
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

// Reads .claude/forge.json from the base ref. Returns {} when the base ref
// genuinely has no config (resolveTier then yields its T2 default, so no
// auto-merge), or null on a git fault — which fails closed onto the normal
// explicit-merge path rather than guessing.
function baseConfig() {
  const base = process.env.GITHUB_BASE_REF;
  if (!base) {
    log('GITHUB_BASE_REF not set; cannot resolve the base ref config');
    return null;
  }
  const spec = `origin/${base}:.claude/forge.json`;
  // ls-tree, not `cat-file -e`: a path missing from the tree makes cat-file
  // exit 128, indistinguishable from a real fault.
  const probe = spawnSync('git', ['ls-tree', '--name-only', `origin/${base}`, '--', '.claude/forge.json'], {
    cwd: ROOT, encoding: 'utf8',
  });
  if (probe.error || probe.status !== 0) {
    log(`could not probe ${spec}`);
    return null;
  }
  if (!probe.stdout.trim()) return {}; // no config in the base ref
  const r = spawnSync('git', ['show', spec], { cwd: ROOT, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    log(`could not read ${spec}`);
    return null;
  }
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    log(`${spec} is not valid JSON: ${e.message}`);
    return null;
  }
}

// The T0 carve-out's safety argument is "GitHub's own gate stands in for the
// human marker" — GitHub holds an --auto merge until required status checks
// pass. That is only true if the base branch actually HAS required status
// checks. With none configured, `gh pr merge --auto` merges as soon as the PR
// is mergeable, and the exception becomes an unconditional marker-free merge.
// D20 (branch protection = required status checks) is not applied yet, so
  // today that is the live state.
// Verify rather than assume.
function baseHasRequiredChecks(base) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    log('GITHUB_REPOSITORY not set; cannot verify the base branch protection');
    return false;
  }
  // NOT /branches/<base>/protection: that is a protected-branch ADMIN endpoint
  // needing `administration: read`, which `permissions:` cannot grant
  // GITHUB_TOKEN — it 403s, so the feature would never fire and the reason
  // would be invisible. /branches/<base> is readable with `contents: read`
  // and exposes the same `protection.required_status_checks.contexts`.
  //
  // Verified 2026-09-13 against this repo: on a PRIVATE repo in a free org
  // BOTH /protection and /rulesets 403 with "Upgrade to GitHub Pro or make
  // this repository public" — branch protection is not available at all, so
  // this correctly returns false and the carve-out stays dormant. See D20.
  const r = spawnSync('gh', ['api', `repos/${repo}/branches/${base}`], { encoding: 'utf8' });
  if (r.status !== 0) {
    log(`could not read branch "${base}" (gh exit ${r.status}): ${(r.stderr || '').trim()}`);
    return false;
  }
  try {
    const b = JSON.parse(r.stdout);
    const contexts = b && b.protection && b.protection.required_status_checks
      ? b.protection.required_status_checks.contexts
      : null;
    const n = Array.isArray(contexts) ? contexts.length : 0;
    if (!b.protected || n === 0) {
      log(`branch "${base}": protected=${Boolean(b.protected)}, required checks=${n}`);
      return false;
    }
    return true;
  } catch (e) {
    log(`could not parse the branch payload for "${base}": ${e.message}`);
    return false;
  }
}

// Whether GitHub already has auto-merge enabled for this PR. The enable call
// is idempotent, but the notification comment is not: without this, every
// push to a T0 PR appends another identical "cc @owner" comment, since the
// pull_request trigger fires on `synchronize` too.
//
// TRI-STATE: true / false / null for "could not tell". Collapsing null into
// false re-posts the identical comment on every push whenever `gh pr view`
// has a transient failure, which is the unbounded case; callers treat null as
// "assume enabled" for comment purposes (a missed notification is recoverable
// from the job log, a comment loop on a long-lived PR is not) and as "assume
// enabled" for revocation too, since attempting --disable-auto when it was
// not enabled is harmless.
// Reads the auto-merge state as { enabled, by }. `enabled` is tri-state:
// true / false / null for "could not tell" (see revokeAutoMergeIfEnabled for
// why the null case matters). `by` is the login that enabled it, or null.
// Parses the JSON itself rather than piping through -q: gh's jq evaluator
// prints an empty line for a null on some versions and the literal string
// "null" on others, and this sidesteps both.
function autoMergeState(prNumber) {
  const r = spawnSync('gh', ['pr', 'view', String(prNumber), '--json', 'autoMergeRequest'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return { enabled: null, by: null };
  try {
    const req = JSON.parse(r.stdout).autoMergeRequest;
    if (!req) return { enabled: false, by: null };
    const by = req.enabledBy && req.enabledBy.login ? req.enabledBy.login : null;
    return { enabled: true, by };
  } catch (e) {
    return { enabled: null, by: null };
  }
}

// Whether a grant was made by this workflow (the Actions app) rather than a
// person. GraphQL reports the app actor's login as "github-actions"; REST
// shows "github-actions[bot]". Accept both. Unverified against a live
// Actions-made grant on this repo — the T0 path is dormant here — so if a
// future run logs "left alone (enabled by github-actions…)" this is where
// to look.
function isOurGrant(by) {
  return typeof by === 'string' && /^github-actions(\[bot\])?$/.test(by);
}

function autoMergeAlreadyEnabled(prNumber) {
  return autoMergeState(prNumber).enabled;
}

// Turns auto-merge back off. Every early return below that means "this PR may
// NOT take the T0 fast path" must call this, because GitHub does not clear
// auto-merge on an ordinary push: a docs-only PR that resolved T0 and got
// auto-merge enabled, then gained a commit touching src/payments/**, re-runs
// this job, resolves T3, and would otherwise still merge unattended with the
// T3 code in it. The tier decision has to be re-asserted on every run, not
// just the first.
// `assumeOurs`: the ONE caller that knows the grant is this run's — the
// comment-failure path right after a successful enable — passes it so that
// attribution cannot talk it out of revoking its own grant. Without it, an
// unverified enabledBy login (or a missing one, or a double read failure)
// would log "left alone" or a warning and leave auto-merge on with nobody
// cc'd — the silent merge that notification exists to prevent.
function revokeAutoMergeIfEnabled(prNumber, why, { assumeOurs = false } = {}) {
  let st = autoMergeState(prNumber);
  if (st.enabled === null) st = autoMergeState(prNumber); // one retry on a transient read failure
  if (st.enabled === false) return; // nothing to withdraw
  if (st.enabled === null && !assumeOurs) {
    // Cannot read the state, so cannot attribute the grant. Disabling blindly
    // could tear down a human's deliberate opt-in; doing nothing could leave a
    // stale grant of ours. Neither is this script's call: go red and say so.
    log(`WARNING: auto-merge state for PR #${prNumber} is unreadable (${why}); a grant may be standing that this run could not assess`);
    process.exitCode = 1;
    return;
  }
  if (st.by === null && !assumeOurs) {
    // Enabled, but by whom is unknown (deleted user, a gh JSON-shape change —
    // the login form is itself unverified, see isOurGrant). "Leave it alone"
    // is only the right answer once a PERSON is positively identified; an
    // unattributed grant might be ours and stale. Red, and say so.
    log(`WARNING: auto-merge on PR #${prNumber} is enabled but its enabler could not be read (${why}); it may be a stale grant of this workflow's — a human must check`);
    process.exitCode = 1;
    return;
  }
  if (!assumeOurs && !isOurGrant(st.by)) {
    // A person enabled it via the GitHub UI or gh — the one path merge-gate
    // documents as beyond its reach. That is their decision, not ours.
    log(`auto-merge on PR #${prNumber} was enabled by ${st.by || 'an unknown actor'}, not by this workflow — left alone (${why})`);
    return;
  }
  const r = spawnSync('gh', ['pr', 'merge', String(prNumber), '--disable-auto'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    log(`WARNING: could not disable this workflow's own auto-merge grant on PR #${prNumber} (${why}); `
      + `it may still merge unattended: ${(r.stderr || '').trim()}`);
    process.exitCode = 1;
    return;
  }
  log(`auto-merge DISABLED for PR #${prNumber}: ${why}`);
}

function main() {
  const event = readEvent();
  const pr = event && event.pull_request;
  if (!pr) {
    log('not a pull_request event (no GITHUB_EVENT_PATH pull_request payload); nothing to do');
    return;
  }
  const prNumber = pr.number;

  // Draft PRs: GitHub refuses to enable auto-merge on one, so `gh pr merge
  // --auto` would fail and redden this job on every agent-opened PR — forge's
  // own pr-create guard requires --draft when git.draftPrRequired is set,
  // which is the default. Not an error, just "not yet". KNOWN GAP: ci.yml uses
  // the default pull_request types, which exclude ready_for_review, so a PR
  // marked ready with no further push does not re-run this job. Adding
  // ready_for_review to the SHARED trigger was tried and reverted: skipping the
  // other jobs on that event replaced their real check runs with `skipped`
  // ones, which branch protection counts as success, so a draft that went red
  // could be marked ready and auto-merge on that same event. The correct shape
  // is this job in its own workflow on pull_request_target (it needs no PR
  // checkout at all) — tracked in D19, its own unit.
  if (pr.draft) {
    log(`PR #${prNumber} is a draft; auto-merge cannot be enabled yet — push after marking ready to re-decide`);
    // Same invariant as every other early return: a PR that was T0 and got
    // auto-merge, was converted BACK to draft, then gained a T3 commit would
    // return here before the tier is re-resolved and keep the grant. GitHub
    // probably clears auto-merge on draft conversion, but "probably" is the
    // assumption this function exists to remove.
    revokeAutoMergeIfEnabled(prNumber, 'PR is a draft');
    return;
  }

  const changedPaths = ghChangedPaths(prNumber);
  if (changedPaths === null) {
    // "Fail open is safe here" holds only on the FIRST run. Once auto-merge is
    // enabled GitHub keeps it across pushes, so a later run that cannot
    // determine the tier must not leave a stale grant standing — otherwise a
    // docs-only PR that went T0 merges unattended after a push this run could
    // not classify. Revoking on a transient failure is the safe direction: the
    // next synchronize re-enables it for a genuine T0 PR.
    log('could not resolve the PR diff; leaving this PR on the normal explicit-merge path');
    revokeAutoMergeIfEnabled(prNumber, 'could not resolve the PR diff');
    return;
  }

  // Config comes from the BASE ref, never the PR's own checkout. The tier
  // decides whether this PR skips the human-merge marker entirely, so reading
  // `tiers.T0.paths` out of PR-controlled content would let a PR declare
  // itself T0 — adding `.claude/forge.json` with `T0.paths: ["**"]` in the
  // same commit it wants auto-merged. Same trust-boundary rule the reviewer
  // system prompt follows in reviewer-clean-check.js: every input to a
  // security decision must come from a ref the PR author cannot write.
  const config = baseConfig();
  if (config === null) {
    // Same reasoning as the diff-failure path above: a stale grant outlives
    // the run that made it.
    log('could not read the base ref config; leaving this PR on the normal explicit-merge path');
    revokeAutoMergeIfEnabled(prNumber, 'could not read the base ref config');
    return;
  }
  const tier = resolveTier(config, changedPaths);
  log(`PR #${prNumber} resolved to tier ${tier} (${changedPaths.length} changed path(s))`);
  if (tier !== 'T0') {
    log('not T0 — leaving the explicit human "merge" + merge-gate marker requirement (D19) in place');
    revokeAutoMergeIfEnabled(prNumber, `tier escalated to ${tier}`);
    return;
  }

  const base = process.env.GITHUB_BASE_REF;
  if (!baseHasRequiredChecks(base)) {
    log(`base branch "${base}" has no required status checks — the T0 carve-out's`
      + ' safety argument (GitHub waits for them in place of the human marker)'
      + ' does not hold, so auto-merge is NOT enabled; leaving this PR on the'
      + ' normal explicit-merge path');
    revokeAutoMergeIfEnabled(prNumber, 'base branch has no required status checks');
    return;
  }

  // Retried once, and an unreadable state falls through to POSTING the
  // comment. "Unknown => assume enabled" is right on run N (it avoids a
  // comment loop), but on a PR's first run there is no loop to avoid and the
  // cost of assuming is permanent: every later run reads enabled:true
  // (correctly — this run enabled it) and skips the comment too, so the PR
  // merges unattended with nobody cc'd. A rare duplicate comment is cheaper.
  let st = autoMergeState(prNumber);
  if (st.enabled === null) st = autoMergeState(prNumber);
  if (st.enabled === true) {
    // Do NOT re-issue `--auto --squash` over an existing grant: if a person
    // enabled auto-merge with merge or rebase, that would silently rewrite
    // their chosen method. The enable is a no-op we can skip, and the
    // notification was posted when the grant was first made.
    log(`auto-merge already enabled on PR #${prNumber} (by ${st.by || 'unknown'}); leaving it as is, not repeating the notification`);
    return;
  }
  const enable = spawnSync('gh', ['pr', 'merge', String(prNumber), '--auto', '--squash'], { encoding: 'utf8' });
  if (enable.error || enable.status !== 0) {
    const err = (enable.stderr || '').trim();
    // Two refusals are "cannot take the fast path", not faults, and decline
    // gracefully like every other path in this script: the token lacks the
    // scope (the job ships contents: read on purpose until it moves to its
    // own pull_request_target workflow — see ci.yml), or the repository
    // does not allow squash merges (this script hard-codes --squash and does
    // not consult git.squashOnly). Anything else is unexpected and stays red.
    if (/not accessible by integration|403|Resource not accessible|squash merges? (is|are) not (allowed|enabled)|merge method/i.test(err)) {
      log(`cannot enable auto-merge (${err}); leaving this PR on the normal explicit-merge path`);
      return;
    }
    log(`gh pr merge --auto --squash failed (exit ${enable.status}): ${err}`);
    process.exitCode = 1;
    return;
  }
  log(`auto-merge enabled for PR #${prNumber} (squash) — GitHub will merge it once required checks pass`);

  if (st.enabled === null) {
    log('auto-merge state unreadable after retry; posting the notification rather than risk a silent merge');
  }

  const ownerHandle = process.env.FORGE_OWNER_HANDLE || DEFAULT_OWNER_HANDLE;
  const body = [
    'forge: this PR resolved to tier **T0** (docs/bookkeeping, D17). Per D19,',
    'GitHub auto-merge (squash) has been enabled — this will merge',
    'automatically once required status checks are green, with no explicit',
    'human "merge" needed for this tier.',
    '',
    `cc @${ownerHandle} — flagging so this doesn't merge silently.`,
  ].join('\n');
  const comment = spawnSync('gh', ['pr', 'comment', String(prNumber), '--body', body], { encoding: 'utf8' });
  if (comment.error || comment.status !== 0) {
    // Auto-merge is already on at this point, and on the next `synchronize`
    // run autoMergeAlreadyEnabled() would report true and skip the comment
    // forever — so the PR would merge with nobody told, which is the one
    // outcome D19 says this notification exists to prevent. Revoke instead
    // and let the PR fall back to the explicit-merge path.
    log(`could not post the notification comment (exit ${comment.status}): ${(comment.stderr || '').trim()}`);
    revokeAutoMergeIfEnabled(prNumber, 'owner notification could not be posted', { assumeOurs: true });
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
} else {
  // Test seam, matching scripts/reviewer-clean-check.js: this script decides
  // whether a PR may skip the human-merge marker, so its pieces should be
  // reachable from a test without running the whole job.
  module.exports = {
    baseConfig, baseHasRequiredChecks, autoMergeState, autoMergeAlreadyEnabled, revokeAutoMergeIfEnabled, isOurGrant,
  };
}
