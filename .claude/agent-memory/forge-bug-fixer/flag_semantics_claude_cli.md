---
name: flag-semantics-claude-cli
description: Empirically-verified claude CLI flag behavior relevant to headless (`claude -p`) dispatch security — don't trust a script's own comments about what a flag does, verify against `claude --help` and a live run.
metadata:
  type: project
---

Verified against the installed `claude` CLI (v2.1.270) while fixing
`scripts/reviewer-clean-check.js` (claude-forge repo, unit U9):

- `--tools <tools...>` only accepts bare tool names ("Read,Glob,Grep"), never
  scoped permission-rule patterns like `Bash(git diff:*)`. A script that
  passes scoped strings to `--tools` under `--restricted` silently grants
  *no* Bash access at all — `--restricted` strips Bash unless `--tools`
  names it, and the scoped string doesn't match the bare name `Bash`.
- `--restricted` does NOT strip MCP servers on its own. `claude --help`
  states this directly: "...managed settings and --settings still apply;
  add `--strict-mcp-config` to skip MCP servers too." A headless child
  spawned with only `--restricted` inherits the parent's full personal MCP
  server config (live credentialed connectors) — a real risk when the
  child is reviewing untrusted content (e.g. a PR diff) on a persistent
  machine.
- `--strict-mcp-config --mcp-config '{}'` fails outright ("Invalid MCP
  configuration: mcpServers: Invalid input") — the working empty-server
  form is `--mcp-config '{"mcpServers":{}}'`.
- `--restricted`'s own help text says "ignores user, project and local
  settings files (managed settings and --settings still apply)" — i.e.
  **managed/global settings under the invoking user's `~/.claude` still
  apply to a `--restricted` child**, even headless. See
  [[headless_reviewer_git_commentary]] for a real consequence of this.

**Why this matters**: a prior version of `reviewer-clean-check.js` had
detailed inline comments confidently describing exactly what these flags
did — the comments were wrong on both counts, and had been silently
wrong since the script was built (every review had been running with zero
Bash access, and the security-critical `--restricted` alone was assumed
sufficient to block MCP inheritance). Don't trust a script's own comments
about CLI flag semantics for a security-relevant claim — verify against
`--help` and a live minimal repro before relying on it.

**How to apply**: any time you're reviewing or writing a `claude -p ...`
invocation that grants/restricts tools for content from an untrusted
source, re-derive the flag semantics from `claude --help` on the actual
installed version rather than trusting existing comments, and prove the
exact flag combination works with a trivial live run before wiring it into
a script other systems depend on.
