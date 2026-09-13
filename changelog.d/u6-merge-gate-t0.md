section: Added
- D17 tier resolver (`plugins/forge/hooks/lib/tier.js`): pure
  `resolveTier(config, changedPaths)`, resolving per path and taking the
  maximum, so a path matching no configured tier is T2 (app code, the safe
  assumption) and a PR spanning tiers gets the most cautious one. A diff of
  docs plus unclassified source is T2, never T0.
- D19 T0 auto-merge CI job (`scripts/t0-auto-merge.js` + a `ci.yml` job):
  enables GitHub auto-merge (squash) for PRs whose diff resolves to T0 and
  posts an owner-mention comment so it is never a silent merge. Both the
  tier config and the decision code itself are read from the base ref, never
  the PR's checkout, and the job verifies the base branch actually has
  required status checks first — the carve-out's safety argument is that
  GitHub holds the merge for those, so without them it declines and leaves
  the PR on the explicit human-merge path. Same-repo PRs only.
- `plugins/forge/templates/CLAUDE.md.framework-block`: the plugin's canonical
  framework block, referenced by `bootstrap` and `audit-framework` (D5) but
  never previously created. Carries the D17 tier table and the merge policy.

section: Fixed
- All four early returns in `t0-auto-merge.js` revoke auto-merge, not just
  two. "Fail open is safe" holds only on the first run — once auto-merge is
  enabled GitHub keeps it across pushes, so a later run that cannot resolve
  the diff or read the base config must not leave a stale grant standing.
- Draft PRs are handled rather than erroring. GitHub refuses auto-merge on a
  draft, and forge's own `pr-create` guard requires `--draft`, so every
  agent-opened PR would have reddened this job on its `opened` event. Known
  gap, deliberately left: a T0 PR marked ready with no further push does not
  re-run the job. Listening for `ready_for_review` on the shared trigger was
  tried and reverted — skipping the other jobs on that event replaced their
  real check runs with `skipped` ones, which branch protection counts as
  passing, so a draft that went red could be marked ready and auto-merge.
  The correct shape (the T0 job in its own workflow on `pull_request_target`,
  which needs no PR checkout and so also stops a PR editing the workflow that
  judges it) is recorded in D19 as its own unit.
- The comment-failure path revokes its own grant unconditionally. It is the
  one caller that knows the grant is this run's, yet it routed through
  attribution — so an unverified `enabledBy` login, a missing one, or a
  double read failure would have logged "left alone" and let the PR merge
  with nobody cc'd. It now passes `assumeOurs`, which skips attribution but
  still honours "positively not enabled" as a no-op.
- The enable is never re-issued over an existing grant. `gh pr merge --auto
  --squash` ran unconditionally on every T0 run, so a person who had enabled
  auto-merge with merge or rebase had their method silently rewritten to
  squash. An existing grant is now left exactly as it is.
- An enabled grant whose enabler cannot be read is no longer treated as a
  person's opt-in and left alone. "Leave it alone" is right only once a
  person is positively identified; an unattributed grant may be a stale one
  of this workflow's, so the job goes red with a warning and a human checks.
- The owner notification can no longer be lost for the life of a PR. The
  "already enabled?" read before posting is retried once, and if still
  unreadable the comment is posted anyway — on a PR's first run there is no
  comment loop to avoid, and skipping meant every later run saw the grant
  this run had made and skipped too, so the PR merged with nobody cc'd.
- `scripts/tests/t0-auto-merge.test.js`: 14 cases against a stub `gh`
  pinning every branch of the revoke logic — our grant revoked, a person's
  left alone, an unattributed one red, unreadable-twice red with no blind
  disable, unreadable-once retried, a failed disable red — plus the state
  tri-state and both spellings of the Actions login. Wired into `validate`.
- Two `parseSummary` regression cases for the annotated and trailing-"and"
  summary lines, in `reviewer-clean-check.test.js`.
- The T0 job runs with `pull-requests: read` as well as `contents: read`
  until it moves to its own workflow: an appended step inherits any granted
  scope, and the comment path is unreachable while the enable cannot
  succeed anyway.
- The framework-block template no longer tells adopting projects that CI
  enables T0 auto-merge: the plugin does not ship that job. It is a
  reference implementation in this repository, and until a project installs
  its own copy, T0 PRs merge exactly like T1–T3.
