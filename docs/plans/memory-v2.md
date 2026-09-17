# memory-v2: a native, Node-based memory subsystem for forge

A design proposal. It absorbs the ideas worth taking from PMB
(`github.com/oleksiijko/pmb`, docs `docs.pmbai.dev`) and builds them natively,
rejecting the parts that conflict with forge's decisions and threat model.

**Nothing here is built.** This is the `brainstorm` output (D-style proposal)
the owner accepts, edits, or rejects before any unit is dispatched
(`plugins/forge/skills/brainstorm/SKILL.md`: "not a place to build anything").

---

## D28 — proposal (drop-in for `docs/decisions.md`)

> ### D28 — Memory v2: native typed memory, hybrid recall, earned-lesson measurement
>
> **Decided:** evolve the D4/D6/D15 memory system in place, natively in Node,
> rather than adopting PMB or any MCP memory server. Keep committed, git-visible,
> **per-agent-scoped** markdown as the canonical store; add an optional, rebuildable
> local index for hybrid recall; measure lesson usefulness before it influences
> ranking.
>
> **Options considered:**
> 1. *Adopt PMB wholesale* — rejected (see "Rejected from PMB" below): no
>    per-agent scope, auto-recall as invisible policy, a write-capable MCP in the
>    review path, binary user-level storage that fails D13, and a Python + 450 MB
>    embedder prerequisite that fails D11/D1.
> 2. *Hybrid — PMB for the coordinator only* — viable as a time-boxed experiment
>    but still drags in the Python runtime and the invisible-policy hook; not the
>    default.
> 3. *Native (this proposal)* — take PMB's good ideas as Node components under
>    forge's own contracts.
>
> **Why native:** every forge memory decision (D4 per-agent, D6 git-visible
> index, D11 Node-only, D13 cloud-first, D20 instruction-surface gating) is a
> constraint PMB violates. Re-implementing the *ideas* keeps them.
>
> **Superseded:** none removed. D4/D6/D15 are extended, and the migration
> (§6 of the plan) preserves the existing `.claude/agent-memory/**` files.

---

## D28.1 — Storage & recall engine (SETTLED 2026-09-16, brainstorm)

Owner-confirmed decision closing the storage/recall questions left open in
§3.1 and §9. Recorded via `forge:brainstorm` (research only; nothing built).

**Decision: embedded, git-synced, lexical-first.**
- **Canonical store:** committed markdown under `.claude/agent-memory/**` — the
  source of truth. It syncs across the owner's two servers (dev and nebula) for
  free via `git pull`, and stays diff-visible/gated per §4.
- **Local index:** `node:sqlite` (its built-in FTS5 gives BM25 directly — less
  code than a hand-rolled JS index). Rebuildable and never authoritative
  (`forge memory reindex`), so `node:sqlite`'s "experimental" status is low-risk.
- **Recall:** lexical **BM25 core** now. A dense/semantic reranker (RRF-fused)
  is **deferred** — a zero-migration bolt-on later, since adding vectors leaves
  the canonical markdown store unchanged.

**Consequence — D11 amendment:** the Node floor rises from ≥20 to **≥22.5**
(`node:sqlite` availability). Both target boxes run 22.23. D11 must be updated
to reflect this when the epic lands.

**Scope confirmed:** memory-v2 is forge's per-agent **AI-coding memory**
(lessons agents learn while working), **not** a client/business-data store.

**Options considered & rejected:**
- *Networked vector/relational DB (qdrant, chroma, postgres+pgvector).*
  Rejected. It breaks forge's install-anywhere / D13 posture; across two servers
  it needs either one shared instance (latency + single point of failure +
  security surface) or a custom cross-box sync that the git-committed store
  gives for free; and at forge's scale (agent lessons — the owner's entire
  business is ~3k client records after 10 years, and memory is smaller than
  that) ANN indexing yields no measurable benefit over embedded FTS/brute-force.
- *Stdlib JSON index instead of `node:sqlite`.* Viable and zero-dependency, but
  more of our own code (hand-rolled BM25) with no offsetting benefit; FTS5 is
  simpler. Retained as the mental fallback if the 22.5 floor ever becomes a
  problem.

