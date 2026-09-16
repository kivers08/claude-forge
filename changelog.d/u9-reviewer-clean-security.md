section: Changed
- `reviewer clean` no longer fails a PR on the reviewer's findings. The count
  is not reproducible run to run — on this unit's own PR it rose from 1 bug/2
  security to 2 bugs/3 security after every prior finding was fixed, because
  the reviewer surfaces a different subset each time rather than converging.
  A required check that cannot be driven green by fixing what it reports is
  not a gate. Findings now post in the status description with the full
  report in the job log; the check fails only on reproducible faults — the
  ack/token gate, a truncated diff, a git fault, an unreadable base-ref
  system prompt, or a PR touching the reviewer's own instruction surface.

section: Fixed
- `scripts/reviewer-clean-check.js` never actually granted the headless
  reviewer child the Bash access its prompt assumed: `--tools` accepts only
  bare tool names, so the scoped patterns it passed (`Bash(git diff:*)` and
  friends) granted nothing. Every "review" this required status check had
  posted since D20 was reconstructed from commit-message text without the
  diff. The diff is now computed by the trusted parent process and written
  to a file the child Reads, so the child needs no command-execution surface
  at all (`--tools Read,Glob,Grep`).
- The same child inherited the runner's live MCP connectors while being fed
  untrusted PR diff content: `--restricted` does not strip MCP servers on
  its own. Now pinned with `--strict-mcp-config --mcp-config
  '{"mcpServers":{}}'`.
- The child's captured output was sometimes this repo's own
  `stop-git-check.js` Stop hook commentary rather than the review report —
  project plugin hooks fire inside a `--restricted` child. Now dispatched
  with `--settings '{"disableAllHooks":true}'`.
- `readReviewerSystemPromptFromBase()` reads `plugins/forge/agents/reviewer.md`
  via `git show origin/<base>:...` instead of from the PR's own checked-out
  tree, so a PR can no longer rewrite the instructions of the agent
  reviewing it.
- The diff/prompt/ack are labelled with the commit actually diffed
  (`git rev-parse HEAD`), not `PR_HEAD_SHA` — on a `pull_request` event
  `actions/checkout` checks out the merge ref, so those are never the same
  commit. `PR_HEAD_SHA` stays reserved for the Status API call.
- `postStatus()` honours a non-443 port and an `http:` scheme in
  `GITHUB_API_URL`, for GitHub Enterprise deployments, and warns when that
  scheme downgrades the token-bearing POST to cleartext.
- The ack line tolerates markdown emphasis, backticks and a three-dot range
  around its fields, and derives the token width from the token itself. A
  reviewer rendering `**diff-resolved:** …` previously failed a required
  check for a formatting reason, reported as "missing acknowledgement line";
  widening `randomBytes(8)` would silently have broken every ack.
- The `--stat` block is capped like the diff body, and its truncation counts
  toward the same partial-review flag.
- A truncated diff BODY fails the check: the reviewer never saw the tail of
  the change set, so its verdict does not describe the PR. A truncated
  `--stat` table does not — every changed file still appears in the body
  under its own `diff --git` header, so only a summary was lost. Blocking on
  that would have made a routine ~100-file rename or lint sweep unmergeable
  under D26 (the stat cap is 50x smaller, so it trips far sooner), with the
  useless advice to split the PR. Both are still named in the description.
- `git rev-parse HEAD` is checked like every other git call in the script.
  Unchecked, a spawn failure threw past every `postStatus()` call site and
  left the required context unwritten for that commit.

section: Added
- `scripts/tests/reviewer-clean-check.test.js`: 13 dependency-free unit tests
  pinning the acknowledgement gate (short/long/forged SHA prefixes, wrong and
  uppercased tokens, a quoted example that must not shadow the real ack line)
  and `parseSummary`'s last-match behaviour, plus a table over
  `matchesInstructionSurface` pinning what the gate does and does not fire on
  (`docs/CLAUDE.md` yes, `NOTCLAUDE.md` no, a `forge.json` test fixture no,
  a non-ASCII rules filename yes). 35 cases. Wired into the `validate` job.
- A fail-closed `diff-resolved: <base>..<head> token=<nonce>` acknowledgement
  gate: a per-run random token is written only into the diff file, never
  into the prompt, and the reviewer must echo it verbatim. A review that
  never opened the diff cannot produce it, so a hallucinated or
  reconstructed review fails the check instead of passing silently.
- `.gitignore` (the repo had none) for the transient
  `.reviewer-clean-diff.txt` scratch file, which survives a cancelled job on
  the persistent self-hosted runner and would otherwise trip the repo's own
  dirty-tree guards on later runs.
- `docs/decisions.md` D20: `reviewer clean` is recorded as advisory — its
  verdict is model-authored text derived from untrusted PR content, so it is
  a second opinion against a cooperative author, not an enforcing boundary
  against an adversarial one. `forge validators` (deterministic) fills that
  role.

