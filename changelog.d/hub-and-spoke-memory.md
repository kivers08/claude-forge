section: Added
- hub-and-spoke memory (opusjevos D-BN, D-BO): spoke entries headed `### <ID> | <date> | <labels> | <one sentence>`, and `scripts/hub/hub.js` to `build` hubs (newest first), `check` them (stale hub, unknown or too many labels, duplicate IDs, broken pointers) and `find <label>` full entries
- `hubs` block in `forge.schema.json` (labels file, hubs and their spokes) and `taskFiles.handoff`
- session start injects open to-dos, the top of the handoff note (default `head-25`) and each hub's index; an index over budget is cut to its newest lines with a notice instead of being dropped
- session start asks for the conflict check when the handoff's `forge_version` differs from the running forge (opusjevos D-BM)
- `conflict-check` skill and read-only `scripts/conflict/github-rules.js`: compares the repository's GitHub merge settings and branch rules with the logged merge rules
- templates `formats.md` (Markdown + YAML header templates for plans, decisions/lessons, to-dos, handoff; opusjevos D-BS) and `labels.md` (the 12 standard labels)
- framework block: two-line status as the first reply; reading rules for hubs (helpers get only matching entries)
section: Changed
- `session-wrap-up` writes spoke entries, rebuilds and checks hubs, rewrites the handoff and records `forge_version`; `bootstrap` scaffolds labels, hubs and the handoff
- CI runs the hub and conflict-check unit tests
