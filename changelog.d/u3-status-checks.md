section: Added
- U3 status checks (D20 built): a required `forge validators` CI check
  (manifest/frontmatter validation plus a new dependency-free changelog
  fragment shape validator, `scripts/validate-changelog.js`, D21) and a
  `reviewer clean` commit status that dispatches the `forge:reviewer` agent
  headlessly via `claude -p` (`scripts/reviewer-clean-check.js`) against a
  PR's diff. Both jobs reuse the `CORP_RUNNER` gate already in `ci.yml` to
  pick a runner, but `forge validators` always runs its checks regardless
  of which runner it lands on; only `reviewer clean` skips gracefully (a
  `success` status with a `skipped: <reason>` description) off the
  self-hosted runner. `reviewer clean` reuses the runner's existing
  `claude` login — no new secret — and also skips gracefully if `claude`
  is missing or unauthenticated there.

section: Fixed
- `reviewer-clean-check.js`: build the statuses-API request from
  `GITHUB_API_URL`'s full path, not just its hostname, so posting a status
  works on GitHub Enterprise (`/api/v3` prefix) as well as github.com.
- `reviewer-clean-check.js`: only skip (report success) on a `claude`
  invocation error when the binary genuinely didn't start (`ENOENT`);
  other spawn errors now fail the check instead of silently passing it.
- `reviewer-clean-check.js`: parse the reviewer's *last* matching summary
  line instead of the first, so earlier example/quoted text with the same
  shape can't be mistaken for the required closing summary.
- `validate-changelog.js` / `changelog-closeout.js`: error and status
  messages now reference the configured `changelog.fragmentsDir` instead
  of hard-coding `changelog.d/`.
- `changelog-closeout.js`: report (and exit non-zero on) any fragment file
  that fails to delete after assembly, instead of silently leaving it to
  be duplicated into the changelog on the next close-out run.
- `docs/decisions.md` / this fragment: corrected the claim that both CI
  jobs skip on the GitHub-hosted fallback — only `reviewer clean` does;
  `forge validators` always runs its checks on whichever runner it lands
  on.
