section: Added
- D22 pipeline skill (`plugins/forge/skills/pipeline/SKILL.md`): formalizes
  the coordinator-followed sequence for one sized unit — implement → review
  → fix loop (capped at 2 rounds, using `scripts/reviewer-clean-check.js`'s
  own "blocking = bugs + security + convention" definition so this skill's
  standard can't drift from what CI enforces) → changelog close-out →
  merge-base refresh (flags risk, never rebases itself) → a readiness report
  (tier via `tier.js`'s `resolveTier`, what changed, what verified it,
  risks). Explicitly documented as a process for the coordinator to follow,
  not an automated script — a headless per-step variant is named as a
  separate, out-of-scope, higher-risk undertaking.
