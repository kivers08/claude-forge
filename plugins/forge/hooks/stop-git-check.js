#!/usr/bin/env node
'use strict';
// Stop: refuse to end a turn on work that only exists in this container.
//
// A cloud container is reclaimed after a period of inactivity. Uncommitted or
// unpushed work at Stop is work that is about to stop existing. Blocking here
// is the whole point of the hook, so it is the one place that does NOT fail
// open on a real finding — but it still fails open on anything it cannot
// determine (no git, detached HEAD, no upstream, git errors).
//
// stop_hook_active guards the loop: if the previous Stop was already blocked by
// this hook, let the turn end rather than trap the session.
const { spawnSync } = require('child_process');
const io = require('./lib/io');
const cfg = require('./lib/config');

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

function main() {
  const payload = io.parsePayload(io.readStdin());
  if (payload.stop_hook_active) return;

  const cwd = cfg.projectDir(payload);
  if (!cwd) return; // cannot determine the project: fail open
  if (git(cwd, ['rev-parse', '--is-inside-work-tree']) === null) return;

  const problems = [];

  const status = git(cwd, ['status', '--porcelain']);
  if (status && status.trim()) {
    const files = status.trim().split('\n').map((l) => l.slice(3)).slice(0, 10);
    problems.push(`uncommitted changes in ${files.length} file(s): ${files.join(', ')}`);
  }

  const branch = (git(cwd, ['branch', '--show-current']) || '').trim();
  if (branch) {
    const upstream = git(cwd, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]);
    if (upstream === null) {
      // No upstream. Only a problem if the branch has commits the base does not.
      const base = cfg.get(cfg.load(cwd).config, 'git.baseBranch', 'main');
      const ahead = git(cwd, ['rev-list', '--count', `${base}..HEAD`]);
      if (ahead && Number(ahead.trim()) > 0) {
        problems.push(`branch "${branch}" has ${ahead.trim()} commit(s) not on ${base} and no upstream — nothing is pushed`);
      }
    } else {
      const counts = git(cwd, ['rev-list', '--left-right', '--count', `${upstream.trim()}...HEAD`]);
      if (counts) {
        const ahead = Number(counts.trim().split(/\s+/)[1] || 0);
        if (ahead > 0) problems.push(`${ahead} commit(s) on "${branch}" not pushed to ${upstream.trim()}`);
      }
    }
  }

  if (!problems.length) return;

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: 'forge stop git-check: this work only exists in this container, which is '
      + 'reclaimed after a period of inactivity.\n- ' + problems.join('\n- ')
      + '\n\nCommit and `git push -u origin <branch>` before ending the turn. If the '
      + 'leftovers are deliberate (scratch files, a half-written experiment you do '
      + 'not want), say so explicitly and end the turn again — this hook does not '
      + 'block twice in a row.',
  }));
}

try {
  main();
} catch (e) {
  // fail open
}
process.exit(0);
