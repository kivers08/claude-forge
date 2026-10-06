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
//     "permissionMode": "default",            optional: fills {{MODE}} (default "auto", where a merge ask never fires)
//     "spokenMarker": {"pr": 7},              optional: writes the spoken marker into the plugin data dir
//     "spokenMarkerMinutes": 1,               optional: its age (default 1)
//     "origin": "owner/repo",                 optional: origin of the fixture repo (default kivers08/claude-forge)
//     "nestedRepo": "owner/repo",             optional: fixture is a PARENT folder holding one git repo (origin owner/repo); markers go in the repo
//     "prompt": "merge",                      optional: fills {{PROMPT}} (UserPromptSubmit payloads)
//     "toolName"/"toolInput": ...             optional: fill {{TOOL_NAME}} / {{TOOL_INPUT}} (GitHub-tool payloads)
//     expect.dataFileAbsent / expect.fixtureFileAbsent: a file that must NOT exist (plugin data dir / fixture)
//     "forgeConfig": {"merge": {...}},        optional: written to .claude/forge.json in the fixture
//     "env": { ... },                         optional
//     "pluginsHome": "current" | "stale",     optional: a temp CLAUDE_CONFIG_DIR whose installed_plugins.json
//                                             lists this plugin at the marketplace clone's HEAD ("current")
//                                             or at another commit ("stale")
//     "expect": {
//       "exit": 0, "stdoutEmpty": true, "stdoutIncludes": "...",
//       "stdoutExcludes": "...", "stdoutJson": {...}, "fileExists": "smoke.log",
//       "fileIncludes": { "file": "telemetry.jsonl", "text": "..." },
//       "deny": true | false,
//       "maxContextBytes": 1700                additionalContext must be at most this many UTF-8 bytes
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
  const repo = c.nestedRepo ? path.join(dir, 'repo') : dir;
  if (c.nestedRepo) fs.mkdirSync(repo, { recursive: true });
  if (c.git) {
    git(repo, ['init', '-q', '-b', 'main']);
    // Every git fixture has an origin (default kivers08/claude-forge, the
    // slug the GitHub-tool payloads name) so repository binding is exercised.
    git(repo, ['remote', 'add', 'origin', `https://github.com/${c.nestedRepo || c.origin || 'kivers08/claude-forge'}.git`]);
    git(repo, ['config', 'user.email', 'test@example.invalid']);
    git(repo, ['config', 'user.name', 'forge tests']);
    fs.writeFileSync(path.join(repo, '.gitkeep'), '');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'initial']);
    if (c.branch) git(repo, ['checkout', '-q', '-b', c.branch]);
    if (c.mergeMarkerMinutes !== undefined) {
      const marker = path.join(repo, '.git', 'claude-human-merge-ok');
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

// A fake Claude config dir: plugins/installed_plugins.json naming this plugin,
// and plugins/marketplaces/claude-forge as a git repo (its HEAD = "latest").
function makePluginsHome(kind, n) {
  const home = path.join(tmpRoot, `config-${n}`);
  const market = path.join(home, 'plugins', 'marketplaces', 'claude-forge');
  fs.mkdirSync(market, { recursive: true });
  git(market, ['init', '-q', '-b', 'main']);
  git(market, ['config', 'user.email', 'test@example.invalid']);
  git(market, ['config', 'user.name', 'forge tests']);
  git(market, ['commit', '-q', '--allow-empty', '-m', 'latest']);
  const head = git(market, ['rev-parse', 'HEAD']).stdout.trim();
  const sha = kind === 'stale' ? '0123456789abcdef0123456789abcdef01234567' : head;
  fs.writeFileSync(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'forge@claude-forge': [{ scope: 'user', installPath: PLUGIN, version: '0.0.0', gitCommitSha: sha }] },
  }));
  return home;
}

let failed = 0;
let ran = 0;

