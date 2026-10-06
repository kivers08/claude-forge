section: Added
- merge control for the base branch (D32): a shared decision module (`hooks/lib/merge-control.js`) that every route onto the base branch now uses; markers are single-use and last 15 minutes
- one-tap approval: when no marker exists the merge guards return an `ask` in permission modes where an approval reaches the human (`default`, `acceptEdits`, `plan`) and a deny otherwise (`auto` only with `merge.askInAutoMode`)
- spoken-word merge (`UserPromptSubmit` hook, `merge.spokenWord`, off by default): a message that is only "merge", "merge to main" or "merge PR 12" writes a single-use marker; a bare "merge" applies only to the single open pull request into the base branch
- child-to-parent merges through the GitHub tool require all checks to pass (`merge.requireChildTests`, default on); failing or running checks deny, missing or unreadable checks ask or deny and never pass
- new `merge` config block in `forge.schema.json`
