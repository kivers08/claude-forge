section: Fixed
- `scripts/validate-changelog.js` and `scripts/changelog-closeout.js` now fail
  closed on a malformed `.claude/forge.json`. Both discarded `load()`'s
  `error` return and silently fell through to the default `changelog.d`/
  `CHANGELOG.md` — so a project that set `changelog.fragmentsDir` and then
  broke its config would get a green `forge validators` computed against a
  directory it never read, and close-out would delete/overwrite the defaults
  while the real fragments sat unread elsewhere. Matches the fail-closed
  posture `t0-auto-merge.js` already takes with the same config.
- `plugins/forge/hooks/subagent-telemetry.js`'s `parseFindings` now accepts a
  summary carrying a digit-bearing parenthetical annotation — e.g. "4 security
  issues (1 pre-existing and already tracked)" — matching
  `reviewer-clean-check.js`'s `parseSummary` byte for byte. The old `\D*?`
  separators could not cross the digit inside such an annotation, so D23
  recorded `findings: null` for precisely the reports whose findings were
  worth annotating.
- `plugins/forge/skills/pipeline/SKILL.md` no longer claims its fix-loop
  threshold is "lifted verbatim" from a `blocking` calculation in
  `reviewer-clean-check.js` that no longer exists. Since the D20 revision the
  CI check is advisory (it never blocks on the finding count), so the skill
  now states plainly that this human-run pipeline — not CI — is what holds
  the line on open bugs/security/convention findings.

section: Changed
- `plugins/forge/skills/pipeline/SKILL.md`'s changelog-fragment template lists
  `Security` as a section, matching `changelog.d/README.md`.

section: Removed
- Dead `autoMergeAlreadyEnabled()` wrapper in `scripts/t0-auto-merge.js` (no
  callers; `main()` uses `autoMergeState()` directly). Its export and the one
  stale comment referencing it are updated.

section: Added
- Unit tests for `baseHasRequiredChecks` in `scripts/tests/t0-auto-merge.test.js`
  — the single precondition guarding a T0 PR's marker-free unattended merge,
  previously untested: no `GITHUB_REPOSITORY`, `gh` non-zero, unparseable
  payload, `protected:false`, empty context list, absent `required_status_checks`,
  and the one true case (protected with a non-empty context list). The stub
  `gh` gained an `api .../branches/<base>` handler.
