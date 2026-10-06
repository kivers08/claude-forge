section: Security
- close routes onto the base branch that skipped the merge gate: `git push` to it, the GitHub tools `push_files`, `create_or_update_file`, `delete_file`, `enable_pr_auto_merge` and `update_pull_request` (re-pointing at it), and raw `gh api`/`curl` calls to the merge or refs endpoints
- the merge marker can no longer be created, edited or removed by the agent (Bash and file-tool guards)
- multi-repo sessions: the marker is looked up in the child repository whose origin matches the pull request instead of denying every merge
- `pre-merge-mcp.js` now fails closed on an unexpected crash, as its header always claimed
- review fixes: raw-API PR merges resolve the PR and follow the child-test and squash rules; `git -C <dir>` push/merge is judged in that directory; a marker is only used for the repository the request names; a spoken "merge" authorises only a numbered PR merge in a session tied to exactly that one repository, never a direct write; markers are claimed atomically (a failed claim denies); auto-merge on a child PR requires passing checks; the file-tool marker guard ignores letter case
