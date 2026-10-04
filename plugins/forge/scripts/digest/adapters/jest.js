'use strict';
// Jest console-output adapter (Jest 30 verified against real output in tests/fixtures).
// Parses text, not --json, so the same code serves local runs and CI logs (D-AB).

const { stripAnsi, oneLine, couldNotParse } = require('../common');

function count(summaryLine, word) {
  const m = new RegExp(`(\\d+) ${word}`).exec(summaryLine);
  return m ? Number(m[1]) : 0;
}

function parseBlock(title, lines, suiteFile) {
  // First line that carries the error: prefer the Expected/Received pair, else first text line.
  const body = lines.map((l) => l.replace(/^ {4}/, ''));
  const expected = body.find((l) => /^Expected\b/.test(l));
  const received = body.find((l) => /^Received\b/.test(l));
  let error;
  if (expected && received) {
    error = `${expected.replace(/^Expected:?\s*/, 'Expected ')}, ${received
      .replace(/^Received:?\s*/, 'received ')}`;
  } else {
    error = body.find((l) => l.trim() && !/^\s*(>|\||\d+ \|)/.test(l)) || '(no message)';
  }
  // Location: first stack frame outside node_modules, else the suite file.
  let where = suiteFile || '(unknown file)';
  for (const l of body) {
    const m = /^\s*at .*?\(?([^\s()]+?):(\d+):\d+\)?\s*$/.exec(l);
    if (m && !m[1].includes('node_modules')) {
      where = `${m[1]}:${m[2]}`;
      break;
    }
  }
  const name = /^Test suite failed to run$/.test(title) ? null : title;
  return { where, name, error: oneLine(name === null ? `suite failed to run: ${error}` : error) };
}

function parse(text, exitCode) {
  const clean = stripAnsi(text);
  const lines = clean.split('\n');
  const testsLine = lines.find((l) => /^Tests:\s/.test(l));
  if (!testsLine) return couldNotParse('TESTS', clean, 'no Jest "Tests:" summary line found');
  const suitesLine = lines.find((l) => /^Test Suites:\s/.test(l)) || '';
  const timeLine = lines.find((l) => /^Time:\s/.test(l)) || '';

  const failed = count(testsLine, 'failed');
  const passed = count(testsLine, 'passed');
  const skipped = count(testsLine, 'skipped') + count(testsLine, 'todo');
  const suites = count(suitesLine, 'total');
  const suitesFailed = count(suitesLine, 'failed');

  const failures = [];
  let suiteFile = null;
  for (let i = 0; i < lines.length; i++) {
    const fm = /^(?:FAIL|PASS)\s+(\S+)/.exec(lines[i]);
    if (fm) {
      suiteFile = fm[1];
      continue;
    }
    const bm = /^ {2}● (.+)$/.exec(lines[i]);
    if (!bm || /^Console\b/.test(bm[1])) continue;
    let j = i + 1;
    const block = [];
    while (j < lines.length && !/^ {2}● /.test(lines[j]) && !/^(FAIL|PASS)\s/.test(lines[j]) &&
      !/^Test Suites:/.test(lines[j]) && !/^Summary of all failing tests/.test(lines[j])) {
      block.push(lines[j]);
      j++;
    }
    failures.push(parseBlock(bm[1].trim(), block, suiteFile));
    i = j - 1;
  }

  // Confidence rules: exit code wins; failure blocks must account for the summary count.
  if (exitCode !== undefined && exitCode !== null) {
    if (exitCode === 0 && (failed > 0 || suitesFailed > 0)) {
      return couldNotParse('TESTS', clean, 'exit code 0 but output reports failures');
    }
    if (exitCode !== 0 && failed === 0 && suitesFailed === 0) {
      return couldNotParse('TESTS', clean, `exit code ${exitCode} but output reports no failures`);
    }
  }
  const status = failed > 0 || suitesFailed > 0 ? 'FAIL' : 'PASS';
  const notes = [];
  if (status === 'FAIL' && failures.length === 0) {
    return couldNotParse('TESTS', clean, 'summary reports failures but no failure blocks were found');
  }
  if (status === 'FAIL' && failures.length < failed) {
    notes.push(`parsed ${failures.length} failure block(s) but summary reports ${failed} failed test(s)`);
  }
  const time = /Time:\s+(\S+ ?s)/.exec(timeLine);
  const summary = `${passed} passed, ${failed} failed, ${skipped} skipped` +
    ` (${suites} suites${suitesFailed ? `, ${suitesFailed} failed` : ''}${time ? ', ' + time[1] : ''})`;
  if (skipped > 0) notes.push('skipped test names are not in default Jest output; run with --verbose to list them');
  return { kind: 'TESTS', status, summary, failures, notes };
}

module.exports = { parse };
