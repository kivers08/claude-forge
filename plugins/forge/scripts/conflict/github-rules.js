#!/usr/bin/env node
'use strict';
// Read-only: a repository's GitHub merge settings and branch rules, compared
// with the rules forge and the owner's decisions fix (opusjevos D-AV conflict
// check; D32, D-BC, D-BG, D-BH, D-BI). Used by the conflict-check skill.
//
//   node github-rules.js <owner/repo> [--checks "a,b"] [--parent-checks "a,b"]
//                        [--parent feature/x] [--child claude/x] [--json]
//
// --checks / --parent-checks: the status checks that repository's main / parent
// branches must require (forge's own: "validate,forge validators,reviewer clean"
// and "validate,forge validators"). Without them, only "requires no checks at
// all" is reported, since check names differ per repository.
//
// Reads with `gh api` when gh is logged in, else plain HTTPS to api.github.com
// without credentials (works for public repositories only; a private one says
// so instead of guessing). Never writes anything.
//
// Exit codes: 0 no findings, 1 findings listed, 2 could not read.
// Node stdlib only (D11).
const { spawnSync } = require('child_process');

const FORGE_CHECKS = {
  main: ['validate', 'forge validators', 'reviewer clean'],
  parent: ['validate', 'forge validators'],
};

function sh(cmd, args) {
  try {
    return spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000 });
  } catch (e) {
    return { status: 1, stdout: '', stderr: String(e) };
  }
}

let ghOk = null;
function apiGet(path) {
  if (ghOk === null) ghOk = sh('gh', ['auth', 'status']).status === 0;
  const r = ghOk
    ? sh('gh', ['api', path])
    : sh('curl', ['-sS', '-m', '15', '-H', 'Accept: application/vnd.github+json', `https://api.github.com/${path}`]);
  if (r.status !== 0) return { error: (r.stderr || '').trim().slice(0, 200) || 'request failed' };
  try {
    return { data: JSON.parse(r.stdout) };
  } catch (e) {
    return { error: 'response was not JSON' };
  }
}

function ruleOf(rules, type) {
  return (Array.isArray(rules) ? rules : []).find((r) => r && r.type === type) || null;
}

function checkNames(rules) {
  const r = ruleOf(rules, 'required_status_checks');
  return r && r.parameters && Array.isArray(r.parameters.required_status_checks)
    ? r.parameters.required_status_checks.map((c) => c.context)
    : [];
}

// Pure comparison. repo = GET /repos/o/r; branches = { main, parent, child }
// each the GET /repos/o/r/rules/branches/<b> array (or null if unread).
function evaluate(repo, branches, expect) {
  const want = expect || {};
  const f = [];
  const ok = [];
  const MERGE_FIELDS = ['allow_squash_merge', 'allow_merge_commit', 'allow_rebase_merge', 'allow_auto_merge'];
  if (repo && MERGE_FIELDS.some((k) => typeof repo[k] !== 'boolean')) {
    // GitHub shows these only to callers with push/admin access: absent means
    // unknown, never "off".
    f.push('Repository merge settings are not visible to this reader (needs push/admin access), so squash-only, the squash message and auto-merge cannot be verified.');
  } else if (repo) {
    if (repo.allow_merge_commit) f.push('Repository allows merge commits; decisions say squash only (D32, D-BC).');
    if (repo.allow_rebase_merge) f.push('Repository allows rebase merges; decisions say squash only.');
    if (!repo.allow_squash_merge) f.push('Repository does not allow squash merges; decisions require them.');
    if (repo.allow_squash_merge && (repo.squash_merge_commit_title !== 'PR_TITLE' || repo.squash_merge_commit_message !== 'PR_BODY')) {
      f.push('Squash message default is not "PR title + description"; decisions make the PR description the squash message (D-BC).');
    }
    if (repo.allow_auto_merge === false) f.push('Repository auto-merge is off; child PRs auto-merge into parents (D-BH) need it on (forge still blocks auto-merge into main).');
    if (repo.allow_squash_merge && !repo.allow_merge_commit && !repo.allow_rebase_merge) ok.push('squash only');
  }
  const main = branches.main;
  if (main) {
    const pr = ruleOf(main, 'pull_request');
    if (!pr) f.push('Main has no "require a pull request" rule.');
    else {
      const p = pr.parameters || {};
      if (Array.isArray(p.allowed_merge_methods) && p.allowed_merge_methods.some((m) => m !== 'squash')) {
        f.push(`Main allows merge methods ${p.allowed_merge_methods.join(', ')}; decisions say squash only.`);
      }
      if (p.required_approving_review_count > 0) {
        f.push(`Main requires ${p.required_approving_review_count} approving review(s). If Claude works through the owner's own account, GitHub does not let an author approve their own PR, so nothing can merge (D-BG).`);
      }
    }
    if (!checkNames(main).length) f.push('Main requires no status checks, so failing tests do not block a merge.');
    const missing = (want.main || []).filter((c) => !checkNames(main).includes(c));
    if (missing.length) f.push(`Main does not require these checks: ${missing.join(', ')}.`);
    if (!ruleOf(main, 'non_fast_forward')) f.push('Main does not block force-push.');
    if (!ruleOf(main, 'deletion')) f.push('Main does not block deletion.');
  } else {
    f.push('Main branch rules could not be read.');
  }
  if (branches.parent === null) {
    f.push('Parent branch (feature/*) rules could not be read, so D-BH cannot be verified.');
  } else if (branches.parent) {
    if (!branches.parent.length) f.push('Parent branches (feature/*) have no rules; D-BH needs PR + squash + required checks there.');
    else {
      if (!checkNames(branches.parent).length) f.push('Parent branches require no status checks; children would auto-merge untested (D-BH).');
      const missing = (want.parent || []).filter((c) => !checkNames(branches.parent).includes(c));
      if (missing.length) f.push(`Parent branches do not require: ${missing.join(', ')} (D-BH).`);
      const req = ruleOf(branches.parent, 'required_status_checks');
      if (req && req.parameters && req.parameters.strict_required_status_checks_policy) {
        f.push('Parent branches require being up to date; each auto-merged child then stalls the next one (D-BI).');
      }
      if (!ruleOf(branches.parent, 'pull_request')) f.push('Parent branches do not require a pull request (D-BH).');
    }
  }
  if (branches.child === null) {
    f.push('Child branch (claude/*) rules could not be read, so D-BG 3 cannot be verified.');
  } else if (branches.child && ruleOf(branches.child, 'pull_request')) {
    f.push('Child branches (claude/*) require a pull request to change; Claude pushes to its own child branch directly, so this may block work (D-BG 3).');
  }
  return { findings: f, ok };
}

