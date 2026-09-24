---
name: memmigrate-multiline-quote-latent
description: memory-migrate.js yamlScalar quotes but does not escape embedded newlines; latent (source line-parser can't produce a newline scalar) but a landmine if any caller ever passes a multi-line frontmatter value.
metadata:
  type: decision
  scope: reviewer
---

In `scripts/lib/memory-migrate.js`, `yamlScalar` wraps a value containing `\n`
in double quotes but only escapes `\\` and `"` — NOT the newline itself. A
multi-line value therefore serializes as a real line break inside a quoted
scalar, which the line-based `parseRecord` cannot read back: name/description
truncate at the newline, subsequent lines become injected top-level keys, and
`isNativeRecord` returns false (so the record would be re-migrated on the next
run — non-idempotent).

**Why it's only a Suggestion today, not a Bug:** the migration source is
parsed by the same line-based `parseRecord`, which can never yield a scalar
containing a newline. So no reachable input reaches `yamlScalar` with a
newline. It becomes a real defect the moment any caller passes a multi-line
value (e.g. importing from a real YAML parser, or a body accidentally routed
through a scalar field).

**How to apply:** when reviewing any future change that feeds
memory-migrate's serializer from a richer parser, flag the missing newline
escape. Fix is to `.replace(/\n/g,'\\n')` in the quoted branch AND teach the
parser to unescape — or reject multi-line scalars outright.

Related: [[security_hasUnquotedSequence_bypass]] (same repo, quoting-vs-parsing
asymmetry class). This is the class the dispatch said "bit the redaction hook
hard."
