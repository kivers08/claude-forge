section: Added
- D21 changelog close-out: `scripts/changelog-closeout.js` assembles
  `changelog.d/` fragments into a dated header at the top of `CHANGELOG.md`,
  grouped by section, and deletes the assembled fragments. On-demand only
  (not CI-wired; full pipeline automation is D22, still deferred). Refuses to
  run with no changes when there are zero fragments or a fragment fails
  shape validation.
