---
name: security-hasunquotedsequence-bypass
description: (FIXED in D27, branch fix/d27-quote-bypass) hasUnquotedSequence could be defeated by quoting a single word of a real command. Fix lives in tokenize() via BARE_WORD. Kept for history + to recheck on future segment-split changes.
metadata:
  type: project
---

**STATUS 2026-09-24: FIXED.** Branch `fix/d27-quote-bypass` (commit 3516c19)
fixed this at the source: `tokenize()` now only sets `quoted:true` when a
token's value carries whitespace or a shell metachar (`BARE_WORD` regex);
a cosmetically-quoted bare word like `"pr"`, `'merge'`, `me""rge`, or an
escaped `\pr` reduces to the unquoted word. Because every consumer
(`hasUnquotedSequence`, `subcommandAfter`, merge-gate's `ghMergeIdentifier`
and `--squash` filter, pr-create/git-refspec/worktree-commit) reads the
`quoted` flag, the one-line source change closes all of them at once. The
fix only ever *removes* `quoted`, so it is strictly fail-closed (more likely
to deny); no false-negative regression. pre-bash.js dispatcher also now
tests the manifest `match` regex against the quote-stripped token stream so
the guard is actually dispatched. Verified: no residual bypass via quote/
escape/concat/tab/case. `$()`/backtick command substitution is out of scope
(documented) and unchanged. Original writeup below for history.

---


`plugins/forge/hooks/lib/segment-split.js`'s `hasUnquotedSequence(tokens, words)`
requires every matched word to be an UNQUOTED token. This correctly avoids a
false positive like `echo "gh pr merge"` (the whole thing is one argument to
`echo`, nothing is actually merged). But it does NOT distinguish that case
from quoting a single word of an otherwise-real command: bash executes
`gh "pr" merge 7 --squash` identically to `gh pr merge 7 --squash` (quoting
an individual word is semantically inert for a literal word — no globbing/
word-splitting to suppress), yet the tokenizer marks `pr` as `quoted: true`,
so `hasUnquotedSequence(tokens, ['gh','pr','merge'])` returns `false` and
`merge-gate.js`'s `check()` returns `null` — the ENTIRE guard (not just the
D19 T0 exception) is skipped, no marker required, no deny at all.

Verified empirically 2026-09-12 on branch `claude/u6-merge-gate-t0`:
```
node -e 'const seg=require("./plugins/forge/hooks/lib/segment-split");
console.log(seg.hasUnquotedSequence(seg.tokenize(`gh "pr" merge 7 --squash`),["gh","pr","merge"]))'
// -> false
```

**Why this matters:** this is pre-existing (predates the T0/auto-merge diff;
`lib/segment-split.js` was untouched by that diff) and likely affects every
other guard built on the same `hasUnquotedSequence` convention (pr-create
guard, etc — not just merge-gate), not only the new D19 code path. It was
flagged as a Security finding on the u6 review per that dispatch's explicit
instruction to surface any bypass regardless of likelihood, but it is a
repo-wide architectural gap, not something introduced by u6's diff.

**How to apply:** on any future review of a guard built on
`hasUnquotedSequence`/`subcommandAfter` (grep `lib/segment-split`), check
whether the fix landed (e.g. only treating a token as "not really executed"
when the ENTIRE segment is a single quoted string passed to another command,
not whenever any one word happens to be quoted). If unfixed, keep flagging.
See [[project_d19_t0_automerge_notes]] (the implementer's note from the same
unit) for related context on this branch's D19 work.
