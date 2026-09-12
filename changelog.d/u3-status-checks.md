section: Added
- U3 status checks (D20 built): a required `forge validators` CI check
  (manifest/frontmatter validation plus a new dependency-free changelog
  fragment shape validator, `scripts/validate-changelog.js`, D21) and a
  `reviewer clean` commit status that dispatches the `forge:reviewer` agent
  headlessly via `claude -p` (`scripts/reviewer-clean-check.js`) against a
  PR's diff. Both run only on the self-hosted runner (reusing the
  `CORP_RUNNER` gate already in `ci.yml`) and skip gracefully on the
  GitHub-hosted fallback rather than failing the build. `reviewer clean`
  reuses the runner's existing `claude` login — no new secret — and skips
  gracefully if `claude` is missing or unauthenticated.
