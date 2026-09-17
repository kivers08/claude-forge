section: Changed
- `.github/workflows/ci.yml` now fails fast and bounds its cost on the single
  self-hosted runner. A workflow-level `concurrency` group cancels superseded
  runs per PR (pushes to `main` are exempt), so rapid pushes to a ready PR no
  longer queue whole job sets behind each other on one machine. `reviewer
  clean` now `needs: [validate, forge-validators]` and is also draft-gated
  (`&& github.event.pull_request.draft == false`), so the ~15-minute
  `claude -p` reviewer dispatch — the expensive, self-hosted job this change
  exists to protect — never starts for a PR a ~1s deterministic check already
  rejected or that is still a draft. `ready_for_review` was added to the
  `pull_request` trigger's `types:` alongside the per-job draft gates (rather
  than gating the event itself), so marking a PR ready fires the workflow and
  re-decides every job exactly once. Every job carries an explicit
  `timeout-minutes` (10/5/15/10) in place of the Actions 360-minute default,
  which on a single runner is a wedge rather than a timeout.
- **`T0 auto-merge (D19)` is intentionally exempt from the `needs`/draft
  gating above.** It runs on `ubuntu-latest` (hosted), so gating it would buy
  latency, not the self-hosted VPS time this change is optimizing, and
  `scripts/t0-auto-merge.js` has a draft-triggered revoke path for a stale
  auto-merge grant that a draft gate on this job would make unreachable. See
  the job's own comment in `ci.yml` and D19's 2026-09-17 revision in
  `docs/decisions.md`.
- `validate`'s steps are reordered cheapest-and-broadest-first: the LF-endings
  check runs before `setup-node` (it needs no Node), `node --check` and the
  manifest validator next, then the sub-100ms unit suites, with the ~3s hook
  runs — roughly half the suite's total work — last. `node --check` fans out
  over `xargs -P 4`, since its cost is process spawn rather than parsing. The
  tolerated `claude plugin validate --strict` step now carries its own
  step-level `timeout-minutes: 3` so a stalled optional CLI install cannot
  burn the job's full 10-minute budget and hard-fail `validate` despite
  `continue-on-error: true`.
