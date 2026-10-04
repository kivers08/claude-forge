#!/usr/bin/env node
// Test double for `gh api`: answers from tests/fixtures/ci/ so no network is needed.
'use strict';
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'fixtures', 'ci');
const target = process.argv[3] || '';
const send = (f) => process.stdout.write(fs.readFileSync(path.join(dir, f), 'utf8'));
if (/\/runs\/111\/jobs$/.test(target)) send('jobs-fail.json');
else if (/\/runs\/111$/.test(target)) send('run-fail.json');
else if (/\/runs\/222$/.test(target)) send('run-pass.json');
else if (/\/runs\?branch=claude%2Ffeature/.test(target)) process.stdout.write(JSON.stringify({ workflow_runs: [JSON.parse(fs.readFileSync(path.join(dir, 'run-fail.json'), 'utf8'))] }));
else if (/\/jobs\/901\/logs$/.test(target)) send('job-fail.log');
else { process.stderr.write(`fake-gh: unexpected request ${target}\n`); process.exit(1); }
