'use strict';
// Shared merge control (D32 in docs/decisions.md; opusjevos D-I, D-J, D-P,
// D-AO..D-AR). Everything that decides "may this land on the base branch?"
// lives here so the Bash guards, the GitHub-tool hooks and the prompt hook
// agree on one rule:
//
//   Nothing lands on the base branch (git.baseBranch, default main) unless
//   a human decision is on file:
//     1. legacy marker  .git/claude-human-merge-ok  (a human `touch`), or
//     2. spoken marker  <plugin data>/merge-ok.json (written ONLY by
//        user-prompt-submit.js, when merge.spokenWord is true and the human's
//        whole message was a merge command), or
//     3. a one-tap approval ("ask") when the session's permission mode is one
//        where an ask is known to reach the human.
//   Markers are valid MAX_AGE_MS after creation and are SINGLE-USE: consumed
//   when a merge they authorized is let through.
//
// Node stdlib only (D11).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { get } = require('./config');

const MARKER = 'claude-human-merge-ok';
const SPOKEN = 'merge-ok.json';
const MAX_AGE_MS = 15 * 60 * 1000; // D-AP: 15 minutes

// Permission modes in which an "ask" verdict is known to reach the human as an
// approval prompt. `auto` hands approvals to a classifier and the docs are
// silent on whether "ask" still reaches the human, so it is OFF there until
// `merge.askInAutoMode` is set after a live probe. Unknown modes never ask.
const ASK_MODES = new Set(['default', 'acceptEdits', 'plan']);

