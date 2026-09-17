section: Changed
- `.github/workflows/ci.yml` now fails fast and bounds its cost on the single
  self-hosted runner. A workflow-level `concurrency` group cancels superseded
  runs per PR (pushes to `main` are exempt), so rapid pushes to a ready PR no
  longer queue whole job sets behind each other on one machine. `reviewer
  clean` and `T0 auto-merge (D19)` now `needs: [validate, forge-validators]`,
  so the ~15-minute `claude -p` reviewer dispatch and the merge-path job never
  start for a PR a ~1s deterministic check already rejected. Every job carries
  an explicit `timeout-minutes` (10/5/15/10) in place of the Actions 360-minute
  default, which on a single runner is a wedge rather than a timeout.
- `validate`'s steps are reordered cheapest-and-broadest-first: the LF-endings
  check runs before `setup-node` (it needs no Node), `node --check` and the
  manifest validator next, then the sub-100ms unit suites, with the ~3s hook
  runs — roughly half the suite's total work — last. `node --check` fans out
  over `xargs -P 4`, since its cost is process spawn rather than parsing.