**Still deferred (unchanged from §9):** which embedder for the optional dense
reranker (unit 7); whether ambient write is on by default for non-reviewer
agents; the exact record `type` set beyond fact/lesson/decision/note; and the
unverified CLI-behavior questions in §6.

---

## 1. Take from PMB (build native equivalents)

| PMB idea | Native form in forge | Justification |
|---|---|---|
| Typed records with importance, timestamps, access counts, tiered fade | A small record schema (§2), tiers = Working/Episodic/Semantic as a `tier` field; recall bumps `lastUsed` | Structure beats free-form markdown for ranking & decay |
| Hybrid recall (BM25 + dense + graph, RRF-fused) | **Lexical BM25 core (stdlib), optional dense reranker** (§3) | Recall quality without a hard dependency |
| Four-layer dedup | exact → cosine (if embedder present) → flagged → manual; old values archived | Stops the store filling with near-duplicates |
| Session restore + follow-through | A `session_brief` recall + a SubagentStop check that marks which surfaced lessons appeared in the work | The hard part is *use*, not storage |
| Earned Memory (Wilson-interval usefulness, measurement-only until dense) | Fold into D10 telemetry (§5) | Same discipline forge already applies to zero-use mechanisms |
| Secret redaction before storage | A stdlib pattern scrubber on the write path (§4) | Cheap, honest safety net |
| Local-first, files-on-disk, exportable | Canonical store *is* committed markdown; index is a rebuildable sidecar | Already forge's model |

## 2. Reject from PMB (design against — each a documented reason)

1. **No per-agent memory.** PMB has one workspace. forge memory is role-scoped
   and that is load-bearing (a reviewer lesson must not surface to the
   implementer). **memory-v2 keeps per-agent scopes first-class**, plus an
   explicit shared coordinator scope.
2. **Auto-recall as invisible policy.** PMB's `UserPromptSubmit` hook injects up
   to 4000 chars before the model thinks and states "the agent never decides to
   call recall" — then its own docs say "treat recalled lessons as evidence with
   provenance, not invisible policy." Those contradict. **memory-v2 recall is
   visible and attributable** (§3): what was injected, from which record, is
   emitted so a human sees it and the reviewer can diff it. Injection is opt-in
   per agent.
3. **Write-capable MCP in the review path.** `reviewer clean` runs the reviewer
   with zero MCP servers, `Read,Glob,Grep` only, a base-ref system prompt, and a
   fail-closed instruction-surface gate. **memory-v2 never gives the reviewer
   child a write path to memory, and memory is never an unreviewable instruction
   surface** (§4).
4. **Binary, user-level storage.** PMB lives in `~/.pmb/` (SQLite + LanceDB),
   synced via a separate git remote — invisible in cloud sessions (D13).
   **memory-v2's canonical store is committed markdown in the repo**; the index
   is a rebuildable local sidecar that is never the source of truth.
5. **Python + 450 MB embedder prerequisite.** Fails D11 (Node-only, zero-dep
   hooks) and D1 (installs cleanly anywhere). **memory-v2 is fully functional
   with a stdlib lexical core**; any embedder is optional and separately
   installed.
6. **Appending to `CLAUDE.md`.** Would fight D5's marker-delimited block.
   **memory-v2 writes only under `.claude/agent-memory/**`**, never into
   `CLAUDE.md`.

---

## 3. Architecture

### 3.1 Storage split

- **Canonical (committed, reviewable):** `.claude/agent-memory/<plugin>-<agent>/`
  markdown records, one file per record, with YAML-ish frontmatter (§below). A
  shared `.claude/agent-memory/forge-coordinator/` scope. This is the source of
  truth — diff-visible, gated, revocable by `git revert`.
- **Local index (rebuildable, git-ignored):** a single
  `${CLAUDE_PLUGIN_DATA}/memory-index/` sidecar built on **`node:sqlite`**
  (SETTLED — see D28.1; its FTS5 gives BM25 directly). This raises forge's Node
  floor to **≥22.5**, an accepted D11 amendment; both target boxes run 22.23.
  Stdlib JSON is the retained fallback. The index is never authoritative;
  `forge memory reindex` rebuilds it from the markdown.

