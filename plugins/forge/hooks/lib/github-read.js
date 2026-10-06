'use strict';
// Read-only GitHub lookups for the merge guards. `gh api` first; when gh is
// missing or not logged in (the usual case in a cloud session), plain HTTPS
// to api.github.com without credentials, which answers for PUBLIC
// repositories only. Every function returns null when nothing could be read;
// callers treat null as "cannot confirm" and fail safe.
//
// FORGE_GITHUB_HTTP=off disables the HTTPS fallback (the hook tests set it,
// so no test touches the network). Node stdlib only (D11).
const { spawnSync } = require('child_process');

function run(cmd, args, cwd) {
  try {
    return spawnSync(cmd, args, { cwd: cwd || undefined, encoding: 'utf8', timeout: 15000 });
  } catch (e) {
    return { status: 1, stdout: '' };
  }
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// GET /<path> (no leading slash), parsed JSON or null.
function apiGet(path, cwd) {
  const r = run('gh', ['api', path], cwd);
  if (r.status === 0) {
    const j = parse(r.stdout);
    if (j !== null) return j;
  }
  if (String(process.env.FORGE_GITHUB_HTTP || '').toLowerCase() === 'off') return null;
  const c = run('curl', ['-sS', '-f', '-m', '10', '-H', 'Accept: application/vnd.github+json', `https://api.github.com/${path}`], cwd);
  return c.status === 0 ? parse(c.stdout) : null;
}

function encodeBranch(b) {
  return String(b).split('/').map(encodeURIComponent).join('/');
}

// { title, body, base } of a pull request, or null.
function pullRequest(slug, number, cwd) {
  if (!slug || !Number.isFinite(Number(number))) return null;
  const j = apiGet(`repos/${slug}/pulls/${Number(number)}`, cwd);
  if (!j || typeof j !== 'object' || typeof j.title !== 'string') return null;
  return { title: j.title, body: typeof j.body === 'string' ? j.body : '', base: j.base && j.base.ref ? j.base.ref : null };
}

// The active rules on a branch (array), or null when unreadable.
function branchRules(slug, branch, cwd) {
  if (!slug || !branch) return null;
  const j = apiGet(`repos/${slug}/rules/branches/${encodeBranch(branch)}`, cwd);
  return Array.isArray(j) ? j : null;
}

// True when GitHub itself will hold a merge into `branch` until checks pass:
// a pull_request rule plus a non-empty required_status_checks rule.
function branchRequiresChecks(rules) {
  if (!Array.isArray(rules)) return false;
  const pr = rules.some((r) => r && r.type === 'pull_request');
  const checks = rules.find((r) => r && r.type === 'required_status_checks');
  const list = checks && checks.parameters && Array.isArray(checks.parameters.required_status_checks)
    ? checks.parameters.required_status_checks : [];
  return pr && list.length > 0;
}

module.exports = { apiGet, pullRequest, branchRules, branchRequiresChecks };
