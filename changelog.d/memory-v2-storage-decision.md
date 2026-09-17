section: Docs
- Recorded the memory-v2 storage/recall decision (D28.1) in
  `docs/plans/memory-v2.md`: an embedded, git-synced design — committed
  markdown as the canonical store plus a `node:sqlite` FTS5 lexical index,
  with a semantic reranker deferred as a zero-migration bolt-on. Rejected
  networked vector/relational databases (qdrant/chroma/postgres) as breaking
  forge's install-anywhere posture and over-engineered for the scale. The
  `node:sqlite` index (and its >=22.5 Node floor) is CONDITIONAL per D28.4 — it
  ships only with the optional ranked-recall path; the thin-layer core keeps the
  >=20 floor. Research/decision only — no implementation in this change.
