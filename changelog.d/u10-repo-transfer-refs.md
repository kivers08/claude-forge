section: Changed
- Every functional reference to `kewi-development/claude-forge` now names
  `kivers08/claude-forge`, for the repository transfer to the personal
  account. Branch protection is unavailable on a private repo under a free
  org plan (D20's blocker), and the personal account carries GitHub Pro, so
  moving the repo is what makes D20's required status checks — and therefore
  D19's currently dormant T0 fast path — possible at all.
- Updated: `.claude/settings.json`'s `extraKnownMarketplaces` source (how this
  repo loads its own plugin), `.claude/hooks/session-start.sh`'s
  `marketplace add`, the README install commands, `forge.schema.json`'s `$id`,
  the marketplace and both plugin manifests' author name, and the install
  commands quoted in `docs/`.
- Deliberately NOT updated:
  `plugins/forge/hooks/tests/payloads/pre-merge-mcp.json` — fixture data for
  the MCP merge-path test, which asserts nothing about the real repository,
  and `docs/decisions.md`'s record of the `GET /repos/kewi-development/...`
  call that established the D20 blocker, since rewriting the URL would
  falsify the evidence for a verification actually performed against the org
  path. That record is resolved when protection is applied, not now.
