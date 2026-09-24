'use strict';
// Quote-aware splitting of a Bash command string.
//
// Guards must judge each command separately: `echo hi && gh pr create` is a pr
// create, and `echo "a && b"` is not. A regex over the whole string gets both
// wrong, so every guard matches against SEGMENTS produced here.
//
// Scope, stated plainly: this is a lexer, not a shell. It tracks single quotes,
// double quotes, backticks, backslash escapes and $( ) nesting. It does NOT
// understand heredocs, process substitution, arithmetic expansion or aliases.
// A guard that matters must therefore fail CLOSED on ambiguity (deny) or be
// harmless when it misses (remind). Never treat a miss here as proof of safety.

const SEPARATORS = ['&&', '||', ';;', ';', '|', '\n'];

function split(command) {
  const src = String(command == null ? '' : command);
  const out = [];
  let buf = '';
  let quote = null; // "'" | '"' | '`'
  let depth = 0; // $( ) nesting
  let i = 0;

  const flush = () => {
    const s = buf.trim();
    if (s) out.push(s);
    buf = '';
  };

  while (i < src.length) {
    const c = src[i];

    if (quote === "'") {
      buf += c;
      if (c === "'") quote = null;
      i++;
      continue;
    }

    if (c === '\\' && quote !== "'") {
      buf += c + (src[i + 1] || '');
      i += 2;
      continue;
    }

    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      i++;
      continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      buf += c;
      i++;
      continue;
    }

    if (c === '$' && src[i + 1] === '(') {
      depth++;
      buf += '$(';
      i += 2;
      continue;
    }
    if (c === ')' && depth > 0) {
      depth--;
      buf += c;
      i++;
      continue;
    }

    if (depth === 0) {
      let matched = null;
      for (const sep of SEPARATORS) {
        if (src.startsWith(sep, i)) { matched = sep; break; }
      }
      if (matched) {
        flush();
        i += matched.length;
        continue;
      }
      // `&` alone backgrounds a command and also ends it.
      if (c === '&') {
        flush();
        i++;
        continue;
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

// A bare word: characters that carry no shell meaning unquoted, so quoting
// them was cosmetic. `"pr"`, `'merge'`, `me""rge` all reduce to a bare word
// identical to the unquoted form. Anything with whitespace or a shell
// metacharacter (`& | ; < > ( ) $ ' " * ? [ ] { } ~ # !` etc.) is NOT bare —
// there the quoting was load-bearing (`"gh pr merge"` is one argument, not a
// command). Identifier-ish punctuation (`. / : @ % + , = ^ -`) stays bare so a
// quoted PR number/URL/flag still reads as itself.
const BARE_WORD = /^[\w./:@%+,=^-]+$/;

// Split one segment into shell-ish words, with quotes removed. `quoted` marks a
// token whose meaning DEPENDS on quoting — a spaced/metachar blob like
// `echo "gh pr create"` (one argument), NOT a real command word that merely
// carried cosmetic quotes. Guards use this to tell `gh pr create` from
// `echo "gh pr create"`; getting it wrong reopens D27, where `gh "pr" merge`
// (identical to `gh pr merge` in bash) slipped past the merge gate because a
// single cosmetically-quoted word was treated as data.
function tokenize(segment) {
  const src = String(segment == null ? '' : segment);
  const out = [];
  let buf = '';
  let has = false;
  let quoted = false;
  let quote = null;
  let i = 0;

  const flush = () => {
    // A cosmetically-quoted bare word (`"pr"`) is the unquoted word; only a
    // token whose value carries whitespace or a metachar stays `quoted` (D27).
    if (has) out.push({ value: buf, quoted: quoted && !BARE_WORD.test(buf) });
    buf = '';
    has = false;
    quoted = false;
  };

  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === quote) { quote = null; i++; continue; }
      if (c === '\\' && quote === '"' && src[i + 1]) { buf += src[i + 1]; has = true; i += 2; continue; }
      buf += c; has = true; i++; continue;
    }
    if (c === '\\' && src[i + 1]) { buf += src[i + 1]; has = true; i += 2; continue; }
    if (c === "'" || c === '"') { quote = c; quoted = true; has = true; i++; continue; }
    if (/\s/.test(c)) { flush(); i++; continue; }
    buf += c; has = true; i++;
  }
  flush();
  return out;
}

const REDIRECTS = new Set(['>', '>>', '<', '<<', '2>', '2>>', '&>', '>&']);

// File-ish operands of a command, for the rules injector (D7) and the
// delegation guard. Deliberately loose: a false positive costs one extra rule
// injection, a false negative costs a missed rule.
function extractPaths(command) {
  const seen = new Set();
  const out = [];
  for (const segment of split(command)) {
    const tokens = tokenize(segment);
    for (let n = 0; n < tokens.length; n++) {
      let value = tokens[n].value;
      if (!value) continue;
      // Strip a redirection operator glued to the path (`>out.txt`).
      const red = /^(?:\d?>>?|<<?|&>|>&)(.+)$/.exec(value);
      if (red) value = red[1];
      if (REDIRECTS.has(value)) continue;
      if (value.startsWith('-')) continue; // a flag, or a flag's value
      if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) continue; // URL
      if (value.includes('=') && !value.includes('/')) continue; // VAR=value
      if (n === 0 && !value.includes('/') && !value.includes('.')) continue; // the command itself
      const looksLikePath = value.includes('/') || value.includes('\\')
        || /\.[A-Za-z0-9]{1,8}$/.test(value);
      if (!looksLikePath) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

// True when `words` appear consecutively as UNQUOTED tokens.
//
// The manifest regexes are a cheap prefilter over the raw segment, and a raw
// regex cannot tell `gh pr create` from `echo "gh pr create"`. Every guard that
// DENIES confirms its hit with this, so a command that merely mentions the
// pattern inside a string is not blocked.
function hasUnquotedSequence(tokens, words) {
  if (!Array.isArray(tokens) || !words.length) return false;
  for (let i = 0; i + words.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < words.length; j++) {
      const t = tokens[i + j];
      if (!t || t.quoted || t.value.toLowerCase() !== words[j].toLowerCase()) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

// `git commit`, `git -C dir commit`, `git --no-pager push`: the subcommand is
// the first unquoted token after `program` that is neither a flag nor a flag's
// value. Returns { sub, index } or null.
function subcommandAfter(tokens, program, flagsWithValue) {
  const withValue = new Set((flagsWithValue || []).map((f) => f.toLowerCase()));
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t || t.quoted || t.value.toLowerCase() !== program) continue;
    let j = i + 1;
    while (j < tokens.length) {
      const tok = tokens[j];
      if (tok.quoted) return null;
      const v = tok.value;
      if (v.startsWith('-')) {
        if (withValue.has(v.toLowerCase()) && !v.includes('=')) j += 2;
        else j += 1;
        continue;
      }
      return { sub: v, index: j };
    }
    return null;
  }
  return null;
}

module.exports = { split, tokenize, extractPaths, hasUnquotedSequence, subcommandAfter };
