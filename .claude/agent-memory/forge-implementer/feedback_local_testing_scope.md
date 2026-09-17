---
id: cd54e2bd-f1c2-40be-b064-15456157a690
type: lesson
scope: implementer
tier: semantic
importance: 0.5
created: "2026-09-17T01:17:45.812Z"
lastUsed: null
uses: 0
source: authored
supersedes: null
name: feedback-local-testing-scope
description: In claude-forge, run only scoped tests locally against touched files — full CI suites belong on the CI runner, not the implementer's own session.
metadata:
  type: feedback
---

When implementing a unit in this repo, only run scoped checks locally
against files actually touched (e.g. `node --check` on new/changed `.js`
files, `node scripts/validate-plugins.js --strict`, a targeted hook-test
invocation if `plugins/forge/hooks/tests/` was touched). Do not run the
full CI suite (`plugins/forge/hooks/tests/run.js` unscoped, the whole
`ci.yml` workflow, etc.) as a local substitute for CI.

**Why:** stated explicitly as the owner's testing-discipline instruction
for implementer dispatches — full/complete test runs belong on the CI
runner (self-hosted `kewi-dev`, gated by the `CORP_RUNNER` variable — see
[[project_child_unit_branches]] for the branch convention this pairs with
CI-wise), not duplicated in the agent's own sandboxed session.

**How to apply:** for new Node scripts, do exercise them with a
deliberately-malformed or representative input locally (e.g. a broken
changelog fragment, a fake skip-path env var) to confirm pass/fail logic —
that's "testing what you touched," distinct from running the full suite.