function main(argv) {
  const args = argv.slice(2);
  // The repository is the first argument that is neither an option nor an
  // option's value (`--parent feature/x` must not be read as a repo).
  const WITH_VALUE = new Set(['--parent', '--child', '--checks', '--parent-checks']);
  let slug = null;
  for (let i = 0; i < args.length; i++) {
    if (WITH_VALUE.has(args[i])) { i++; continue; }
    if (args[i].startsWith('--')) continue;
    if (/^[\w.-]+\/[\w.-]+$/.test(args[i])) { slug = args[i]; break; }
  }
  const opt = (name, dflt) => {
    const i = args.indexOf(name);
    if (i === -1) return dflt;
    const v = args[i + 1];
    return v === undefined || v.startsWith('--') ? dflt : v;
  };
  if (!slug) {
    console.error('usage: github-rules.js <owner/repo> [--checks "a,b"] [--parent-checks "a,b"] [--parent feature/x] [--child claude/x] [--json]');
    return 2;
  }
  const repoRes = apiGet(`repos/${slug}`);
  if (repoRes.error || !repoRes.data || repoRes.data.message) {
    console.error(`could not read ${slug}: ${repoRes.error || repoRes.data.message}. A private repository needs a logged-in gh; say so rather than guess.`);
    return 2;
  }
  const repo = repoRes.data;
  const base = repo.default_branch || 'main';
  const read = (b) => {
    const r = apiGet(`repos/${slug}/rules/branches/${encodeURIComponent(b)}`);
    return r.error || !Array.isArray(r.data) ? null : r.data;
  };
  const branches = {
    main: read(base),
    parent: read(opt('--parent', 'feature/conflict-check-probe')),
    child: read(opt('--child', 'claude/conflict-check-probe')),
  };
  const list = (v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
  const res = evaluate(repo, branches, { main: list(opt('--checks', '')), parent: list(opt('--parent-checks', '')) });
  if (args.includes('--json')) {
    console.log(JSON.stringify({ repo: slug, via: ghOk ? 'gh' : 'https (no credentials)', ...res }, null, 2));
  } else {
    console.log(`GitHub rules for ${slug} (read ${ghOk ? 'with gh' : 'without credentials'}; base ${base})`);
    if (res.ok.length) console.log(`OK: ${res.ok.join('; ')}`);
    if (!res.findings.length) console.log('No conflicts with the logged merge rules.');
    res.findings.forEach((x, i) => console.log(`${i + 1}. ${x}`));
  }
  return res.findings.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv);
else module.exports = { evaluate, checkNames, FORGE_CHECKS, main };
