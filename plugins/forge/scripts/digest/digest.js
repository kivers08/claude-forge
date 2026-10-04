#!/usr/bin/env node
// Test/CI digest (package 1, D-T). Prints a short digest instead of full traces or logs.
//
//   digest.js test [--runner jest|eslint|prettier|generic] -- <command ...>
//   digest.js parse --runner <name> [--exit N] [file]      (reads stdin when no file)
//   digest.js ci <owner/repo> <run-id | branch>
//
// Exit code: 0 PASS, 1 FAIL, 2 COULD NOT PARSE or usage/environment error.
// Plain Node, no dependencies (forge D11).
'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const { render, couldNotParse, stripAnsi } = require('./common');
const { ADAPTERS, digestRun } = require('./ci');

function detectRunner(text) {
  const t = stripAnsi(text);
  if (/^Tests:\s/m.test(t) && /^Test Suites:\s/m.test(t)) return 'jest';
  if (/^\[warn\]\s/m.test(t) || /Checking formatting/.test(t)) return 'prettier';
  if (/✖ \d+ problems?/.test(t) || /^\s+\d+:\d+\s+(error|warning)\s/m.test(t)) return 'eslint';
  return 'generic';
}

function digestText(text, exitCode, runner) {
  const name = runner || detectRunner(text);
  if (!ADAPTERS[name]) return couldNotParse('TESTS', text, `unknown runner "${name}"`);
  return ADAPTERS[name].parse(text, exitCode);
}

function exitFor(results) {
  if (results.some((r) => r.status === 'COULD NOT PARSE')) return 2;
  return results.some((r) => r.status !== 'PASS') ? 1 : 0;
}

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (argv[i] === '--runner') flags.runner = argv[++i];
    else if (argv[i] === '--exit') flags.exit = Number(argv[++i]);
    else rest.push(argv[i]);
  }
  return { flags, rest };
}

function main(argv) {
  const [cmd, ...args] = argv;
  try {
    if (cmd === 'test') {
      const cut = args.indexOf('--');
      if (cut === -1 || cut === args.length - 1) throw new Error('usage: digest.js test [--runner X] -- <command ...>');
      const { flags } = parseFlags(args.slice(0, cut));
      const command = args.slice(cut + 1);
      const r = command.length === 1
        ? spawnSync(command[0], { shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
        : spawnSync(command[0], command.slice(1), { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      if (r.error) throw new Error(`could not run command: ${r.error.message}`);
      const result = digestText((r.stdout || '') + (r.stderr || ''), r.status === null ? 1 : r.status, flags.runner);
      process.stdout.write(render(result));
      return exitFor([result]);
    }
    if (cmd === 'parse') {
      const { flags, rest } = parseFlags(args);
      const text = fs.readFileSync(rest[0] || 0, 'utf8');
      const result = digestText(text, flags.exit, flags.runner);
      process.stdout.write(render(result));
      return exitFor([result]);
    }
    if (cmd === 'ci') {
      if (args.length !== 2) throw new Error('usage: digest.js ci <owner/repo> <run-id | branch>');
      const results = digestRun(args[0], args[1]);
      process.stdout.write(results.map(render).join(''));
      return exitFor(results);
    }
    throw new Error('usage: digest.js test|parse|ci ... (see header of this file)');
  } catch (e) {
    process.stderr.write(`digest: ${e.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { digestText, detectRunner, main };