cases.forEach((c, n) => {
  if (only && !c.name.includes(only)) return;
  ran++;
  const script = path.join(PLUGIN, c.script);
  const fixtureDir = (c.fixture || c.git) ? makeFixture(c, n) : null;
  if (fixtureDir && c.forgeConfig) {
    fs.mkdirSync(path.join(fixtureDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, '.claude', 'forge.json'), JSON.stringify(c.forgeConfig));
  }
  const spoken = path.join(dataDir, 'merge-ok.json');
  fs.rmSync(spoken, { force: true });
  if (c.spokenMarker) {
    fs.writeFileSync(spoken, JSON.stringify(c.spokenMarker));
    const when = new Date(Date.now() - (c.spokenMarkerMinutes === undefined ? 1 : c.spokenMarkerMinutes) * 60000);
    fs.utimesSync(spoken, when, when);
  }
  let payload = fs.readFileSync(path.join(TESTS, c.payload), 'utf8');
  if (fixtureDir) payload = payload.split('{{CWD}}').join(fixtureDir.replace(/\\/g, '\\\\'));
  if (c.command !== undefined) {
    const encoded = JSON.stringify(c.command).slice(1, -1);
    payload = payload.split('{{COMMAND}}').join(encoded);
  }
  payload = payload.split('{{PROMPT}}').join(JSON.stringify(String(c.prompt === undefined ? '' : c.prompt)).slice(1, -1));
  payload = payload.split('{{TOOL_NAME}}').join(c.toolName || '');
  payload = payload.split('{{TOOL_INPUT}}').join(JSON.stringify(c.toolInput || {}));
  payload = payload.split('{{MODE}}').join(c.permissionMode || 'auto');
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
    FORGE_GITHUB_HTTP: 'off', // no test reaches the network (lib/github-read.js)
    ...(c.env || {}),
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
  };
  delete env.CLAUDE_PROJECT_DIR; // payload cwd must be the only project source
  if (c.pluginsHome) env.CLAUDE_CONFIG_DIR = makePluginsHome(c.pluginsHome, n);
  else env.CLAUDE_CONFIG_DIR = path.join(tmpRoot, 'no-config-dir');

  const exp = c.expect || {};

  // dataDir is shared across every case (hooks append to the same
  // telemetry.jsonl etc.), so a fileIncludes check must only look at bytes
  // this case's run appended -- otherwise an assertion can pass because an
  // unrelated earlier or later case happened to write matching text to the
  // same file.
  const includesFile = exp.fileIncludes ? path.join(dataDir, exp.fileIncludes.file) : null;
  const offset = includesFile && fs.existsSync(includesFile) ? fs.statSync(includesFile).size : 0;

  const r = spawnSync(process.execPath, [script, dataDir], { input: payload, encoding: 'utf8', env });

  const problems = [];
  if (exp.exit !== undefined && r.status !== exp.exit) problems.push(`exit ${r.status} != ${exp.exit}`);
  if (exp.stdoutIncludes && !r.stdout.includes(exp.stdoutIncludes)) problems.push(`stdout lacks ${JSON.stringify(exp.stdoutIncludes)}`);
  if (exp.stdoutExcludes && r.stdout.includes(exp.stdoutExcludes)) problems.push(`stdout unexpectedly contains ${JSON.stringify(exp.stdoutExcludes)}`);
  if (exp.maxContextBytes !== undefined) {
    let ctxText = null;
    try {
      ctxText = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    } catch (e) {
      ctxText = null;
    }
    if (typeof ctxText !== 'string') problems.push('maxContextBytes: stdout is not hook JSON with additionalContext');
    else {
      const n = Buffer.byteLength(ctxText, 'utf8');
      if (n > exp.maxContextBytes) problems.push(`additionalContext is ${n} bytes, over ${exp.maxContextBytes}`);
    }
  }
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
  if (exp.dataFileAbsent && fs.existsSync(path.join(dataDir, exp.dataFileAbsent))) {
    problems.push(`file ${exp.dataFileAbsent} should not exist in CLAUDE_PLUGIN_DATA`);
  }
  if (exp.fixtureFileAbsent && fixtureDir) {
    const f = path.join(c.nestedRepo ? path.join(fixtureDir, 'repo') : fixtureDir, exp.fixtureFileAbsent);
    if (fs.existsSync(f)) problems.push(`fixture file ${exp.fixtureFileAbsent} should have been consumed`);
  }
  if (exp.fileExists && !fs.existsSync(path.join(dataDir, exp.fileExists))) {
    problems.push(`expected file ${exp.fileExists} in CLAUDE_PLUGIN_DATA`);
  }
  if (exp.fileIncludes) {
    const f = includesFile;
    const full = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    // Only the bytes appended by *this* case's run -- see offset comment above.
    const body = fs.existsSync(f) ? fs.readFileSync(f).slice(offset).toString('utf8') : '';
    if (!body.includes(exp.fileIncludes.text)) {
      problems.push(`expected ${exp.fileIncludes.file} to include ${JSON.stringify(exp.fileIncludes.text)} (in this case's appended output), got: ${body.trim().slice(-300) || '(nothing appended)'}; full file tail: ${full.trim().slice(-200)}`);
    }
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
