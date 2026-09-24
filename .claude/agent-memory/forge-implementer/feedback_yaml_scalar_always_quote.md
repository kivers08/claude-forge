---
name: feedback-yaml-scalar-always-quote
description: When a hand-rolled YAML-scalar-quoting predicate keeps getting whack-a-mole fixes for new edge cases, always double-quote strings instead of trying to complete the ambiguity list
metadata:
  type: feedback
---

When a serializer decides ad hoc whether a string scalar needs quoting (based
on a growing "looks ambiguous to a real YAML reader" predicate — leading
`[`/`{`, trailing `:`, YAML-1.1 booleans, hex/octal numerics, `.inf`/`.nan`,
etc.), stop trying to complete that list. Always double-quote every string
scalar instead.

**Why:** on `scripts/lib/memory-migrate.js`'s `yamlScalar`, reviewers kept
finding another real-YAML-parser edge case the conditional-quoting predicate
didn't yet cover, across multiple fix rounds. A double-quoted scalar is
unambiguous to any conformant YAML reader and to the module's own inverse
parser (`parseScalar`'s existing double-quote branch), so there is no
predicate left to maintain or fall behind. Non-string types (number/boolean/
null) are unaffected — this only applies to string scalar emission.

**How to apply:** when asked to patch "yet another quoting edge case" in a
hand-rolled serializer (YAML or otherwise) that already has 2+ rounds of
reactive fixes, propose ending the pattern by unconditionally quoting/escaping
that value type, rather than adding one more condition. Verify the escape set
used by the writer is the EXACT inverse of what the reader's quoted-value
branch expects before making the change unconditional.
