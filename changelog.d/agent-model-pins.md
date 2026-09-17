section: Added
- Each forge worker agent now pins its model in its definition: `reviewer` on
  Opus (critical correctness/security judgment), `implementer`/`bug-fixer`/
  `test-writer` on Sonnet (capable coding at lower cost), `doc-updater`/
  `explorer` on Haiku (light, mechanical/read-only). Previously agents carried
  no model and inherited the coordinator's, so everything ran on the
  coordinator's model. A project's `.claude/forge.json` can still override per
  D18 precedence.
