'use strict';
// ESLint "stylish" formatter output.

const { stripAnsi, oneLine, couldNotParse } = require('../common');

function parse(text, exitCode) {
  const clean = stripAnsi(text);
  const lines = clean.split('\n');
  const failures = [];
  let file = null;
  for (const l of lines) {
    if (/^\S.*\.[cm]?[jt]sx?$/.test(l.trim()) && !/^\s/.test(l)) {
      file = l.trim();
      continue;
    }
    const m = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)\s*$/.exec(l);
    if (m && file) failures.push({ where: `${file}:${m[1]}`, name: m[5], error: oneLine(`${m[3]}: ${m[4]}`) });
  }
  const sum = /✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/.exec(clean);
  if (exitCode === 0 && failures.length === 0) return { kind: 'LINT', status: 'PASS', summary: '0 problems', failures: [] };
  if (!sum && failures.length === 0) return couldNotParse('LINT', clean, 'no ESLint problem lines or summary found');
  const errors = sum ? Number(sum[2]) : failures.length;
  const warnings = sum ? Number(sum[3]) : 0;
  const status = errors > 0 || (exitCode !== undefined && exitCode !== 0) ? 'FAIL' : 'PASS';
  return { kind: 'LINT', status, summary: `${errors} errors, ${warnings} warnings`, failures };
}

module.exports = { parse };
