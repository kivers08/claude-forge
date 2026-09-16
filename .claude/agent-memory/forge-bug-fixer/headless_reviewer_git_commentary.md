---
name: headless-reviewer-git-commentary
description: A headless `claude -p` reviewer child can end its response with git-hygiene commentary instead of its report, silently discarding the real findings from --output-format json's `result` field — observed twice in claude-forge's reviewer-clean-check.js end-to-end testing.
metadata:
  type: project
---

While fixing `scripts/reviewer-clean-check.js` (claude-forge, unit U9,
2026-09-13) I ran the real end-to-end script twice against a real diff
(origin/main...HEAD, ~73-81KB). Both times, the reviewer child (given
Read/Glob/Grep only, no Bash, per the fix) did extensive real exploration
(confirmed via a raw `--output-format stream-json` capture: it read the
precomputed diff file, globbed changelog/schema/CI/hook files, read
`plugins/forge/agents/implementer.md`, `docs/decisions.md`, etc. — clearly
engaging with real content, not hallucinating). But in both runs, the
final captured `result` text was **not** the structured review report —
it was a short aside about the working tree's git state (an unpushed
commit, an untracked scratch file), explicitly asserting "my review report
stands as delivered above" — a report that does not appear anywhere in
the captured JSON output.

**RESOLVED 2026-09-13** (a follow-up dispatch, on the same branch, confirmed
the hypothesis below before being stopped for taking too long on repeated
live-CLI verification; the coordinator applied and verified the actual fix
directly): the leading hypothesis was correct. This repo's own `forge`
plugin ships a Stop hook (`plugins/forge/hooks/stop-git-check.js`) that was
firing inside the `--restricted` reviewer child too — `--restricted`'s help
text says "managed settings and --settings still apply", and project-level
plugin hooks are not stripped by it. The fix: add
`'--settings', '{"disableAllHooks":true}'` to the `claude` invocation's
`args` in `scripts/reviewer-clean-check.js`. Verified across 3 separate real
end-to-end runs post-fix: the reviewer's actual structured report now
reaches `result`, `verifyDiffResolvedAck` passes, and the report references
real files/lines from the diff (not reconstructed/hallucinated). This
child never has anything to commit/push anyway (`--restricted` +
`Read,Glob,Grep` only), so disabling all hooks for it has no downside.

**Why this matters**: any script that parses only the final `result`
field from `claude -p --output-format json` to extract a structured
report is vulnerable to this — the report can be real and correct
earlier in the transcript and still never reach the caller.
`reviewer-clean-check.js`'s new `diff-resolved: <base>..<head>`
acknowledgement gate (added in the same fix) caught this correctly by
failing closed both times, which is exactly the defense-in-depth behavior
it was built for — but it means the check may currently fail on
*every* real PR until this trailing-commentary behavior is separately
diagnosed and addressed.

**How to apply**: if you're asked to make reviewer-clean-check.js (or any
similar headless-reviewer script) actually pass on a clean PR, don't
assume the flag fix alone is sufficient — verify with a real end-to-end
run first, and if you see this pattern, consider capturing
`--output-format stream-json` and extracting the *last substantive report
match* across all assistant text blocks (not just the final `result`
field) as a more robust remediation. Flag this as a follow-up unit rather
than folding it into an in-progress bug fix.
