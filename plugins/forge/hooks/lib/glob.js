'use strict';
// Minimal glob matcher. No npm dependencies (D11), so no minimatch.
//
// Supported: `*` (no `/`), `**` (any depth, including none), `?`, `{a,b,c}`,
// character classes `[abc]` and `[!abc]`. Matching is against repo-relative
// POSIX paths; `normalize` converts Windows-shaped separators first (D13).
// Not supported: extglob (`+(a|b)`), `!` negation at the head of a pattern.

function normalize(p) {
  let s = String(p == null ? '' : p).replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

function compile(glob) {
  const g = normalize(glob);
  let re = '';
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      const isDouble = g[i + 1] === '*';
      if (isDouble) {
        // `**/` matches zero or more path segments; a trailing/bare `**` matches the rest.
        if (g[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 3; continue; }
        re += '.*'; i += 2; continue;
      }
      re += '[^/]*'; i++; continue;
    }
    if (c === '?') { re += '[^/]'; i++; continue; }
    if (c === '{') {
      const end = g.indexOf('}', i);
      if (end === -1) { re += '\\{'; i++; continue; }
      const alts = g.slice(i + 1, end).split(',').map((a) => compileInner(a));
      re += `(?:${alts.join('|')})`;
      i = end + 1;
      continue;
    }
    if (c === '[') {
      const end = g.indexOf(']', i + 1);
      if (end === -1) { re += '\\['; i++; continue; }
      let body = g.slice(i + 1, end);
      if (body.startsWith('!')) body = '^' + body.slice(1);
      re += `[${body.replace(/\\/g, '\\\\')}]`;
      i = end + 1;
      continue;
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i++;
  }
  return new RegExp(`^${re}$`);
}

// Brace alternatives are literal-ish; reuse the same escaping without recursing
// into another brace group.
function compileInner(alt) {
  return alt
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
}

const cache = new Map();
function toRegExp(glob) {
  if (!cache.has(glob)) cache.set(glob, compile(glob));
  return cache.get(glob);
}

function match(filePath, glob) {
  const p = normalize(filePath);
  if (toRegExp(glob).test(p)) return true;
  // A directory-shaped pattern (`docs/`) matches everything under it.
  const g = normalize(glob);
  if (g.endsWith('/') && toRegExp(g + '**').test(p)) return true;
  // A bare directory name (`docs`) matches the directory itself, not its files;
  // callers that want recursion write `docs/**`.
  return false;
}

function matchAny(filePath, globs) {
  if (!Array.isArray(globs)) return false;
  return globs.some((g) => match(filePath, g));
}

// Which of `globs` matched — used by the rules injector to name the rule.
function firstMatch(filePath, globs) {
  if (!Array.isArray(globs)) return null;
  return globs.find((g) => match(filePath, g)) || null;
}

module.exports = { normalize, match, matchAny, firstMatch, toRegExp };
