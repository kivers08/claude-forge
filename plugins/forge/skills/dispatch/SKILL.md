---
name: dispatch
description: Route a unit of work to the right forge worker agent (implementer, bug-fixer, test-writer, reviewer, doc-updater, explorer) with the correct branch, tier, budget, and review model. Use before dispatching any agent for real work.
---

# dispatch

Decide which worker agent handles a unit of work, and hand it a complete,
self-contained dispatch prompt. Never dispatch a worker without doing this
sizing first — a vague prompt with no budget or branch is how agents drift.

## 1. Pick the agent

| Situation | Agent |
| --- | --- |
| A design is settled; write the code/config/docs for it | `implementer` |
| A specific reported bug, root cause unknown | `bug-fixer` |
| Existing code needs tests, none/insufficient exist | `test-writer` |
| A diff needs bugs/security/convention findings | `reviewer` |
| Docs need to catch up to a change | `doc-updater` |
| "Where is X" / "what calls Y" / pure research | `explorer` |

If the unit doesn't fit one agent cleanly (e.g. "fix this bug and add a
test"), split it into two dispatches — `bug-fixer` then `test-writer` — rather
than asking one agent to do both.

## 2. Resolve the tier (D17)

Run `git diff <base>...HEAD --name-only` (or reason from the unit's stated
scope if the branch doesn't exist yet) and match changed/expected paths
against `.claude/forge.json`'s `tiers.T0`–`tiers.T3`. Highest matching tier
wins. No match → **T2** (app code is the safe assumption).

| Tier | Gates (D18) |
| --- | --- |
| T0 (docs/bookkeeping) | validators + one reviewer pass per batch |
| T1 (framework/config) | hook harness + hook tests + reviewer + CI |
| T2 (app code) | implementer → test-writer → reviewer → CI |
| T3 (money/auth/data/deploy) | T2 + security review + owner-facing diff summary |

## 3. Resolve budget and review model (D18 precedence)

For both, apply in this order — first one present wins:

1. An explicit override in the dispatch prompt itself.
2. `tiers.<T>.budget` / `tiers.<T>.reviewModel` for the resolved tier.
3. `agents.<name>.budget` / `agents.reviewer.model` in `.claude/forge.json`.
4. The agent definition's own default.

State the resolved number/model explicitly in the dispatch prompt — never
make the agent re-derive it.

## 4. Resolve the branch

- Use `git.branchPrefix` from `.claude/forge.json` if set, else the repo's
  own convention.
- State the exact branch name in the dispatch prompt. The agent's Subagent
  Git Contract checks its current branch against this string verbatim.
- Default base is `git.baseBranch` (`main` unless configured otherwise).
  State an explicit non-default base only for a deliberate epic/integration
  branch — never leave the agent to assume.

## 5. Write the dispatch prompt

Include, explicitly, every time:
- The scope: what to do and, as important, what NOT to do (out of scope).
- The branch name and base branch.
- The resolved budget (a bare number, not "use your default").
- Where to look first: relevant files, the matching `tasks/lessons.md` topic
  if you already know one, any project convention the unit must follow.
- The report format the agent should already know from its own definition —
  don't restate it unless overriding the default.

## 6. After the agent returns

Read its `### LEARNING` block. A `mistake` other than `none` is a candidate
for `tasks/lessons.md` — but don't append it yourself; that's for
`session-wrap-up` to promote deliberately, not an automatic reflex from every
dispatch.
