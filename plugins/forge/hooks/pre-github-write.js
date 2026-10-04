#!/usr/bin/env node
'use strict';
// PreToolUse on the GitHub tools that can change the base branch WITHOUT
// merge_pull_request: file pushes and edits aimed at it, deleting a file on it,
// enabling auto-merge (the merge happens later with nobody watching), and
// re-pointing a pull request at it. Each is gated like a merge into the base
// branch (lib/merge-control.js). Anything aimed at another branch passes.
//
// Fails CLOSED on a crash, same reasoning as pre-merge-mcp.js.
const io = require('./lib/io');
const cfg = require('./lib/config');
const mc = require('./lib/merge-control');
const guard = require('./guards/merge-gate');

function main() {
  const payload = io.parsePayload(io.readStdin());
  const dataDir = io.dataDir(process.argv);
  const projectDir = cfg.projectDir(payload);
  const { config } = cfg.load(projectDir);
  const input = payload.tool_input || {};
  const tool = String(payload.tool_name || '');
  const base = cfg.get(config, 'git.baseBranch', 'main');
  const slug = input.owner && input.repo ? `${input.owner}/${input.repo}` : null;
  const pr = Number(input.pullNumber || input.pull_number);

  let what = null;
  let targetBranch;
  if (/push_files$|create_or_update_file$|delete_file$/.test(tool)) {
    // No branch given means the repository default branch, i.e. the base.
    targetBranch = String(input.branch || '').replace(/^refs\/heads\//, '') || base;
    if (targetBranch !== base) return;
    what = `\`${tool.replace('mcp__github__', '')}\` writing to ${base}`;
  } else if (/enable_pr_auto_merge$/.test(tool)) {
    targetBranch = guard.resolvePrBaseBranch(projectDir, Number.isFinite(pr) ? pr : undefined, slug);
    what = `enabling auto-merge on PR #${Number.isFinite(pr) ? pr : '?'}`;
  } else if (/update_pull_request$/.test(tool)) {
    if (String(input.base || '') !== base) return; // not re-pointing at the base
    targetBranch = base;
    what = `re-pointing PR #${Number.isFinite(pr) ? pr : '?'} at ${base}`;
  } else {
    return;
  }

  // Direct writes have no PR to bind a spoken marker to (pr stays unset);
  // auto-merge and re-pointing do.
  const bound = /enable_pr_auto_merge$|update_pull_request$/.test(tool) && Number.isFinite(pr) ? pr : undefined;
  const verdict = guard.checkMerge({ config, projectDir, payload, dataDir }, {
    what, pr: bound, slug, targetBranch,
  });
  if (!verdict) return;
  io.telemetry(dataDir, {
    event: verdict.ask ? 'guard_ask' : 'guard_deny',
    guard: 'merge-gate',
    tool,
    session_id: payload.session_id || null,
  });
  if (verdict.ask) io.ask(verdict.ask, 'PreToolUse');
  else io.deny(verdict.deny, 'PreToolUse');
}

try {
  main();
} catch (e) {
  io.deny('forge merge-gate guard: the base-branch write check crashed unexpectedly, so the change is blocked. Retry; if it repeats, tell the human.', 'PreToolUse');
}
process.exit(0);
