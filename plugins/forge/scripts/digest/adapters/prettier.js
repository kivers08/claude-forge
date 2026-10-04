'use strict';
// `prettier --check` output: one "[warn] <file>" line per unformatted file.

const { stripAnsi, couldNotParse } = require('../common');

function parse(text, exitCode) {
  const clean = stripAnsi(text);
  const files = [];
  for (const l of clean.split('\n')) {
    const m = /^\[warn\]\s+(\S+)\s*$/.exec(l);
    if (m) files.push(m[1]);
  }
  if (exitCode === 0 && files.length === 0) return { kind: 'FORMAT', status: 'PASS', summary: 'all files formatted', failures: [] };
  if (files.length === 0) return couldNotParse('FORMAT', clean, 'no "[warn] <file>" lines found');
  return {
    kind: 'FORMAT',
    status: 'FAIL',
    summary: `${files.length} file(s) not formatted`,
    failures: files.map((f) => ({ where: f, name: null, error: 'not formatted (run prettier --write)' })),
  };
}

module.exports = { parse };
