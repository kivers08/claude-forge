---
name: brainstorm
description: Settle a design or approach decision with the human before any schema, code, or file gets built. Use when a request involves an ambiguous data structure, an API/field name that isn't verified, a compliance/legal-sensitive wording choice, or any other fork where guessing would be cheaper but wrong.
---

# brainstorm

Decide before building. This skill exists because jumping to implementation
on an unsettled question is expensive to undo — a wrong schema or API
assumption gets built on top of, not just replaced.

## When to use this

- The request implies a data structure, config shape, or schema that isn't
  already fully specified.
- A field name, endpoint, or behavior depends on an external API/schema the
  human controls — never guess these; say what to verify instead.
- The request conflicts with something stated elsewhere (an earlier decision,
  a documented convention) or can't be verified from what's available.
- Client-facing or compliance-sensitive wording is involved and the specific
  rules aren't already loaded into context.
- Multiple reasonable approaches exist and picking one silently would hide a
  real tradeoff (cost, reversibility, compliance, UX) from the human.

## Process

1. **State the fork explicitly.** Name the specific decision point, not a
   vague "there are some things to consider." If there are 2-4 concrete
   options, lay them out with their real tradeoffs (not a fake "any answer
   works" framing when one option is clearly worse).
2. **Don't guess what you can verify.** If an API/schema field is in
   question, say exactly what to check (an introspection query, a docs page,
   a `describe`/`show` command) rather than presenting a guess as fact.
3. **Flag downsides plainly.** If the human's own suggested direction has a
   real technical, legal/compliance, or reputational downside, say so before
   building it — don't execute silently and let them find the problem later.
4. **Get an explicit decision**, not an assumed one. A decision is settled
   when the human has actually chosen among the stated options — not when
   you've described the options and moved on.
5. **Record it.** Write the decision to the project's `taskFiles.decisionsLog`
   (from `.claude/forge.json`) in enough detail that a later reader
   understands what was decided and why, not just the conclusion.
6. **Only then** hand off to `dispatch` / an implementer-class agent to build
   it.

## What this skill is not

- Not a substitute for asking a quick clarifying question mid-task when the
  ambiguity is small and low-stakes — use judgment; this skill is for
  decisions substantial enough to warrant a recorded, deliberate choice.
- Not a place to build anything. If you catch yourself writing schema, code,
  or a scaffolded file before the decision is confirmed, stop — that's the
  exact failure mode this skill exists to prevent.