section: Security
- The `reviewer clean` job is gated to same-repo pull requests
  (`head.repo.full_name == github.repository`). It lands on the persistent
  self-hosted runner and reuses the owner's `claude` login and `$HOME`, so a
  fork PR must not reach that machine; a fork PR also cannot post a status
  with a read-only token, so it could not go green in any case. Note for
  D26: an if:-skipped job posts nothing at an API-posted status context, so
  fork PRs will block pending a human once branch protection requires it —
  the intended outcome, since a fork PR is exactly what must not
  self-certify.
- That job's `actions/checkout` now sets `persist-credentials: false`.
  The default writes an `http.extraheader` carrying the base64-encoded
  `GITHUB_TOKEN` into `<workspace>/.git/config`, which sits inside the
  reviewer child's `--add-dir` root and is therefore readable by its
  `Read`/`Grep` tools — leaking past the environment scrub, which strips the
  token from the child's env but not from disk. The job never pushes.
- The check fails closed on a PR that modifies the reviewer child's own
  instruction surface, matched by pattern: `CLAUDE.md` (any directory, plus
  the `.local` variant), `.claude/settings.json` / `.claude/settings.local.json`,
  `.claude/forge.json`, `.claude/rules/`, and the configured
  `taskFiles.lessons` file. The first two are auto-loaded by the CLI; the
  rest the reviewer's own base-ref prompt directs it to read —
  `.claude/forge.json` notably supplies `agents.reviewer.extraChecks`, free
  text appended straight to the review checklist, and a `budget` of `1`
  neuters the review outright. Such a PR would be writing trusted-position
  instructions for the agent judging it, so it defers to a human instead.
  The lessons path is resolved from the base ref's config, so moving the key
  cannot sidestep the check. `plugins/forge/agents/reviewer.md` is
  deliberately excluded: already read from the base ref, so editing it cannot
  influence its own review.
- The instruction-surface gate reads the changed-file list with `-z` and
  `core.quotePath=false`. git quotes paths containing non-ASCII bytes by
  default, wrapping them in `"` — which defeats the `^`/`$` anchors in every
  pattern, so a PR adding `.claude/rules/<non-ascii>.md` would have sailed
  past a gate whose whole purpose is to fail closed. `--no-renames` so a rule
  file moved out of `.claude/rules/` is reported as both paths.
- `lessonsPathFromBase()` distinguishes an absent base config from a git
  fault, via a `git ls-tree` probe (`cat-file -e` exits 128 for a missing
  path, indistinguishable from a fault); a present-but-unparseable config is
  an error too. Both previously collapsed to "no lessons path", silently
  disabling half the gate whenever git hiccupped — the same fail-open class
  the rest of this unit exists to remove. A fault now fails the check.
- `.claude/hooks/` joins the pattern list. `--settings disableAllHooks` is
  what actually stops project hooks firing inside the child, but a PR can edit
  `.claude/hooks/session-start.sh` without touching `.claude/settings.json`,
  making that flag a single point of failure — and the failure is not
  symmetric with the Stop-hook case that motivated it: a Stop hook clobbering
  the report trips the ack gate loudly, while a `SessionStart` hook could
  inject "report zero findings" and leave the ack intact.
- `validate` and `forge-validators` fall back to a GitHub-hosted runner for
  fork PRs. Only `reviewer clean` had been gated, but a fork PR is arbitrary
  untrusted code that those two jobs check out and execute on the persistent
  self-hosted runner — the larger exposure, and the one the `reviewer clean`
  comment described while not actually enforcing. They fall back rather than
  skip, so the checks still run for fork PRs.
- `postStatus()` refuses to transmit the bearer token over plaintext `http:`
  unless `FORGE_ALLOW_INSECURE_API=1`. Previously it warned and sent anyway.
- `.claude/skills/`, `.claude/agents/` and `.claude/commands/` join the
  pattern list. `plugins/forge/skills/` is deliberately excluded: the plugin
  loads from the marketplace clone, not the PR worktree.
- The truncation message names the cap that actually tripped. `STAT_MAX_CHARS`
  is 50x smaller than `DIFF_MAX_CHARS` and the easier one to hit, and a PR
  touching thousands of files with a small body diff was being told to split
  because its diff exceeded 400000 chars.
- `AGENTS.md` joins `CLAUDE.md` in that list — recent CLI versions load it as
  an alternative memory file.
- Every git failure in the check now posts `failure`. `resolveBaseSha`
  returning null previously called `skip()`, which posts **success** — the
  one path where an unusable git tree produced a green required status. Which
  of the four sibling git calls noticed first decided the verdict.
- The top-level `main().catch` posts a `failure` status before exiting. An
  unposted status becomes a permanently pending PR once D26 makes this
  context required.
- A truncated diff now posts `failure` rather than `success` with a
  qualifying description: branch protection evaluates the state, not the
  text.
