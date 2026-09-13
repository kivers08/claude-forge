#!/usr/bin/env node
'use strict';
// D20/U3: "reviewer clean" commit status. Self-hosted runner only (the
// ci.yml job this runs in is gated the same way as the `validate` and
// `forge-validators` jobs) and pull_request events only. Dispatches the
// forge:reviewer agent headlessly (`claude -p`, fed its own
// agents/reviewer.md system prompt verbatim, same "full" mode the `review`
// skill defaults to) against the PR diff, then posts a commit status.
//
// Reuses the machine's own `claude` login (the owner's subscription auth,
// already present on the self-hosted runner) — this script never reads or
// requires ANTHROPIC_API_KEY or any other new secret. If `claude` isn't on
// PATH, isn't authenticated, or this isn't a self-hosted pull_request run,
// this posts a "success" status with a "skipped: <reason>" description
// rather than failing the build — the same graceful-degrade pattern as the
// "claude plugin validate --strict" step in ci.yml.
//
// Node builtins only (fs, path, https, child_process, url) — no npm deps,
// matching every other script in this repo.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CONTEXT = 'reviewer clean';

function log(msg) {
  console.log(`reviewer clean: ${msg}`);
}

// Never rejects: a transient failure to POST the status (network blip, API
// hiccup) must not crash main() and turn an actual clean/failed review into
// a misreported process crash — every call site relies on this resolving.
function postStatus(state, description) {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.PR_HEAD_SHA;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !sha || !token) {
    log(`cannot post status (missing GITHUB_REPOSITORY/PR_HEAD_SHA/GITHUB_TOKEN) — would have posted ${state}: ${description}`);
    return Promise.resolve();
  }
  const body = JSON.stringify({
    state,
    description: description.slice(0, 140),
    context: CONTEXT,
  });
  const [owner, name] = repo.split('/');
  // Join onto GITHUB_API_URL's own path, not just its hostname — on GitHub
  // Enterprise that URL includes a `/api/v3` prefix the request must keep.
  const apiBase = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const apiUrl = new URL(`${apiBase}/repos/${owner}/${name}/statuses/${sha}`);
  const options = {
    hostname: apiUrl.hostname,
    path: apiUrl.pathname + apiUrl.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'forge-reviewer-clean-check',
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  };
  return new Promise((resolve) => {
    const fail = (e) => {
      log(`could not post status ${state}: ${e.message}`);
      resolve();
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          log(`posted status ${state} (HTTP ${res.statusCode})`);
          resolve();
        } else {
          fail(new Error(`GitHub statuses API returned HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', fail);
    req.write(body);
    req.end();
  });
}

async function skip(reason) {
  log(`skipped (${reason})`);
  await postStatus('success', `skipped: ${reason}`);
  process.exit(0);
}

function hasClaude() {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

function readReviewerSystemPrompt() {
  const file = path.join(ROOT, 'plugins', 'forge', 'agents', 'reviewer.md');
  const text = fs.readFileSync(file, 'utf8');
  const end = text.startsWith('---\n') ? text.indexOf('\n---', 4) : -1;
  return end === -1 ? text : text.slice(end + 4).trim();
}

// Parses the reviewer agent's required closing summary line, e.g.
// "2 bugs, 0 security issues, 1 convention violation, 3 suggestions."
function parseSummary(resultText) {
  // Global + last-match: the reviewer's own instructions require this as
  // the closing line, but its report body can legitimately contain earlier
  // text matching the same shape (an example, a quoted finding). Anchoring
  // on the last occurrence picks the actual closing summary instead of
  // whichever matches first.
  const re = /(\d+)\s+bugs?,\s*(\d+)\s+security\s+issues?,\s*(\d+)\s+convention\s+violations?,\s*(\d+)\s+suggestions?/gi;
  let m;
  let last = null;
  while ((m = re.exec(resultText || '')) !== null) last = m;
  if (!last) return null;
  return {
    bugs: Number(last[1]),
    security: Number(last[2]),
    convention: Number(last[3]),
    suggestions: Number(last[4]),
  };
}

async function main() {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') {
    log('not a pull_request event, nothing to review');
    return;
  }
  // Case-insensitive: the CORP_RUNNER repo/org variable has been observed
  // set as "TRUE" (uppercase). GitHub Actions' own `vars.CORP_RUNNER ==
  // 'true'` expression (used for `runs-on` in ci.yml) is case-insensitive;
  // this must match that or it silently no-ops on a runner it's actually on.
  if ((process.env.CORP_RUNNER || '').toLowerCase() !== 'true') {
    return skip('self-hosted runner (CORP_RUNNER) not available on this run');
  }
  if (!hasClaude()) {
    return skip('claude CLI not on PATH');
  }

  const base = process.env.GITHUB_BASE_REF;
  if (!base) {
    return skip('GITHUB_BASE_REF not set (not a pull_request run)');
  }

  const systemPrompt = readReviewerSystemPrompt();
  const prompt = [
    'Review this repository\'s current branch diff against its base branch',
    `"${base}" (i.e. \`origin/${base}...HEAD\`), in "full" mode (the`,
    'review skill\'s default: correctness bugs, security issues, convention',
    'violations, test coverage gaps, simplification suggestions, in that',
    'priority order). Resolve the diff yourself with `git diff` per your',
    'own instructions above — do not assume it has been pasted in for you.',
    'Follow your report format exactly, and end with the required one-line',
    'summary: "N bugs, N security issues, N convention violations, N',
    'suggestions." with a real count in every N, even when a category is',
    'zero.',
  ].join(' ');

  const args = [
    '-p', prompt,
    '--append-system-prompt', systemPrompt,
    // --restricted confines Read/Glob/Grep (and every other file tool) to
    // --add-dir's working directories and strips Bash/WebFetch/etc. unless
    // named in --tools — --allowedTools alone only scoped Bash, leaving
    // Read/Glob/Grep able to reach anywhere the runner's own user can (e.g.
    // ~/.ssh, ~/.aws), which a prompt injection in the untrusted PR diff
    // could exploit on this persistent self-hosted runner. --tools then
    // re-grants exactly the same read-only git subcommands as before — not
    // `Bash(git *)`, so the diff still can't walk this into `git
    // push`/`git commit`/`git config`/etc. (this runner has ambient git
    // credentials for other CI jobs, so a mutating command could succeed
    // even without GITHUB_TOKEN in this process's own env).
    '--restricted', '--add-dir', ROOT,
    '--tools', 'Read,Glob,Grep,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git status:*)',
    '--output-format', 'json',
  ];
  // Explicit minimal env: the reviewed diff is untrusted PR content and the
  // reviewer process has Bash(git ...) access, so it must not inherit
  // GITHUB_TOKEN (this job's own repo-scoped credential, only needed by
  // this script's own postStatus() call) or PR_HEAD_SHA/GITHUB_* run
  // metadata it has no legitimate use for. PATH/HOME (+ TMPDIR if set) are
  // all `claude` itself needs to run and find its own auth.
  const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  if (process.env.TMPDIR) childEnv.TMPDIR = process.env.TMPDIR;
  // Bounded: this runs on the single self-hosted runner (kewi-dev). An
  // unbounded hang here (network blip, a stuck permission wait, claude
  // itself wedging) would block every subsequent CI job on that runner,
  // not just this PR's check, for up to GitHub's 360-minute default cap.
  const TIMEOUT_MS = 10 * 60 * 1000;
  const result = spawnSync('claude', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 32,
    env: childEnv,
    timeout: TIMEOUT_MS,
  });

  // Check timeout/kill before the generic result.error case: Node's
  // spawnSync sets BOTH result.error (code ETIMEDOUT) AND result.signal
  // when the timeout fires, so checking result.error first would swallow
  // a hang as a benign "couldn't start" skip() — success — which is
  // exactly backwards from why TIMEOUT_MS exists.
  const timedOut = result.signal || (result.error && result.error.code === 'ETIMEDOUT');
  if (timedOut) {
    log(`claude timed out or was killed (signal=${result.signal || 'n/a'}, error=${result.error ? result.error.code : 'n/a'})`);
    await postStatus('failure', `reviewer timed out after ${TIMEOUT_MS / 1000}s`);
    process.exit(1);
  }
  if (result.error) {
    // ENOENT means the binary genuinely isn't there to run — a legitimate
    // skip. Anything else (e.g. E2BIG on a huge prompt, ENOBUFS past the 32
    // MiB output cap) means claude did start, so treating it as a skip
    // would post a false "success" for a review that never completed.
    if (result.error.code === 'ENOENT') {
      return skip(`claude invocation failed to start (${result.error.message})`);
    }
    log(`claude invocation errored (${result.error.code || 'unknown'}): ${result.error.message}`);
    await postStatus('failure', `reviewer invocation errored: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    if (/not logged in|authentication|please run `?claude login|not authenticated/i.test(stderr)) {
      return skip('claude CLI not authenticated');
    }
    log(`claude exited ${result.status}: ${stderr.slice(0, 2000)}`);
    await postStatus('failure', 'reviewer invocation failed — see CI logs');
    process.exit(1);
  }

  let resultText = result.stdout;
  try {
    const parsed = JSON.parse(result.stdout);
    resultText = parsed.result || parsed.output || result.stdout;
  } catch (e) {
    // --output-format json didn't parse (unexpected shape); fall back to
    // treating stdout as plain text and search it directly.
  }

  const summary = parseSummary(resultText);
  if (!summary) {
    log('could not find the reviewer\'s required summary line in its output');
    log(`full reviewer output follows:\n${resultText}`);
    await postStatus('failure', 'reviewer clean: could not parse reviewer summary');
    process.exit(1);
  }

  // Blocking = bugs + security issues + convention violations. Bare
  // suggestions (simplification/dead-code) do not block on their own, per
  // the reviewer agent's own framing of that category as "suggestions
  // only" (lowest of its four severities).
  const blocking = summary.bugs + summary.security + summary.convention;
  const desc = `${summary.bugs} bugs, ${summary.security} security, ${summary.convention} convention, ${summary.suggestions} suggestions`;
  if (blocking === 0) {
    await postStatus('success', desc);
    log(`clean: ${desc}`);
  } else {
    // Full report to the job log (not just the summary counts) so a
    // failing check is actionable from CI logs alone.
    log(`not clean: ${desc}`);
    log(`full reviewer report follows:\n${resultText}`);
    await postStatus('failure', desc);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`reviewer clean: unexpected error: ${e.stack || e.message}`);
    process.exit(1);
  });
} else {
  module.exports = { parseSummary };
}
