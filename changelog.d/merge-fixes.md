section: Added
- auto-merge on a child PR is allowed at once when the parent branch's GitHub rules require a PR and status checks (GitHub holds the merge until they pass; opusjevos D-BH); otherwise checks must already pass
- a merge into the base branch through the GitHub tool must carry the PR's current title and description as the squash message (`merge.requireSquashMessage`, default on; opusjevos D-BC); an unreadable PR denies, and a refused message does not use up the human's marker
- `reviewer clean` skips child PRs when the parent PR says `Planned children: N` with N of 3 or fewer (opusjevos D-AW, D-AX); an unknown count still reviews
- `hooks/lib/github-read.js`: read-only GitHub lookups via `gh api`, falling back to unauthenticated HTTPS for public repositories when gh is not logged in (cloud sessions)
section: Fixed
- the merge guards resolve a PR's destination branch over the API when `gh` is missing or logged out, instead of treating every PR as a merge into the base branch