### 3.2 Record schema (to settle in review — field names not yet verified)

```
--- (frontmatter) ---
id:        <ulid-like, generated without Date.now/Math.random in hooks — see note>
type:      fact | lesson | decision | note        # subset of PMB's ten; justify additions
scope:     reviewer | implementer | bug-fixer | test-writer | doc-updater | explorer | coordinator
tier:      working | episodic | semantic          # fade speed; recall promotes toward semantic
importance: 0.0–1.0
created:   <ISO8601, stamped by the writing process, not inside a hook>
lastUsed:  <ISO8601 | null>
uses:      <int>
source:    authored | learning-block | ambient    # provenance — see §4
supersedes: <id | null>                            # keyed-fact-style upsert; old kept, archived
--- (body) ---
<the record; for a lesson, follow with the D6 anchor convention>
```

`type` starts as a **small** set (fact/lesson/decision/note); PMB's goal,
milestone, qa, git/file/code, image types are deferred until a concrete need —
adding a type is cheap, removing one is not.

### 3.3 Recall pipeline (lexical core, optional rerank)

1. **Candidate set** = records in the requesting agent's scope + the coordinator
   scope. Never cross-scope.
2. **BM25** (pure JS, stdlib) over the index → top-K by `recall.top_k`.
3. **Optional dense rerank** if an embedder is installed; otherwise skip.
4. **RRF fuse** lexical + (optional) dense; recency half-life and an importance
   boost as tunables.
5. **Visible injection:** the SessionStart injector (extending
   `session-start.js`) emits the selected records *with their ids and scope*,
   inside `taskFiles.injectionBudget`, so what was injected is in plain sight and
   diffable — not silent standing policy. **Opt-in per agent** via
   `agents.<agent>.memory.autoRecall` (default off for the reviewer, always).

### 3.4 Write path

- **Explicit:** a `forge memory record` path the coordinator/agents call.
- **Ambient (opt-in):** a SubagentStop synthesizer that writes a `source: ambient`
  record when a unit clears an outcome bar — **never for the reviewer**, and
  never from the review CI path.
- Every write runs the redaction scrubber (§4) first.

---

## 4. Security

The threat is **forge's own agent going off-rails** (prompt injection in content
it reads, a poisoned lesson), not outsiders. Requirements:

- **Memory is an instruction surface.** Every path by which a memory record
  reaches a model prompt is either (a) diff-visible in git — which the committed
  markdown store guarantees — or (b) gated. Since it *is* committed, a poisoned
  record shows up in a PR diff and is caught by normal review + the D27 fix.
- **The reviewer's memory is read from the base ref**, exactly like its system
  prompt (`readReviewerSystemPromptFromBase`). This closes the known
  reviewer-agent-memory gap: a PR can no longer plant a lesson that steers the
  review of that same PR. **Add `^\.claude/agent-memory/` handling** — for the
  reviewer scope specifically, read base-ref; and add the path to
  `SELF_REVIEW_FORBIDDEN_PATTERNS` reasoning so an edit to *another* agent's
  memory in a PR is at least surfaced.
- **Nothing in the review path writes memory.** The reviewer may read its own
  base-ref scope; writes happen only in the coordinator session after the human
  has seen the report.
- **Poisoning is attributable, reviewable, revocable, non-auto-applied:**
  `source:` records provenance; the record is a committed file (diff-visible);
  `git revert` removes it; and auto-recall is opt-in and off for the reviewer,
  so a lesson is never silently promoted to standing policy.
- **Redaction:** a stdlib pattern scrubber (API-key/token/PEM/`*_SECRET=` forms)
  replaces matches with `[REDACTED:<kind>]` before write, with the honest caveat
  (documented in the record header) that a bare high-entropy string can slip
  through — a safety net, not a guarantee.
- **`node:sqlite` note:** the index is untrusted-derived only from committed
  records, but it must still be built with parameterized queries; and because it
  is git-ignored and rebuildable, a corrupt index is a `reindex`, never a trust
  problem.

---

