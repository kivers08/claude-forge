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
    verdict = childVerdict({ config, projectDir, payload }, pullNumber, slug);
  } else {
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

function childVerdict(ctx, pullNumber, slug) {
  if (cfg.get(ctx.config, 'merge.requireChildTests', true) !== true) return null;
  const repoDir = mc.findRepoDir(ctx.projectDir, slug);
  const r = mc.childChecks(repoDir, pullNumber, slug);
  if (r.ok) return null;
  const hint = 'Read the results with the digest script (plugins/forge/scripts/digest/digest.js ci), fix them, '
    + 'then merge. Put the digest summary line in the merge commit message.';
  if (r.kind === 'unknown' && mc.mayAsk(ctx.config, ctx.payload)) {
    return { ask: `forge merge-gate: PR #${pullNumber || '?'} has no usable test result (${r.why}). Approve only if you accept merging it untested.` };
  }
  return {
    deny: `forge merge-gate guard: PR #${pullNumber || '?'} cannot merge into its parent branch because ${r.why}. ${hint}`,
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
