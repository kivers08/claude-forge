#!/usr/bin/env node
'use strict';
// PreToolUse on mcp__github__merge_pull_request: the merge gate again.
//
// The Bash guard only sees `gh pr merge`. A merge through the GitHub MCP server
// never touches Bash, so without this the gate has a hole wide enough to merge
// through.
//
// Two rules, by destination (resolved from the PR itself, `gh pr view`):
//   * INTO THE BASE BRANCH (`git.baseBranch`, or destination unknown): needs a
//     human decision (lib/merge-control.js): marker, spoken marker, or ask.
//   * INTO ANY OTHER BRANCH (a child unit merging into its parent): needs no
//     human word, but the child's tests must have passed (D-AQ, unless
//     `merge.requireChildTests` is false). Failing or still-running checks deny.
//     No checks / unreadable checks is NEVER a pass: ask where an ask reaches
//     the human, deny otherwise.
//
// This hook fails CLOSED, unlike every other hook here. An unreadable payload
// means the marker cannot be checked, and "we could not verify the human said
// merge" must not resolve to "merge it". That includes an unexpected crash:
// the catch below denies.
const io = require('./lib/io');
const cfg = require('./lib/config');
const mc = require('./lib/merge-control');
const guard = require('./guards/merge-gate');
const githubRead = require('./lib/github-read');

function slugOf(input) {
  return input.owner && input.repo ? `${input.owner}/${input.repo}` : null;
}

function main() {
  const payload = io.parsePayload(io.readStdin());
  const dataDir = io.dataDir(process.argv);
  const projectDir = cfg.projectDir(payload);
  const { config } = cfg.load(projectDir);
  const input = payload.tool_input || {};

  const method = String(input.merge_method || input.mergeMethod || '').toLowerCase();
  const pullNumber = input.pullNumber || input.pull_number;
  const slug = slugOf(input);
  const base = cfg.get(config, 'git.baseBranch', 'main');
  const targetBranch = guard.resolvePrBaseBranch(projectDir, pullNumber, slug);

  let verdict;
  if (targetBranch && targetBranch !== base) {
    verdict = mc.childVerdict({ config, projectDir, payload }, pullNumber, slug);
  } else {
    // Checked BEFORE the marker gate, so a refused message never uses up the
    // human's single-use marker.
    verdict = squashMessageVerdict(config, input, slug, pullNumber, projectDir, base, payload);
  }
  // An unreadable PR is never merged silently, not even with a fresh marker:
  // non-squash is denied as usual, anything else becomes an ask carrying the
  // warning (the marker is left unused).
  if (verdict && verdict.defer) {
    const why = verdict.defer;
    verdict = (method !== 'squash' && cfg.get(config, 'git.squashOnly', true) === true)
      ? { deny: 'forge merge-gate guard: this repository squash-merges only. Re-run with merge_method "squash".' }
      : { ask: `forge merge-gate: merging PR #${pullNumber || '?'} would change ${base}, and ${why}. Approve only if the human asked for this merge and the squash message is the PR's current title and description.` };
  }
  if (!verdict && !(targetBranch && targetBranch !== base)) {
    verdict = guard.checkMerge({ config, projectDir, payload, dataDir }, {
      what: `merging PR #${pullNumber || '?'} through the GitHub MCP server`,
      pr: Number.isFinite(Number(pullNumber)) ? Number(pullNumber) : undefined,
      slug,
      requireSquash: true,
      // An unset merge_method means the repository default, which is not
      // provably a squash: treat it as not-a-squash and make the caller say so.
      isSquash: method === 'squash',
      targetBranch,
    });
  }
  if (!verdict) return;
  emit(verdict, payload, dataDir);
}

// opusjevos D-BC: the squash into the base branch carries the PR's current
// title and description, which ARE the change report. The merge call must
// state them (commit_title = the title, optionally with " (#N)"; commit_message
// = the description); an unset value would mean the repository default, which
// is not provably the description. Whitespace at the ends and CRLF are
// ignored. `merge.requireSquashMessage: false` turns this off.
function norm(t) {
  return String(t === undefined || t === null ? '' : t).replace(/\r\n/g, '\n').trim();
}

function squashMessageVerdict(config, input, slug, pullNumber, projectDir, base, payload) {
  if (cfg.get(config, 'merge.requireSquashMessage', true) !== true) return null;
  const n = Number(pullNumber);
  const pr = githubRead.pullRequest(slug, n, projectDir);
  const head = `forge merge-gate guard: merging PR #${Number.isFinite(n) ? n : '?'} into ${base} `;
  if (!pr) {
    // A private repository with gh logged out cannot be read at all. Where an
    // approval reaches the human, do not decide here: the normal merge gate
    // (marker, squash-only) still runs, and its ask carries this warning.
    // An early ask must never stand in for the gate's checks.
    const why = 'the pull request\'s title and description could not be read, so the squash message cannot be checked (D-BC)';
    if (mc.mayAsk(config, payload)) return { defer: why };
    return { deny: `${head}is blocked because ${why}. Retry; if it repeats, tell the human.` };
  }
  const title = norm(input.commit_title);
  const okTitle = title === norm(pr.title) || title === `${norm(pr.title)} (#${n})`;
  const okBody = input.commit_message !== undefined && norm(input.commit_message) === norm(pr.body);
  if (okTitle && okBody) return null;
  const missing = [!okTitle && 'commit_title must be the PR title', !okBody && 'commit_message must be the PR description'].filter(Boolean).join(' and ');
  return {
    deny: `${head}is blocked: ${missing}, exactly as they are now (the description is the change report and becomes the squash message, D-BC). `
      + 'Update the PR description first if it is stale, then pass both in the merge call.',
  };
}

function emit(verdict, payload, dataDir) {
  io.telemetry(dataDir, {
    event: verdict.ask ? 'guard_ask' : 'guard_deny',
    guard: 'merge-gate',
    tool: payload.tool_name || 'mcp__github__merge_pull_request',
    session_id: payload.session_id || null,
  });
  if (verdict.ask) io.ask(verdict.ask, 'PreToolUse');
  else io.deny(verdict.deny, 'PreToolUse');
}

try {
  main();
} catch (e) {
  // fail CLOSED (see header)
  io.deny('forge merge-gate guard: the merge check crashed unexpectedly, so the merge is blocked. Retry; if it repeats, tell the human.', 'PreToolUse');
}
process.exit(0);
