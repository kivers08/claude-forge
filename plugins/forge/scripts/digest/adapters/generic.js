'use strict';
// Fallback for runners without an adapter. Always low-confidence: exit code plus a few
// matching lines; never claims counts.

const { stripAnsi, oneLine, tailOf } = require('../common');

function parse(text, exitCode) {
  const clean = stripAnsi(text);
  if (exitCode === 0) {
    return { kind: 'TESTS', status: 'PASS', summary: 'exit code 0 (generic adapter: no counts available)', failures: [] };
  }
  const hits = clean.split('\n').filter((l) => /\b(fail(ed|ure)?|error|assert\w*)\b/i.test(l)).slice(0, 10);
  return {
    kind: 'TESTS',
    status: 'FAIL',
    summary: `exit code ${exitCode} (generic adapter: no counts available, low confidence)`,
    failures: hits.map((l) => ({ where: '(unknown)', name: null, error: oneLine(l) })),
    tail: tailOf(clean),
    notes: ['no adapter for this runner; matched lines may be incomplete'],
  };
}

module.exports = { parse };
