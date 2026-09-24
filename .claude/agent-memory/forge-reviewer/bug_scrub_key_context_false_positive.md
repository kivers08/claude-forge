---
name: scrub-key-context-false-positive
description: memory-migrate finding #4 fix (scrub metadata value with reconstructed `key=` prefix) over-redacts benign values under secret-shaped keys
metadata:
  type: project
---

`scrubRecordFields.scrubMetadataValue` in
`plugins/forge/scripts/lib/memory-migrate.js` wraps a metadata value as
`${k}=${v}`, scrubs, then strips the `${k}=` prefix. This restores key context
so a bare generic secret gets caught — but it fabricates a TIGHT `=`
assignment, which makes `redact.js`'s `secret-assignment` `isTightAssignment`
signal true. That signal alone is sufficient to redact (it bypasses the
`looksLikeProseValue` guard, which only applies to whitespace separators).

Consequence: a legacy metadata field whose KEY name contains a secret keyword
(`access_key`, `api_key`, `password_hint`, `secret_note`, ...) and whose VALUE
is a benign lowercase string of >=6 chars (e.g. `access_key: [REDACTED:secret-assignment] has
its real value destroyed -> `[REDACTED:secret-assignment]`, where the pre-fix
bare-value scrub correctly preserved it. Only affects the migrateScopeDir
legacy-fold path (the additive consumer path writes no arbitrary legacy
metadata). Pristine original is archived so recoverable, but the reshaped
native record silently loses the value.

**Why:** noticed while reviewing feat/mv2-adoption-migration; test PART B #4
only covers a genuinely secret-shaped value (`abc123XYZ456`), not the benign
`frontdoor`-under-`access_key` false-positive.

**How to apply:** when reviewing any "reconstruct assignment context then
strip it back" scrub helper, test a BENIGN value under a credential-shaped key,
not just a real secret — the reconstruction can trip a tight-assignment
heuristic the bare value would never hit.
