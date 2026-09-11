#!/usr/bin/env node
'use strict';
// Hook unit runner. Each case in ./cases.json is:
//   { "name": "...", "script": "hooks/<name>.js", "payload": "payloads/<file>.json",
//     "env": { "CLAUDE_PLUGIN_ROOT": "...", "CLAUDE_PLUGIN_DATA": "..." } (optional),
//     "expect": { "exit": 0, "stdoutIncludes": "...", "stdoutJson": {...} } }
// The script is run as `node <script>` with the payload on stdin, exactly as
// Claude Code runs an exec-form hook. Payloads are recorded from real sessions
// and include Linux AND Windows-shaped cwd/paths.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// Usage: node run.js [--plugin <plugin dir>]   (defaults to the forge plugin)
const argi = process.argv.indexOf('--plugin');
const PLUGIN = argi === -1 ? path.resolve(__dirname, '..', '..') : path.resolve(process.argv[argi + 1]);
const TESTS = path.join(PLUGIN, 'hooks', 'tests');
const casesFile = path.join(TESTS, 'cases.json');
const cases = fs.existsSync(casesFile) ? JSON.parse(fs.readFileSync(casesFile, 'utf8')) : [];

let failed = 0;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hook-tests-'));

for (const c of cases) {
  const script = path.join(PLUGIN, c.script);
  const payload = fs.readFileSync(path.join(TESTS, c.payload), 'utf8');
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: PLUGIN,
    CLAUDE_PLUGIN_DATA: dataDir,
    ...(c.env || {}),
  };
  const r = spawnSync(process.execPath, [script], { input: payload, encoding: 'utf8', env });
  const problems = [];
  const exp = c.expect || {};
  if (exp.exit !== undefined && r.status !== exp.exit) problems.push(`exit ${r.status} != ${exp.exit}`);
  if (exp.stdoutIncludes && !r.stdout.includes(exp.stdoutIncludes)) problems.push(`stdout lacks ${JSON.stringify(exp.stdoutIncludes)}`);
  if (exp.stdoutEmpty && r.stdout.trim() !== '') problems.push(`stdout not empty: ${r.stdout.trim().slice(0, 200)}`);
  if (exp.stdoutJson) {
    try {
      const got = JSON.parse(r.stdout);
      const want = JSON.stringify(exp.stdoutJson);
      if (JSON.stringify(got) !== want) problems.push(`stdout JSON differs\n  got:  ${JSON.stringify(got)}\n  want: ${want}`);
    } catch (e) {
      problems.push(`stdout is not JSON: ${r.stdout.trim().slice(0, 200)}`);
    }
  }
  if (exp.fileExists) {
    const f = path.join(dataDir, exp.fileExists);
    if (!fs.existsSync(f)) problems.push(`expected file ${exp.fileExists} in CLAUDE_PLUGIN_DATA`);
  }
  if (problems.length) {
    failed++;
    console.error(`FAIL ${c.name}\n  ${problems.join('\n  ')}\n  stderr: ${r.stderr.trim().slice(0, 300)}`);
  } else {
    console.log(`ok   ${c.name}`);
  }
}

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
