---
name: security-hasunquotedsequence-bypass
description: hasUnquotedSequence (lib/segment-split.js) can be defeated by quoting a single word of a real command, letting it slip past every guard that uses it (merge-gate, pr-create, etc) — check this on every guard-touching diff.
metadata:
  type: project
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