- Comments in `ci.yml` and `t0-auto-merge.js` no longer describe a
  merge-gate T0 carve-out; the hook has none (D19 revised).
- Revocation is scoped to grants this workflow made itself. It reads
  `autoMergeRequest.enabledBy` and leaves a grant a person enabled by hand
  (the GitHub UI path D19 notes merge-gate cannot reach) alone, saying so in
  the log. An unscoped revoke was tearing down human opt-ins on every T1–T3
  PR on every push, while the file header still claimed those tiers were
  "left alone". The header now states the real invariant.
- When auto-merge is enabled but the token lacks the scope to act (the job
  deliberately ships `contents: read` until it moves to its own
  `pull_request_target` workflow), or the repository disallows squash
  merges, the job declines the fast path and stays green like every other
  decline — instead of going red the moment branch protection is turned on.
- The draft early return revokes auto-merge like every other early return.
  A PR that was T0 and got auto-merge, was converted back to draft, then
  gained a T3 commit would otherwise return before re-resolving the tier and
  keep the grant.
- When the auto-merge state cannot be read AND the defensive
  `--disable-auto` fails — one realistic cause, a transient GitHub outage,
  and exactly when auto-merge may in fact be on — the job re-reads once and
  goes red with a warning unless the re-read confirms not-enabled. The
  previous fix had made that path silently green.
- The T0 job runs with `contents: read` for now, deliberately below what
  enabling auto-merge needs. The workflow file comes from the PR's merge ref,
  so a PR could append a step and inherit a write token; the feature is
  dormant until branch protection exists, so nothing is lost by withholding
  the scope until the job moves to its own `pull_request_target` workflow.
- `bootstrap` and `audit-framework` name the canonical framework-block path
  and its markers, so D5's drift check has a stated file to diff against.
- `revokeAutoMergeIfEnabled` no longer reddens the job with a false "may still
  merge unattended" warning when the auto-merge state merely could not be
  read. The defensive `--disable-auto` fails on any PR that never had
  auto-merge — every ordinary PR — and that is informational, not an alarm;
  the warning and non-zero exit are reserved for the case where auto-merge
  was positively observed enabled and the disable still failed.
- The branch-protection blocker is recorded under D20 (branch protection =
  required status checks), not D26 (U4 rows), and the two citations in
  `t0-auto-merge.js` corrected to match.
- `t0-auto-merge.js` re-asserts the tier decision on every run instead of only
  the first. GitHub does not clear auto-merge on an ordinary push, so a
  docs-only PR that resolved T0 and got auto-merge enabled, then gained a
  commit touching `src/payments/**`, would re-run, resolve T3, log "not T0",
  return — and still merge unattended with the T3 code in it. Both paths that
  mean "may not take the fast path" now revoke auto-merge.
- A failed owner notification revokes auto-merge rather than leaving it on.
  Previously the run exited non-zero with auto-merge enabled, and the next
  `synchronize` saw it already enabled and skipped the comment permanently —
  so the PR merged with nobody told, the one outcome the notification exists
  to prevent.
- `autoMergeAlreadyEnabled()` is tri-state. Collapsing "couldn't tell" into
  "not enabled" re-posted the identical `cc @owner` comment on every push
  whenever `gh pr view` had a transient failure; unknown now counts as
  enabled for the comment, and as enabled for revocation too (attempting
  `--disable-auto` when it was off is harmless).
- `scripts/reviewer-clean-check.js` parses a summary line whose counts carry
  a parenthetical annotation. A real reviewer wrote "4 security issues (1
  pre-existing and already tracked)," and the strict form failed the whole
  check with "could not find the reviewer's required summary line" — a
  required status failing for a formatting reason on a review that had
  completed.

section: Changed
- The framework-block template no longer promises adopting projects an
  unconditional merge gate. It is unconditional *by tier*, but D27's
  tokenizer bypass — quoting one word, `gh "pr" merge 7 --squash` — still
  slips past the guard entirely. The template now states that gap instead of
  asserting a guarantee the code does not enforce.
- The merge-gate hook deliberately has **no** T0 exception: every merge into
  the base branch requires the human marker, at every tier. The T0 fast path
  is CI's job and does not pass through the hook, so the agent never needed
  one. See D19 in `docs/decisions.md` for why the earlier hook-side exception
  was removed rather than fixed — deciding it meant hand-parsing `gh`'s flag
  grammar, which was bypassable five different ways.
