# digest: short test and CI results

Prints a short digest instead of full test traces or CI logs, so Claude spends tokens on the failures, not the noise. Plain Node, no dependencies.

    node digest.js test [--runner jest|eslint|prettier|generic] -- <command ...>
    node digest.js parse --runner <name> [--exit N] [file]
    node digest.js ci <owner/repo> <run-id | branch>

`ci` needs the `gh` CLI signed in; if it is missing it says so and exits 2.

Exit code: 0 pass, 1 fail, 2 could not parse or error.

## Layout

    TESTS: FAIL | 3 passed, 2 failed, 1 skipped (4 suites, 0.9 s)
     1. src/a.test.js:3
        "math > rounds half-cent up" | Expected 12.35, received 12.34
     +N more            (only after 10 failures)
    SKIPPED (names): ...
    NOT RUN: <CI steps that did not run>

- Passing tests are counts only. Failures show file, line, test name and a one-line error (cap 10).
- Lint (ESLint) and format (Prettier) failures use the same layout. CI adds the run, branch, commit, job and failed step.
- If the output cannot be read with confidence the digest says `COULD NOT PARSE` and prints the last 20 lines. The exit code always wins over parsed counts: a non-zero exit with "0 failures" is never reported as a pass.
- Jest does not print skipped test names unless run with `--verbose`; the digest says so.
- Runners without an adapter use the generic fallback, labeled low-confidence, with no counts.

Adapters live in `adapters/`, one per runner. Add one only when a real app uses that runner. Tests: `node tests/digest.test.js` (fixtures are real Jest 30, ESLint 9, Prettier 3 output).
