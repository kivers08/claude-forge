---
name: bootstrap
description: Scaffold a project's forge configuration — .claude/forge.json (validated against the plugin's schema), a sibling forge.md explaining each key, the CLAUDE.md framework block, starter .claude/rules/, .gitattributes (LF line endings), and any permissions the project needs. Run once per project when adopting forge.
---

# bootstrap

Writes the project-side "thin layer" forge needs. The plugin itself ships no
project files (D2) — this skill is what creates them, once, per project.
Never overwrite a file that already has real content without confirming with
the human first; bootstrap is meant to scaffold a new adoption, not clobber
an existing configured project.

## What it writes

1. **`.claude/forge.json`** — validated against
   `plugins/forge/schema/forge.schema.json` (draft 2020-12,
   `additionalProperties: false` at every level). Ask the human (via
   `brainstorm`, not a guess) for anything genuinely project-specific before
   writing a value: `git.baseBranch`, `taskFiles.*` paths, `stack.line`,
   `commands.lint`/`commands.deploy`. Defaults that are safe to assume
   without asking: `git.draftPrRequired: true`, `git.squashOnly: true`,
   `taskFiles.caps` at the values documented in `plan-excerpt.md`
   (400/1000/100/100 for lessons/todo/sprint/spoke) unless the project states
   otherwise. Two blocks are always scaffolded with safe, inert defaults
   (never guess a live value for either):
   - `telemetry`: `{ "enabled": false, "mode": "metadata-only" }`. Leave
     `sinkUrl`, `projectKey`, and `tokenEnv` unset — the project fills them in
     only when it opts in (D29). The ingest **token is never stored in
     `forge.json`**: it lives as an environment secret named by `tokenEnv`, and
     `projectKey` must match the identity the sink's token was minted for.
   - `memory`: `{ "recall": true, "writeMode": "propose-curate",
     "excludeFromWrite": [] }`. Built-in auto-memory stays OFF; every write is
     gated through the propose→curate→commit loop (D30). `excludeFromWrite`
     lists agents whose proposals are never persisted (compliance carve-out) —
     empty by default.
2. **`forge.md`** — a sibling file, one paragraph per top-level `forge.json`
   key, explaining what it controls and why the chosen value was picked.
   Written for a human skimming it later, not as schema-description
   boilerplate. Include a paragraph for `telemetry` (off and metadata-only by
   default; when opting in, only structured metadata is emitted — never
   prompt/response or customer content; the ingest token is an env secret named
   by `tokenEnv`, never committed, and `projectKey` must match what the sink's
   token was minted for) and one for `memory` (recall on, writes gated through
   propose→curate→commit with built-in auto-memory kept off, and
   `excludeFromWrite` naming any agents whose proposals are never persisted).
3. **CLAUDE.md framework block** — a marker-delimited block (clear start/end
   markers so `audit-framework` can diff it later) containing the
   coordinator-facing rules: the tier table (D17), the T0 auto-merge
   exception (D19), the merge-gate contract, and a pointer to `forge.md` for
   config details. This block is copied from the plugin's own canonical copy (`${CLAUDE_PLUGIN_ROOT}/templates/CLAUDE.md.framework-block`, the text between `<!-- forge:framework-block:start -->` and `<!-- forge:framework-block:end -->`) — do not hand-author project-specific wording into it, since
   `audit-framework` compares it verbatim against the plugin's version to
   detect drift.
4. **`.claude/rules/`** — starter path-scoped rule files if the project
   states any (e.g. a payments directory, a webhook handler directory).
   Empty/absent is fine for a project with no such areas yet; don't invent
   rules the project hasn't asked for.
5. **`.gitattributes`** — `* text=auto eol=lf` (D13), unless one already
   exists with a real policy already set (never silently overwrite a
   pre-existing `.gitattributes`).
6. **Permissions** — whatever the project's own tool/command allowlist needs
   for forge's guards to function without excess prompting (this is
   project-side `.claude/settings.json`/`.claude/settings.local.json`
   content; the plugin cannot ship `permissions` itself, D2).

## Process

1. Check for an existing `.claude/forge.json`. If one exists with real
   content, stop and ask the human whether this is meant to reconfigure or
   is a mistake — never silently overwrite.
2. Gather the handful of genuinely project-specific values via `brainstorm`
   if they aren't already stated (base branch, task file paths, stack line,
   lint/deploy commands). Don't guess these.
3. Write the six items above.
4. Validate `.claude/forge.json` against the schema before finishing —
   reuse the same validation logic `scripts/validate-plugins.js` uses for
   the plugin's own schema checks, applied here to the instance document.
5. Report what was written, what was asked vs. defaulted, and anything the
   human should double check.
