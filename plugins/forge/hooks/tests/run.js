#!/usr/bin/env node
'use strict';
// Hook unit runner. Each case in ./cases.json is:
//   {
//     "name": "...",
//     "script": "hooks/<name>.js",
//     "payload": "payloads/<file>.json",
//     "fixture": "fixtures/<dir>",            optional: copied to a temp dir
//     "git": true,                            optional: git init + initial commit
//     "mergeMarkerMinutes": 0,                optional: age of .git/claude-human-merge-ok
//     "branch": "feat/x",                     optional: branch to check out
//     "dirty": ["path"],                      optional: files to leave uncommitted
//     "command": "git push origin x",         optional: fills {{COMMAND}} in the payload
//     "filePath": "{{HOME}}/.claude/x",        optional: fills {{FILE_PATH}} in the payload
//     "env": { ... },                         optional
//     "expect": {
//       "exit": 0, "stdoutEmpty": true, "stdoutIncludes": "...",
//       "stdoutExcludes": "...", "stdoutJson": {...}, "fileExists": "smoke.log",
//       "deny": true | false
//     }
//   }
//
// The script runs as `node <script>` with the payload on stdin, exactly as
// Claude Code runs an exec-form hook. `{{CWD}}` anywhere in the payload is
// replaced with the fixture's temp path, so payloads stay portable; payloads
// that need no fixture carry literal Linux or Windows-shaped paths (D13).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const argi = process.argv.indexOf('--plugin');
const PLUGIN = argi === -1 ? path.resolve(__dirname, '..', '..') : path.resolve(process.argv[argi + 1]);
const TESTS = path.join(PLUGIN, 'hooks', 'tests');
const casesFile = path.join(TESTS, 'cases.json');
const cases = fs.existsSync(casesFile) ? JSON.parse(fs.readFileSync(casesFile, 'utf8')) : [];
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hook-tests-'));
const dataDir = path.join(tmpRoot, 'plugin-data');
fs.mkdirSync(dataDir, { recursive: true });

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
}

function makeFixture(c, n) {
  const dir = path.join(tmpRoot, `fixture-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  if (c.fixture) fs.cpSync(path.join(TESTS, c.fixture), dir, { recursive: true });
  if (c.git) {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.invalid']);
    git(dir, ['config', 'user.name', 'forge tests']);
    fs.writeFileSync(path.join(dir, '.gitkeep'), '');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'initial']);
    if (c.branch) git(dir, ['checkout', '-q', '-b', c.branch]);
    if (c.mergeMarkerMinutes !== undefined) {
      const marker = path.join(dir, '.git', 'claude-human-merge-ok');
      fs.writeFileSync(marker, '');
      const when = new Date(Date.now() - c.mergeMarkerMinutes * 60000);
      fs.utimesSync(marker, when, when);
    }
    for (const f of c.dirty || []) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.appendFileSync(path.join(dir, f), 'dirty\n');
    }
  }
  return dir;
}

let failed = 0;
let ran = 0;

cases.forEach((c, n) => {
  if (only && !c.name.includes(only)) return;
  ran++;
  const script = path.join(PLUGIN, c.script);
  const fixtureDir = (c.fixture || c.git) ? makeFixture(c, n) : null;
  let payload = fs.readFileSync(path.join(TESTS, c.payload), 'utf8');
  if (fixtureDir) payload = payload.split('{{CWD}}').join(fixtureDir.replace(/\\/g, '\\\\'));
  if (c.command !== undefined) {
    const encoded = JSON.stringify(c.command).slice(1, -1);
    payload = payload.split('{{COMMAND}}').join(encoded);
  }
  if (c.filePath !== undefined) {
    const encoded = JSON.stringify(String(c.filePath).split('{{HOME}}').join(os.homedir())).slice(1, -1);
    payload = payload.split('{{FILE_PATH}}').join(encoded);
  }

  // Fake `gh` on PATH (fixtures/bin/gh) resolves `gh pr view` for the
  // merge-gate tests without a real GitHub CLI or network access. It answers
  // "main" by default — same as git.baseBranch's own default — so every
  // pre-existing test (which never overrides FAKE_GH_BASE_REF) sees identical
  // behavior to when `gh` was simply absent from PATH.
  const fakeBin = path.join(TESTS, 'fixtures', 'bin');
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: PLUGIN,
    CLAUDE_PLUGIN_DATA: dataDir,
    ...(c.env || {}),
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
  };
  delete env.CLAUDE_PROJECT_DIR; // payload cwd must be the only project source
  const r = spawnSync(process.execPath, [script, dataDir], { input: payload, encoding: 'utf8', env });

  const problems = [];
  const exp = c.expect || {};
  if (exp.exit !== undefined && r.status !== exp.exit) problems.push(`exit ${r.status} != ${exp.exit}`);
  if (exp.stdoutIncludes && !r.stdout.includes(exp.stdoutIncludes)) problems.push(`stdout lacks ${JSON.stringify(exp.stdoutIncludes)}`);
  if (exp.stdoutExcludes && r.stdout.includes(exp.stdoutExcludes)) problems.push(`stdout unexpectedly contains ${JSON.stringify(exp.stdoutExcludes)}`);
  if (exp.stdoutEmpty && r.stdout.trim() !== '') problems.push(`stdout not empty: ${r.stdout.trim().slice(0, 300)}`);
  if (exp.deny !== undefined) {
    let decision = null;
    try {
      const got = JSON.parse(r.stdout || '{}');
      decision = (got.hookSpecificOutput && got.hookSpecificOutput.permissionDecision) || got.decision || null;
    } catch (e) {
      decision = null;
    }
    const denied = decision === 'deny' || decision === 'block';
    if (denied !== exp.deny) problems.push(`deny=${denied}, expected ${exp.deny}; stdout: ${r.stdout.trim().slice(0, 300)}`);
  }
  if (exp.stdoutJson) {
    try {
      const got = JSON.parse(r.stdout);
      const want = JSON.stringify(exp.stdoutJson);
      if (JSON.stringify(got) !== want) problems.push(`stdout JSON differs\n  got:  ${JSON.stringify(got)}\n  want: ${want}`);
    } catch (e) {
      problems.push(`stdout is not JSON: ${r.stdout.trim().slice(0, 200)}`);
    }
  }
  if (exp.fileExists && !fs.existsSync(path.join(dataDir, exp.fileExists))) {
    problems.push(`expected file ${exp.fileExists} in CLAUDE_PLUGIN_DATA`);
  }

  if (problems.length) {
    failed++;
    console.error(`FAIL ${c.name}\n  ${problems.join('\n  ')}\n  stderr: ${r.stderr.trim().slice(0, 400)}`);
  } else {
    console.log(`ok   ${c.name}`);
  }
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
