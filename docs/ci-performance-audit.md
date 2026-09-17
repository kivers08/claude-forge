# CI performance audit — self-hosted VPS

Date: 2026-09-17. Scope: `.github/workflows/ci.yml` on the `kewi-dev`
self-hosted runner (`CORP_RUNNER=true`).

## Measured baseline

Every deterministic check, timed on this machine:

| Step | Time |
| --- | --- |
| `node --check` over ~41 files (`xargs -n1`) | 1037 ms |
| `validate-plugins.js --strict` | 1163 ms |
| `validate-changelog.js` | 38 ms |
| `hooks/tests/run.js` (forge) | 3066 ms |
| `hooks/tests/tier.test.js` | 50 ms |
| `.claude/hooks/tests/session-start.test.sh` | 58 ms |
| `tests/reviewer-clean-check.test.js` | 71 ms |
| `tests/changelog.test.js` | 658 ms |
| `tests/t0-auto-merge.test.js` | 980 ms |
| **Total real work** | **≈ 7.1 s** |

The checks are not the cost. There is no `package.json`, so no dependency
install and nothing to cache. CI wall-clock is dominated by per-job overhead
(checkout, `setup-node`, job scheduling), by queueing on the one runner, and
by the `claude -p` reviewer dispatch — which is capped at 15 minutes and is
larger than everything above combined by two orders of magnitude.

## Findings and dispositions

### 1. No concurrency group — FIXED
Four jobs fire per PR event, and `synchronize` fires on every push. With one
runner, a second push while the first run is mid-`reviewer clean` queued a
whole second set behind up to 15 minutes of reviewer time. Added a
workflow-level `concurrency` group keyed on PR number with
`cancel-in-progress` for `pull_request` only.

This is safe for the `reviewer clean` commit status specifically, and the
reasoning matters: that status is posted per head SHA. Cancelling the run for
a superseded SHA cannot strand the SHA anyone would actually merge, because
the new run posts its own status for the new head. Pushes to `main` fall into
per-`run_id` groups and are never cancelled — a main run is the record for an
already-merged commit.

### 2. The expensive job ran unconditionally — FIXED
`reviewer clean` had no `needs`. A PR with a syntax error caught in the first
second of `validate` still paid a full reviewer dispatch: runner occupancy
plus subscription quota, for a diff that cannot merge. It now needs both
deterministic jobs, as does `T0 auto-merge (D19)` — a merge path should not
open before the checks that would block the merge have passed.

**Accepted trade-off, flagged rather than buried:** `reviewer clean` is an API
commit *status*, not a check run, so a skipped job posts nothing at that
context. When a deterministic check fails, that SHA will read *pending* on
`reviewer clean` rather than *failure* once D26 makes the context required.
The PR is unmergeable either way (the deterministic check is red) and the next
push re-runs the chain. If you would rather see an explicit red there, the
alternative is to keep the job ungated and let it post a real failure — at the
cost of the reviewer dispatch this change exists to avoid. I took the cost
saving; say the word and I will flip it.

### 3. No job timeouts — FIXED
Every job inherited the Actions default of 360 minutes. On a single runner
that is not a timeout, it is a six-hour wedge on all other CI. Now 10/5/15/10.
`reviewer clean` already had 15.

### 4. Step ordering did not fail fast — FIXED
The LF-endings check — pure git, no Node, milliseconds — ran second-to-last,
after the entire test suite. It now runs before `setup-node`. The ~3s hook
runs (half the suite's total work) moved to the end, and `node --check` fans
out over `xargs -P 4`, since its cost is process spawn rather than parsing.

### 5. Draft PRs still paid for the full suite — FIXED, with one deliberate
exemption
`validate`, `forge-validators` and `reviewer clean` now each carry
`&& github.event.pull_request.draft == false` (or, for `reviewer clean`,
`draft == false` alongside its existing same-repo/`needs` gates), and
`ready_for_review` was added to the `pull_request` trigger's `types:` so
marking a PR ready fires the workflow and re-decides every job exactly once,
without the event-level skip that would otherwise post `skipped` check runs
branch protection reads as passing (see D19 in `docs/decisions.md` for why
that shape was tried and reverted once already).

**`T0 auto-merge (D19)` does NOT get this gate, and that is deliberate, not
a miss.** An earlier pass of this same change applied the identical
`needs: [validate, forge-validators]` and `draft == false` clauses to it,
by the same reasoning that correctly protects `reviewer clean`. That
reasoning does not transfer: `t0-auto-merge` runs on `ubuntu-latest`
(hosted), so gating it trades away latency, not the self-hosted VPS time this
whole audit is about — there is no expensive job to protect here. Worse,
`scripts/t0-auto-merge.js` REVOKES a stale auto-merge grant when a PR is a
draft (among other cases), and a draft-gated `if:` on the job makes that
revoke unreachable precisely when a PR most needs it — one converted back to
draft after gaining a non-T0 commit would keep a grant no check has since
re-validated. I reverted the gate on this job specifically and left
`reviewer clean`'s untouched. The honest trade-off: if the ENABLE half of
`t0-auto-merge.js` should still wait on the deterministic checks passing,
that belongs inside the script — which can read check-run states itself
before calling `gh pr merge --auto` — not in the workflow `if:`, which cannot
distinguish "don't enable yet" from "don't revoke either."

## Open items — not changed, your call

- **Duplicate `validate-plugins.js --strict`.** It runs in both `validate` and
  `forge-validators` (~1.2s each). The workflow's own comment defends this as
  deliberate: `forge validators` is the name branch protection will require
  (D20) and must not depend on `validate`. I left it. The saving is ~1.2s
  against a documented decision.
- **Two jobs pay a full checkout + `setup-node` for ~7s of work.** Folding
  `forge-validators` into `validate` would cut one job's overhead entirely,
  but costs the independent required-check name above. Not worth it unless
  D20 changes.
- **`fetch-depth: 0` on `reviewer-clean` and `t0-auto-merge`.** Both need base
  history for `git archive origin/$BASE_REF` and merge-base diffs, so depth
  cannot simply drop. `filter: blob:none` would cut the hosted-runner clone on
  `t0-auto-merge`, but it turns those base-ref reads into on-demand promisor
  fetches — a network dependency inside the security-sensitive path that
  extracts trusted decision tooling. I did not change it silently; it is a real
  saving only on the GitHub-hosted job, which does not consume VPS time.
- **Self-hosted workspace growth.** Nothing in this workflow prunes the
  persistent runner's `_work` directory across runs. `RUNNER_TEMP/base-tools`
  is cleared per run, but checkouts accumulate. Worth a cron on the VPS rather
  than a CI step — a cleanup step would run on the critical path of every job.
- **`CORP_RUNNER` is a manual switch.** If the VPS goes down and the variable
  is not flipped, PR jobs queue against an offline runner until they hit the
  new `timeout-minutes` (10 for `validate`) rather than the old 360. That is
  the timeouts earning their keep, but the switch is still manual and still a
  single point of stall.
