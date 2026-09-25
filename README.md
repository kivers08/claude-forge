# claude-forge

**Version 0.2.1** · See `CHANGELOG.md` for what shipped in each release.

## What forge is

**forge** is a reusable "way of working" that you install into any of your
projects so that Claude Code builds software for you the same careful way every
time. Instead of Claude improvising a fresh approach in each new repo, forge
gives it a consistent set of habits: how work gets planned, who does each job,
what safety rules always apply, and how lessons carry forward. Think of it as
the jump-off point you drop into every new project so the assistant is
productive and safe from day one — no re-explaining your standards each time.

It ships as a Claude Code plugin (`forge`) that you install from this repo's
own small marketplace. The plugin brings no code of your project's — everything
project-specific lives in one config file you control.

## What you get

- **A repeatable build workflow.** Every piece of work is planned, built,
  reviewed, and closed out in the same order — no matter the project or the
  day. (This is the *dispatch → implement → review → wrap-up* pipeline: work is
  routed to the right helper, done, checked, and finished cleanly.)

- **The right specialist for each job.** Rather than one generalist doing
  everything, forge hands each task to a purpose-built helper:
  - **implementer** — writes the code/config/docs for a plan that's already
    settled.
  - **bug-fixer** — reproduces one reported bug, finds the real cause, and
    applies the smallest fix plus a test.
  - **test-writer** — adds tests for code that already exists, covering both
    the happy path and the error paths.
  - **reviewer** — reads the changes for correctness, security, and
    convention problems and reports back (never edits or posts on its own).
  - **explorer** — read-only research: finds where things live and how they
    work, citing exact files.
  - **doc-updater** — keeps documentation in step with what the code actually
    does.

- **Safety guardrails that stop risky actions before they happen.** A set of
  automatic checks run in the background whenever Claude tries something:
  - Merging to your main branch is blocked unless *you* explicitly approve it.
  - Pull requests must start as drafts, so nothing looks "ready" prematurely.
  - Real code changes are pushed to dedicated helpers instead of being edited
    in place, keeping your working copy clean.
  - Slow commands are nudged to run in the background, and commands that
    belong to your CI pipeline are kept from running locally by accident.
  - Any secrets (tokens, keys) that slip into a memory note are scrubbed out
    before they're saved.

- **A memory that learns — but only with your approval.** forge keeps notes of
  lessons learned so it gets smarter about your project over time. Crucially,
  **nothing writes itself**: a helper can *propose* a lesson when it finishes,
  and then you (or the main coordinator) decide whether it's worth keeping
  before it's committed. No silent, automatic self-editing of memory.

- **Usage insight, if you want it.** forge can record lightweight metadata
  about which helpers and skills get used and whether they're working — never
  your prompts, your code, or any customer data. It's **off by default**, opt-in
  only, and sends its data to an endpoint *you* choose. Sending is best-effort
  and non-blocking, so it never slows your work down or gets in the way.

- **One-command setup for a new project.** Adopting forge in a fresh repo is a
  single step: run the bootstrap command and it scaffolds everything the project
  needs to work this way (see below).

- **Read-only infrastructure diagnostics, with deploys locked to you.** forge
  can look at hosting logs, errors, and server status to help debug a problem —
  but it can never deploy, restart, or change your servers. Deployment is
  owner-only, always.

## How to install and use it

1. **Register the marketplace and install the plugin** in your project:

   ```
   claude plugin marketplace add kivers08/claude-forge
   claude plugin install forge@claude-forge
   ```

   Or add it to the project's `.claude/settings.json` so the marketplace
   registers automatically when you trust the folder:

   ```json
   {
     "extraKnownMarketplaces": {
       "claude-forge": { "source": { "source": "github", "repo": "kivers08/claude-forge" } }
     },
     "enabledPlugins": { "forge@claude-forge": true }
   }
   ```

2. **Scaffold the project** by running the bootstrap command in a Claude
   session:

   ```
   /forge:bootstrap
   ```

   Bootstrap writes the small "project layer" forge needs — a `.claude/forge.json`
   config file, a plain-language `forge.md` explaining each setting, a framework
   block for your `CLAUDE.md`, starter rule files, and an `.gitattributes` for
   consistent line endings. It asks you about anything genuinely
   project-specific rather than guessing, and it never overwrites files that
   already have real content without checking first.

> **Note on cloud sessions:** in a fresh cloud container, enabling the plugin
> in settings registers the marketplace but does *not* install the plugin
> automatically. The cloud environment's setup script needs to run the two
> `claude plugin ...` commands above before each session. Persistent machines
> (your dev box, WSL2, a VPS) only need that install once.

**Requirements:** Node.js 20+ on your PATH (the guardrails run as small Node
scripts), and Linux or Windows 11 via WSL2. macOS is not supported.

## Configuration

Everything project-specific lives in one file, **`.claude/forge.json`**, created
for you by bootstrap. In plain terms it lets you set:

| Area | What it controls |
|---|---|
| **git** | Your main branch, branch naming, and merge policy (draft PRs, squash-only). |
| **telemetry** | Whether usage insight is on, and where it's sent. Off by default. |
| **memory** | Whether helpers recall past lessons, and the approve-before-saving policy. |
| **tiers** | Risk levels by file area, so sensitive code (money, auth, data) gets extra review. |
| **commands** | Which commands belong to CI, which are slow, and how tests/lint run. |
| **agents** | Per-helper tweaks like which model or effort budget to use. |
| **taskFiles** | Where your working notes (lessons, to-dos, sprint) live. |

**Secrets never go in this file.** Any token forge needs (for example, the
telemetry endpoint's access token) lives in an environment variable — the
config only stores the *name* of that variable, never the value.

## Privacy and safety

- **Telemetry is metadata-only and opt-in.** It is off unless you turn it on,
  it only ever sends structured metadata (which helper/skill ran, and whether
  it succeeded) — never your prompts, responses, code, or customer content —
  and it goes only to an endpoint you configure. Delivery is best-effort.
- **Memory writes are always gated.** Helpers can suggest lessons, but only you
  or the main coordinator commit them. Nothing writes to memory silently, and
  secrets are scrubbed before anything is saved.
- **Claude never deploys.** It can read logs and server status to help you
  debug, but starting or changing a deployment is owner-only.

## Version

**0.2.1** — see `CHANGELOG.md` for the full history (0.1.0 introduced the
tiered workflow and memory core; 0.2.0 added telemetry, the propose→curate
memory loop, and read-only diagnostics; 0.2.1 hardened the merge guard and
telemetry delivery).