## 5. Measurement before influence (fold into D10)

Record, from day one, which surfaced lessons appeared in the resulting work
(the follow-through check) and the turn's outcome. Compute per-lesson usefulness
with a **95% Wilson interval**; label `useful`/`harmful` only when the interval
clears baseline and the sample is large enough, else `unverified`/`insufficient`.
**These signals are measurement-only** — they do not feed recall ranking or
decay until density passes a stated threshold. This is the same posture D10 takes
toward zero-use mechanisms; implement it as an extension of
`telemetry.jsonl` + `/forge:audit-framework`, not a parallel system.

---

## 6. Integration map

| Existing file | Change |
|---|---|
| `plugins/forge/hooks/session-start.js` | add opt-in memory recall to the injector, within `injectionBudget`, emitting record ids |
| `plugins/forge/hooks/subagent-telemetry.js` | add the follow-through check + optional ambient write |
| `plugins/forge/hooks/lib/` | new `memory.js` (record read/write), `bm25.js`, `rrf.js` — all stdlib |
| `plugins/forge/schema/forge.schema.json` | add `agents.<agent>.memory.{autoRecall,scope}`, `recall.*` knobs |
| `scripts/reviewer-clean-check.js` | reviewer memory read from base ref; note in the instruction-surface reasoning |
| `plugins/forge/agents/*.md` | document each agent's memory scope |
| `docs/decisions.md` | D28; update D4/D6/D15 cross-refs |

Coexistence: the new SessionStart/SubagentStop work extends the existing hooks
rather than adding new registrations, so it composes with `stop-git-check.js`
and the telemetry hooks without new ordering questions.

**Unverified — check before building:** whether `UserPromptSubmit`/SessionStart
hooks fire inside subagents and in `-p` (headless) mode; what `memory: project`
actually writes vs. this scheme; and the exact `gh`/CLI record-injection point.
Cite the docs or test on a scratch project — do not guess.

---

## 7. Unit breakdown (each = one PR off `claude/units`, forge convention)

1. **Record schema + `lib/memory.js`** (T1) — read/write committed records,
   redaction scrubber, migration of existing `.claude/agent-memory/**`. Tests.
2. **Lexical index + `lib/bm25.js` + `reindex`** (T1) — stdlib only, git-ignored
   sidecar. Tests. *(lands the stdlib core first)*
3. **Visible recall in SessionStart** (T1) — opt-in, budgeted, ids emitted.
4. **Reviewer memory from base ref** (T1, security) — closes the known gap;
   touches `reviewer-clean-check.js`.
5. **Follow-through + ambient write** (T1) — SubagentStop; reviewer excluded.
6. **Earned-memory measurement** (T2) — Wilson intervals, measurement-only.
7. **Optional dense reranker** (T2) — separately-installed embedder, RRF fuse;
   stdlib fallback stays the default. *(lands last)*

Order lands the stdlib lexical core before anything optional; the security unit
(4) is independent and can go early.

---

## 8. Migration from D4/D6/D15

- Existing `.claude/agent-memory/<plugin>-<agent>/*.md` files are **kept**; unit 1
  adds frontmatter to them (a mechanical pass, reviewable as a diff).
- D6 Index Contract stays for the human-readable lessons/todo files; the new
  index is a *machine* sidecar, not a replacement for the `## Index` section.
- D15 `### LEARNING` blocks stay the agent→coordinator report convention; unit 5
  optionally turns a LEARNING block into a `source: learning-block` record at
  SubagentStop. SubagentStop auto-filing stays **experiment-gated** (D15) until
  measurement (unit 6) shows it earns its place.

---

## 9. Not resolved (explicit)

- ~~The `node:sqlite` floor-raise (Node 22.5) vs. staying stdlib-JSON~~ —
  **RESOLVED (D28.1, 2026-09-16): `node:sqlite` chosen; Node floor raised to
  ≥22.5.**
- Which embedder (if any) for unit 7 — name, size, license to be settled then.
- Whether ambient write is on by default for non-reviewer agents or opt-in.
- The exact record `type` set beyond fact/lesson/decision/note.
- The unverified CLI-behavior questions in §6.