function run(cmd, args, cwd) {
  try {
    return spawnSync(cmd, args, { cwd: cwd || undefined, encoding: 'utf8' });
  } catch (e) {
    return { status: 1, stdout: '', stderr: '' };
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

function gitTop(cwd) {
  if (!cwd || !isDir(cwd)) return null;
  const r = run('git', ['rev-parse', '--show-toplevel'], cwd);
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function gitDirOf(repoDir) {
  if (!repoDir) return null;
  const r = run('git', ['rev-parse', '--git-dir'], repoDir);
  if (r.status !== 0 || !r.stdout.trim()) return null;
  const d = r.stdout.trim();
  return path.isAbsolute(d) ? d : path.join(repoDir, d);
}

function originSlug(repoDir) {
  const r = run('git', ['config', '--get', 'remote.origin.url'], repoDir);
  const url = r.status === 0 ? r.stdout.trim().toLowerCase() : '';
  const m = url.match(/github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

// The repository a merge refers to. In a one-repo session that is the working
// directory's repo. In a multi-repo session (cwd is a parent folder such as
// /home/user, not a repo) it is the immediate child repo whose origin matches
// `slug` ("owner/repo"); no slug, or zero/several matches, means "unknown" and
// the caller fails safe.
function findRepoDir(cwd, slug) {
  const top = gitTop(cwd);
  if (top) return top;
  if (!cwd || !slug || !isDir(cwd)) return null;
  const want = String(slug).toLowerCase();
  let hits = [];
  try {
    for (const name of fs.readdirSync(cwd)) {
      const dir = path.join(cwd, name);
      if (isDir(path.join(dir, '.git')) && originSlug(dir) === want) hits.push(dir);
    }
  } catch (e) {
    return null;
  }
  return hits.length === 1 ? hits[0] : null;
}

// Open pull requests whose destination is `base`, via `gh`. null = could not
// be determined (no gh, no network): callers treat that as "cannot confirm".
function openPrsInto(repoDir, base, slug) {
  const args = ['pr', 'list', '--state', 'open', '--base', base, '--json', 'number', '-q', '.[].number'];
  if (slug) args.push('--repo', slug);
  const r = run('gh', args, repoDir || undefined);
  if (r.status !== 0) return null;
  return r.stdout.split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function ageMs(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch (e) {
    return null;
  }
}

// opts: { repoDir, dataDir, pr, slug, base }. `pr` set means a merge of that
// pull request; unset means a non-PR route (push, API) where only a marker
// that is not bound to one pull request counts.
// Returns { ok, why, file, source } and, on ok, the file to consume.
function markerState(opts) {
  const o = opts || {};
  const reasons = [];

  const dir = gitDirOf(o.repoDir);
  if (!dir) {
    reasons.push('not a git repository, so no merge marker could be read');
  } else {
    const file = path.join(dir, MARKER);
    const age = ageMs(file);
    if (age === null) reasons.push(`no ${MARKER} marker`);
    else if (age > MAX_AGE_MS) reasons.push(`the ${MARKER} marker is ${Math.round(age / 60000)} minutes old`);
    else return { ok: true, file, source: 'touch' };
  }

  if (o.dataDir) {
    const file = path.join(o.dataDir, SPOKEN);
    const m = readJson(file);
    const age = ageMs(file);
    if (m && age !== null && age <= MAX_AGE_MS) {
      const bound = Number.isFinite(Number(m.pr)) && m.pr !== null ? Number(m.pr) : null;
      if (o.pr !== undefined && o.pr !== null) {
        if (bound !== null) {
          if (bound === Number(o.pr)) return { ok: true, file, source: 'spoken' };
          reasons.push(`the spoken merge was for PR ${bound}, not PR ${o.pr}`);
        } else {
          // "merge" with no number: applies only to the one open PR into base.
          const open = openPrsInto(o.repoDir, o.base || 'main', o.slug);
          if (open && open.length === 1 && open[0] === Number(o.pr)) return { ok: true, file, source: 'spoken' };
          if (open && open.length > 1) reasons.push(`"merge" was said but ${open.length} pull requests are open into ${o.base || 'main'}; ask which one`);
          else reasons.push('"merge" was said but the single open pull request could not be confirmed; ask for the PR number');
        }
      } else if (bound === null) {
        return { ok: true, file, source: 'spoken' };
      } else {
        reasons.push(`the spoken merge was bound to PR ${bound}, not to this direct write`);
      }
    }
  }
  return { ok: false, why: reasons.join('; ') || `no ${MARKER} marker` };
}

function consume(state) {
  if (state && state.ok && state.file) {
    try {
      fs.unlinkSync(state.file);
    } catch (e) {
      // best effort
    }
  }
}

// True when an "ask" verdict may stand in for a deny.
function mayAsk(config, payload) {
  if (get(config, 'merge.ask', true) !== true) return false;
  const mode = payload && payload.permission_mode;
  if (ASK_MODES.has(mode)) return true;
  return mode === 'auto' && get(config, 'merge.askInAutoMode', false) === true;
}

// The no-marker verdict: ask when an ask is known to reach the human, else a
// deny that says how to proceed.
function noMarkerVerdict(ctx, what, why) {
  const base = get(ctx.config, 'git.baseBranch', 'main');
  if (mayAsk(ctx.config, ctx.payload)) {
    return {
      ask: `forge merge-gate: ${what} would change ${base}. Approve only if the human just asked for this (${why}).`,
    };
  }
  return {
    deny: `forge merge-gate guard: ${what} is blocked because ${why}. Changing the base `
      + `branch is the human's call, not the coordinator's. Ask for an explicit "merge" (or have the `
      + `human run \`touch .git/${MARKER}\`, valid for ${MAX_AGE_MS / 60000} minutes, single use).`,
  };
}

// Full gate for a route onto the base branch. ctx: { config, projectDir,
// payload, dataDir }. o: { what, pr, slug, targetBranch, requireSquash,
// isSquash }. Returns null (allow), { deny } or { ask }.
function gate(ctx, o) {
  const base = get(ctx.config, 'git.baseBranch', 'main');
  // Only a POSITIVELY resolved, DIFFERENT destination skips the gate.
  if (o.targetBranch && o.targetBranch !== base) return null;
  const repoDir = findRepoDir(ctx.projectDir, o.slug);
  const state = markerState({
    repoDir, dataDir: ctx.dataDir, pr: o.pr, slug: o.slug, base,
  });
  if (!state.ok) return noMarkerVerdict(ctx, o.what || 'this change', state.why);
  if (o.requireSquash && get(ctx.config, 'git.squashOnly', true) === true && !o.isSquash) {
    return {
      deny: 'forge merge-gate guard: this repository squash-merges only. '
        + 'Re-run with --squash (or set "git": {"squashOnly": false} in '
        + '.claude/forge.json if that policy has genuinely changed).',
    };
  }
  consume(state);
  return null;
}

// Tests of a child branch before it merges into its parent (D-AQ). Reads the
// pull request's checks through `gh`. Returns { ok:true } only on a clean pass.
// Anything else is { ok:false, kind, why }: kind 'fail' (a check failed or is
// still running) or 'unknown' (no checks, or gh could not be read). Unknown is
// NEVER a pass.
function childChecks(repoDir, pr, slug) {
  const args = ['pr', 'checks', String(pr), '--json', 'name,bucket'];
  if (slug) args.push('--repo', slug);
  const r = run('gh', args, repoDir || undefined);
  let rows = null;
  try {
    rows = JSON.parse(r.stdout);
  } catch (e) {
    rows = null;
  }
  if (!Array.isArray(rows)) return { ok: false, kind: 'unknown', why: 'could not read the pull request\'s checks' };
  if (rows.length === 0) return { ok: false, kind: 'unknown', why: 'the pull request has no checks, so no test result exists' };
  const bad = rows.filter((c) => c.bucket !== 'pass' && c.bucket !== 'skipping');
  if (bad.length) {
    return { ok: false, kind: 'fail', why: `checks not passing: ${bad.map((c) => `${c.name} (${c.bucket})`).slice(0, 5).join(', ')}` };
  }
  return { ok: true, count: rows.length };
}

module.exports = {
  MARKER, SPOKEN, MAX_AGE_MS,
  findRepoDir, markerState, consume, mayAsk, noMarkerVerdict, gate, childChecks, openPrsInto,
};
