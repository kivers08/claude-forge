---
id: formats
date: 2026-10-06
status: current
labels: [docs]
---
# Formats for memory, plan and task files

Source: opusjevos D-BS (file format), D-BN/D-BO (hub and spokes, labels).
Every stored doc below is **Markdown with a short YAML header**. No XML and no
whole-file YAML/JSON for stored docs. XML-style tags appear only inside
instructions written for helper agents.

## 1. YAML header (every file)

```
---
id: <short-name>            # stable; matches the file name
date: YYYY-MM-DD            # last meaningful change
status: draft | approved | current | done | generated
labels: [<label>, ...]      # from labels.md only
---
```

The handoff note adds one more key: `forge_version: <x.y.z>` (the forge that
last wrapped up a session here). Session start compares it with the running
forge; a difference triggers the conflict check.

## 2. Hub and spokes

- A **spoke** file holds entries. Each entry starts with one heading line:
  `### <ID> | <YYYY-MM-DD> | <1-3 labels> | <one sentence>`
  followed by as much detail as needed. IDs never change (`D-BO`, `L-042`).
- A **hub** is generated from its spokes by the forge hub script
  (`scripts/hub/hub.js build`); never edit it by hand. One line per entry,
  newest first: `- <date> | <labels> | <one sentence> | <spoke-file>#<ID>`.
- Labels come only from the repo's `labels.md` (template: `labels.md` in
  this folder). The hub script refuses unknown labels.
- Session start loads the hub (newest lines first, within the byte budget).
  To get detail, grep the ID or run `hub.js find <label>`; pass helper agents
  only the matching entries, never the whole hub or spoke file.

## 3. Templates by document type

### Plan

```
---
id: plan-<name>
date: YYYY-MM-DD
status: draft
labels: [...]
---
# Plan: <name>
## 1. Goal in plain English
## 2. What exists today (VERIFIED)
## 3. Design
## 4. Build (parent branch, planned children)
## 5. Checks before building
## 6. Owner's part
## 7. Open questions
```

### Decisions or lessons (spoke file)

```
---
id: decisions
date: YYYY-MM-DD
status: current
labels: []
---
# Decisions
## Log
### D-XX | YYYY-MM-DD | merge, ci | One sentence a reader can act on.
Detail: what was decided, who decided, why, what it replaces.
```

Lessons use the same shape with `L-NNN` IDs and a trigger in the sentence
("When X, do Y").

### To-dos

```
---
id: todo
date: YYYY-MM-DD
status: current
labels: []
---
# To-dos
## Open
- [ ] <action> (<label>) — <pointer, e.g. decisions.md#D-BO>
## Done
- [x] <action> (YYYY-MM-DD)
```

Session start injects only the unchecked `- [ ]` lines.

### Handoff note

```
---
id: handoff
date: YYYY-MM-DD
status: current
labels: [...]
forge_version: x.y.z
---
# Handoff
## Where things stand
<two or three lines>
## Next
1. <next step, with pointer>
## Watch out
- <blocker, unverified fact, or standing rule>
## Pointers
- <file or ID>: <why it matters>
```

Keep the first 25 lines self-sufficient: that is what session start injects.
