---
name: security-writeRecord-extra-unscrubbed
description: memory-v2 writeRecord scrubs body + frontmatter but NOT opts.extra — secrets in extra fields (e.g. description) reach disk; check any change to the write/scrub path.
metadata:
  type: project
---

In `plugins/forge/hooks/lib/memory.js`, `writeRecord()` scrubs `opts.body` and
every string-valued `opts.frontmatter` field through `scrubSecrets`, but passes
`opts.extra` straight to `serializeRecord` unscrubbed.

**Why:** the plan (memory-v2.md §3.4 "Every write runs the redaction scrubber
first"; §4) requires *every* write path to scrub. `extra` is a real write path —
migration and any caller preserving non-schema keys (name/description/metadata)
flow through it. Verified empirically 2026-09-16: a secret in `extra.description`
reached disk unredacted.

**How to apply:** on any review touching memory.js's write/scrub path, confirm
`extra` string values are run through `scrubSecrets` alongside `frontmatter`.
Fix is to loop `opts.extra` the same way frontmatter is looped (lines ~412-418).
Related: [[security_hasUnquotedSequence_bypass]] (other repo-wide scrub/guard gaps).
