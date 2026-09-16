section: Security
- The `reviewer clean` CI job now runs its decision code from the base ref,
  not the PR's own checkout. Previously a PR could edit
  `scripts/reviewer-clean-check.js` to delete its own ack/token, truncation,
  and instruction-surface gates and post `success` — the same hole the D19
  T0 auto-merge job already closes for its merge decision. The job extracts
  `scripts` from `origin/<base>` into `$RUNNER_TEMP` and runs that copy;
  `reviewer-clean-check.js` gained the `FORGE_REPO_ROOT` override (mirroring
  `t0-auto-merge.js`) so the base-ref copy still points git, the diff file,
  and `--add-dir` at the real checkout. A one-commit bootstrap fallback runs
  the PR's own copy only while the base ref predates the override. The
  residual — a PR appending a step to the workflow job itself, closable only
  by `pull_request_target` plus branch protection on `.github/workflows/` —
  is recorded in `docs/decisions.md` D20.

section: Changed
- `computeAndWriteDiff`'s duplicated truncation logic is factored into a pure
  `capText(text, max, kind)` helper, exported for tests. No behavior change
  beyond the truncation note now naming which block (body vs. file list) was
  cut.

section: Added
- Unit tests for the truncation gate (`capText`) — the body-blocks /
  file-list-only-annotates asymmetry the D20/D26 mechanics depend on.
