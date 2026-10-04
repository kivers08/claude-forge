'use strict';
// Shared helpers and the digest output layout (D-AC). Plain Node, no dependencies.

const MAX_FAILURES = 10;
const MAX_ERROR_CHARS = 200;
const TAIL_LINES = 20;
const MAX_TAIL_LINE_CHARS = 200;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(s) {
  return String(s).replace(ANSI, '');
}

function oneLine(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > MAX_ERROR_CHARS ? t.slice(0, MAX_ERROR_CHARS - 3) + '...' : t;
}

function tailOf(text, n = TAIL_LINES) {
  const lines = stripAnsi(text).split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.slice(-n).map((l) => (l.length > MAX_TAIL_LINE_CHARS ? l.slice(0, MAX_TAIL_LINE_CHARS - 3) + '...' : l));
}

// result: { kind, status: PASS|FAIL|COULD NOT PARSE, summary, failures: [{where, name, error}],
//           skipped: [names] | note string, notRun: [strings], tail: [lines], header: [lines], notes: [strings] }
function render(result) {
  const out = [];
  for (const h of result.header || []) out.push(h);
  out.push(`${result.kind}: ${result.status}${result.summary ? ' | ' + result.summary : ''}`);
  const failures = result.failures || [];
  failures.slice(0, MAX_FAILURES).forEach((f, i) => {
    out.push(` ${i + 1}. ${f.where}`);
    out.push(`    ${f.name ? '"' + f.name + '" | ' : ''}${f.error}`);
  });
  if (failures.length > MAX_FAILURES) out.push(` +${failures.length - MAX_FAILURES} more`);
  if (Array.isArray(result.skipped) && result.skipped.length) {
    out.push(`SKIPPED (names): ${result.skipped.join('; ')}`);
  }
  for (const n of result.notes || []) out.push(`NOTE: ${n}`);
  if (result.notRun && result.notRun.length) out.push(`NOT RUN: ${result.notRun.join('; ')}`);
  if (result.status === 'COULD NOT PARSE') {
    out.push(`LAST ${(result.tail || []).length} LINES:`);
    for (const l of result.tail || []) out.push(`  ${l}`);
  }
  return out.join('\n') + '\n';
}

// Exit code always wins over parsed counts (plan section 6, risk 1): a mismatch is never
// reported as a pass or as "0 failures".
function couldNotParse(kind, text, why, extra = {}) {
  return {
    kind,
    status: 'COULD NOT PARSE',
    summary: why,
    failures: [],
    tail: tailOf(text),
    ...extra,
  };
}

// Pick an adapter from the output itself, never from a script name like `npm test`.
function detectRunner(text) {
  const t = stripAnsi(text);
  if (/^Tests:\s/m.test(t) && /^Test Suites:\s/m.test(t)) return 'jest';
  if (/^\[warn\]\s/m.test(t) || /Checking formatting/.test(t)) return 'prettier';
  if (/✖ \d+ problems?/.test(t) || /^\s+\d+:\d+\s+(error|warning)\s/m.test(t)) return 'eslint';
  return 'generic';
}

module.exports = { MAX_FAILURES, stripAnsi, oneLine, tailOf, render, couldNotParse, detectRunner };
