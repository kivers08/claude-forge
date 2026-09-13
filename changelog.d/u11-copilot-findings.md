section: Security
- `changelog.fragmentsDir` and `changelog.file` are contained to the
  repository. Both scripts joined the raw config value onto the repo root, so
  a PR adding `.claude/forge.json` with `"fragmentsDir": "../../.."` pointed
  `validate-changelog.js` (run by CI on every PR) at files outside the
  checkout — read, and echoed in its error output — and pointed
  `changelog-closeout.js` at files outside the repo to enumerate, overwrite
  and **delete**. `resolveInside()` now `path.resolve`s the value and refuses
  anything that is not the root or under it, absolute values included.
- A symlinked fragment is a hard error. `listFragmentFiles` enumerated every
  `*.md` name and `readFileSync` followed the link, so
  `ln -s ~/.claude/.credentials.json changelog.d/leak.md` in a PR would have
  had its target read by the validator, surfaced in its error output, and
  copied into `CHANGELOG.md` on close-out. Entries are now enumerated with
  Dirent types and must be regular files (lstat-based, so a symlink fails);
  `parseFragment` re-checks with `lstat` for direct callers.
- Containment is physical, not just lexical. Git checks out committed symlinks
  verbatim, so a PR adding `docs/out -> /home/runner/.claude` and setting
  `fragmentsDir: "docs/out"` passed the prefix check (lexically inside) and
  close-out would then rename and delete files in the link target.
  `resolveInside` now also resolves the deepest existing ancestor with
  `realpath` and re-checks it against the real root; the fragments directory
  itself and `changelog.file` are refused if they are symlinks.

section: Fixed
- The interrupted-run check runs before the "nothing to assemble" exit. The
  interruption it exists for leaves zero live fragments and all of them in
  staging, so a check placed after that exit never ran in the one case it
  was for — the next run reported an empty `changelog.d/` while the
  fragments sat in `.closeout-staging/`. The two tests for it had been
  planting an extra live fragment, which hid this; they no longer do.
- The failed-publish cleanup removes the temp file only if this run created
  it, tracked by a flag rather than inferred from the error code — a staging
  rename failing before the temp was opened is not `EEXIST`, and would have
  unlinked a stale file or committed symlink at that path.
- The publish temp file is created exclusively (`O_EXCL`) at a fixed path.
  A PR can commit a symlink at `CHANGELOG.md.tmp` pointing outside the
  checkout; a plain write would have overwritten the link's target with the
  assembled changelog and the rename then moved the link itself onto
  `CHANGELOG.md`. An existing path is now refused and left for the operator.
- A rollback that cannot move every fragment back no longer deletes the
  staging directory — which would have destroyed the unrestored fragment
  with no copy anywhere while reporting "fragments restored". It now names
  the files still in staging and leaves them.
- Close-out reports a symlinked or irregular fragment, a symlinked or
  non-regular changelog target (a directory left by a bad merge previously
  died on `EISDIR`), or a stray file where its staging directory should be as an
  `error:` line with exit 1 — not an uncaught stack trace. A failed publish
  removes its temp file (previously leaked as `CHANGELOG.md.tmp-<pid>` on
  every EXDEV/EACCES failure) and restores the fragments. If the changelog
  write succeeds but staging cannot be removed, a `PUBLISHED` marker is left
  so the next run reports the known answer instead of asking the operator to
  check by hand.
- Fragment listing uses `lstat` rather than Dirent type flags: on filesystems
  that report `DT_UNKNOWN` (XFS with `ftype=0`, some overlay mounts) the flags
  are all false and every valid fragment would have been rejected.
- `changelog-closeout.js` is crash-safe. It wrote `CHANGELOG.md` and only
  then unlinked the fragments, so a process death or one failed unlink after
  the write left fragments whose bullets were already published, and the
  next run re-assembled them as duplicates with nothing to say so. Fragments
  are now moved into `changelog.d/.closeout-staging/` first (same-directory
  renames), the changelog is written via temp file + rename, and staging is
  removed last. An interrupted run leaves either untouched fragments or a
  staging directory the next run refuses to start over, never a silent
  duplicate.
- Both scripts honour a `FORGE_REPO_ROOT` override so tests can point them at
  a fixture repo.
- The two remaining unguarded `fs` calls in close-out (reading and creating
  the staging directory) report EACCES/ENOSPC as an `error:` line like every
  other refusal. `.gitignore` covers the close-out artifacts. D21's "Built:"
  record in `docs/decisions.md` describes the hardened behaviour.

section: Added
- `scripts/tests/changelog.test.js`: 24 dependency-free cases covering
  containment (traversal, absolute, non-string, and the prefix-collision
  sibling case), symlink and directory rejection with the target never
  echoed, the close-out happy path, the leftover-staging refusal, and
  no-duplicate-on-rerun. Wired into the `validate` job.
