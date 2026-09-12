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
  const apiHost = process.env.GITHUB_API_URL ? new URL(process.env.GITHUB_API_URL).hostname : 'api.github.com';
  const options = {
    hostname: apiHost,
    path: `/repos/${owner}/${name}/statuses/${sha}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'forge-reviewer-clean-check',
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          log(`posted status ${state} (HTTP ${res.statusCode})`);
          resolve();
        } else {
          reject(new Error(`GitHub statuses API returned HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function skip(reason) {
  log(`skipped (${reason})`);
  try {
    await postStatus('success', `skipped: ${reason}`);
  } catch (e) {
    log(`could not post skip status: ${e.message}`);
  }
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
  const m = /(\d+)\s+bugs?,\s*(\d+)\s+security\s+issues?,\s*(\d+)\s+convention\s+violations?,\s*(\d+)\s+suggestions?/i.exec(resultText || '');
  if (!m) return null;
  return {
    bugs: Number(m[1]),
    security: Number(m[2]),
    convention: Number(m[3]),
    suggestions: Number(m[4]),
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
    '--allowedTools', 'Read,Glob,Grep,Bash(git *)',
    '--output-format', 'json',
  ];
  // Explicit minimal env: the reviewed diff is untrusted PR content and the
  // reviewer process has Bash(git *) access, so it must not inherit
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

  if (result.error) {
    return skip(`claude invocation failed to start (${result.error.message})`);
  }
  if (result.signal) {
    log(`claude was killed by signal ${result.signal} (likely the ${TIMEOUT_MS / 1000}s timeout)`);
    await postStatus('failure', `reviewer timed out or was killed (${result.signal})`);
    process.exit(1);
    return;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    if (/not logged in|authentication|please run `?claude login|not authenticated/i.test(stderr)) {
      return skip('claude CLI not authenticated');
    }
    log(`claude exited ${result.status}: ${stderr.slice(0, 2000)}`);
    await postStatus('failure', 'reviewer invocation failed — see CI logs');
    process.exit(1);
    return;
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
    return;
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
