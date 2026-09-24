# claude-forge

Private Claude Code plugin (`forge`) and its marketplace, for the owner's own
projects on any stack. Version 0.2.0. See `CHANGELOG.md`.

## What is here

- `plugins/forge/` — the plugin: guard hooks, worker agents, workflow skills,
  and the `.claude/forge.json` schema.
- `plugins/smoke/` — throwaway Phase 0 smoke-test plugin. Deleted once the
  matrix in `docs/phase0-results.md` is filled.
- `.claude-plugin/marketplace.json` — the marketplace listing both plugins by
  local path.
- `.claude/settings.json` — enables the plugins from this repo's own
  marketplace, so any session on this repo is a live smoke test.
- `docs/decisions.md` — settled decisions and verified facts.
- `docs/plan-excerpt.md` — config contract, plugin surface, Phase 0 matrix.

## Prerequisites

- Node.js >= 20 on PATH. Every hook runs as `node <script>`; Node is not
  bundled with Claude Code.
- Linux, or Windows 11 via WSL2. Native Windows requires Git for Windows so
  the Bash tool exists; the PowerShell tool bypasses Bash-command guards.
- No macOS support.
- Git access to this private repo (the marketplace is fetched by git clone).

## Install in another project

```
claude plugin marketplace add kivers08/claude-forge
claude plugin install forge@claude-forge
```

Or add to the project's `.claude/settings.json` so the marketplace registers
on folder trust:

```json
{
  "extraKnownMarketplaces": {
    "claude-forge": { "source": { "source": "github", "repo": "kivers08/claude-forge" } }
  },
  "enabledPlugins": { "forge@claude-forge": true }
}
```

Then run `/forge:bootstrap` to scaffold the project's thin layer
(`.claude/forge.json`, `forge.md`, CLAUDE.md framework block, rules).

## Cloud sessions

Project `enabledPlugins` registers the marketplace but does NOT install the
plugin in a fresh cloud container (Phase 0 check 6). Per D24, the cloud
environment's setup script must run, before each session:

```
claude plugin marketplace add kivers08/claude-forge
claude plugin install forge@claude-forge
```

Persistent machines (dev box, WSL2, VPS) need that install once, not per
session.

## Development

```
node scripts/validate-plugins.js          # manifests + frontmatter, Node only
node plugins/forge/hooks/tests/run.js     # hook unit runs with recorded payloads
claude plugin validate plugins/forge --strict   # when the CLI is available
```

Line endings are forced to LF by `.gitattributes`.
