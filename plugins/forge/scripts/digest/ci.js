'use strict';
// CI run digest (D-AB option A): fetch a GitHub Actions log with `gh`, find the failed
// step, and hand that step's text to the matching adapter. No app CI file changes.

const { spawnSync } = require('child_process');
const { stripAnsi, oneLine, tailOf, couldNotParse, detectRunner } = require('./common');
const ADAPTERS = {
  jest: require('./adapters/jest'),
  eslint: require('./adapters/eslint'),
  prettier: require('./adapters/prettier'),
  generic: require('./adapters/generic'),
};

const TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z /;

function gh(args) {
  const bin = process.env.FORGE_DIGEST_GH || 'gh';
  const r = spawnSync(bin, ['api', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error && r.error.code === 'ENOENT') {
    throw new Error('the `gh` CLI is not installed or not on PATH; cannot fetch CI logs here');
  }
  if (r.status !== 0) {
    throw new Error(`gh api ${args[0]} failed (exit ${r.status}): ${oneLine(r.stderr || r.stdout || 'no output')}`);
  }
  return r.stdout;
}

// Split a raw job log into steps: a step starts at a "##[group]Run <command>" line.
function splitSteps(raw) {
  const lines = stripAnsi(raw).split('\n').map((l) => l.replace(TIMESTAMP, ''));
  const steps = [];
  let cur = null;
  for (const l of lines) {
    const g = /^##\[group\]Run (.*)$/.exec(l);
    if (g) {
      cur = { command: g[1].trim(), lines: [] };
      steps.push(cur);
    } else if (cur) {
      cur.lines.push(l);
    }
  }
  return steps;
}

// Trust only an explicit tool name in the command; `npm test` or `npm run lint` could run any
// tool, so otherwise read the step's own output.
function pickAdapter(command, text) {
  const c = command.toLowerCase();
  if (/jest/.test(c)) return 'jest';
  if (/eslint/.test(c)) return 'eslint';
  if (/prettier/.test(c)) return 'prettier';
  return detectRunner(text);
}

// Digest the failed step of one job log. Returns { step, result } or a COULD NOT PARSE result.
function digestJobLog(raw) {
  const steps = splitSteps(raw);
  const idx = steps.findIndex((s) => s.lines.some((l) => /^##\[error\]Process completed with exit code \d+/.test(l)));
  if (idx === -1) {
    return { step: null, result: couldNotParse('CI', raw, 'no failed step ("Process completed with exit code") found in log') };
  }
  const step = steps[idx];
  const code = Number(/exit code (\d+)/.exec(step.lines.find((l) => /^##\[error\]Process completed/.test(l)))[1]);
  const text = step.lines.filter((l) => !/^##\[(error|endgroup|group)\]/.test(l)).join('\n');
  const runner = pickAdapter(step.command, text);
  return { step, runner, code, result: ADAPTERS[runner].parse(text, code) };
}

function digestRun(repo, runArg) {
  let run;
  if (/^\d+$/.test(runArg)) {
    run = JSON.parse(gh([`repos/${repo}/actions/runs/${runArg}`]));
  } else {
    const list = JSON.parse(gh([`repos/${repo}/actions/runs?branch=${encodeURIComponent(runArg)}&per_page=1`]));
    run = (list.workflow_runs || [])[0];
    if (!run) throw new Error(`no CI runs found for branch "${runArg}" in ${repo}`);
  }
  const header = [`CI RUN ${run.id} | ${repo} | ${run.head_branch} | ${String(run.head_sha || '').slice(0, 7)} | ${run.name}`];
  const conclusion = run.conclusion || run.status;
  if (conclusion !== 'failure') {
    return [{ kind: 'CI', status: conclusion === 'success' ? 'PASS' : String(conclusion).toUpperCase(), summary: 'no log fetched (run did not fail)', failures: [], header }];
  }
  const jobs = JSON.parse(gh([`repos/${repo}/actions/runs/${run.id}/jobs`])).jobs || [];
  const failedJobs = jobs.filter((j) => j.conclusion === 'failure').slice(0, 3);
  if (failedJobs.length === 0) {
    return [{ kind: 'CI', status: 'COULD NOT PARSE', summary: 'run failed but no failed job found', failures: [], header, tail: [] }];
  }
  return failedJobs.map((job, n) => {
    const { step, runner, result } = digestJobLog(gh([`repos/${repo}/actions/jobs/${job.id}/logs`]));
    const skipped = (job.steps || []).filter((s) => s.conclusion === 'skipped' && !/^Post /.test(s.name)).map((s) => s.name);
    const failedStepApi = (job.steps || []).find((s) => s.conclusion === 'failure');
    const h = n === 0 ? header.slice() : [];
    h.push(`JOB ${job.name} | failed step: ${failedStepApi ? failedStepApi.name : step ? step.command : 'unknown'}${runner ? ' | read as ' + runner : ''}`);
    const kind = runner === 'generic' && result.kind === 'TESTS' ? 'STEP' : result.kind;
    return { ...result, kind, header: h, notRun: skipped.length ? skipped : undefined };
  });
}

module.exports = { splitSteps, pickAdapter, digestJobLog, digestRun, ADAPTERS, tailOf };
