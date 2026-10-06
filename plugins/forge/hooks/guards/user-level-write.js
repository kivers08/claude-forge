'use strict';
// The user-level ~/.claude tree is the human's configuration, shared by every
// project on the machine. An agent editing it changes behaviour everywhere,
// invisibly and outside version control. Deny writes to it from Bash.
//
// The PROJECT's own .claude/ is fine — that is tracked, reviewable and scoped.
// Also used by pre-write.js for the Edit/Write tools, where the decision is
// made from tool_input.file_path instead of a command string.
const os = require('os');
const path = require('path');

const WRITE_VERBS = /\b(cp|mv|rm|tee|install|touch|mkdir|truncate|ln|dd|chmod|chown)\b/;
const INPLACE = /\b(sed|perl|awk)\b[^|;]*\s-i\b/;
// A redirect's TARGET (`> f`, `>> f`, `2> f`, `&> f`, `>| f`), read as a full
// shell word: quotes are removed and adjacent quoted/unquoted parts join, so
// `> "$HOME"/.claude/x` yields `$HOME/.claude/x`. A `>` inside quotes is text,
// not a redirect, and a descriptor dup (`2>&1`, `>&-`) has no file target,
// while `>& file` does.
// Only a target inside ~/.claude makes a redirect a user-level write:
// `cat ~/.claude/x 2>/dev/null` only reads (opusjevos D-BT).
function redirectTargets(seg) {
  const s = String(seg || '');
  const out = [];
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') i++;
      continue;
    }
    if (ch === '\\') { i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch !== '>') continue;
    let j = i + 1;
    if (s[j] === '>' || s[j] === '|') j++;
    // `>&N` / `>&-` duplicate a descriptor (no file); `>& file` writes a file.
    let dup = false;
    if (s[j] === '&') { j++; dup = true; }
    while (s[j] === ' ' || s[j] === '\t') j++;
    let word = '';
    let q = null;
    for (; j < s.length; j++) {
      const c = s[j];
      if (q) {
        if (c === q) { q = null; continue; }
        if (c === '\\' && q === '"' && j + 1 < s.length) { word += s[++j]; continue; }
        word += c;
        continue;
      }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '\\' && j + 1 < s.length) { word += s[++j]; continue; }
      if (/[\s;|&<>()]/.test(c)) break;
      word += c;
    }
    if (word && !(dup && /^(\d+-?|-)$/.test(word))) out.push(word);
    i = j - 1;
  }
  return out;
}

function homeClaudeDirs() {
  const home = os.homedir();
  const dirs = [];
  if (home) dirs.push(path.join(home, '.claude'));
  return dirs;
}

// True when `p` is inside the user-level ~/.claude tree.
function isUserLevel(p, projectDir) {
  const norm = String(p || '').replace(/\\/g, '/');
  if (/^~\/\.claude(\/|$)/.test(norm)) return true;
  if (/^\$(HOME|\{HOME\})\/\.claude(\/|$)/.test(norm)) return true;
  let abs = norm;
  if (!path.posix.isAbsolute(abs) && !/^[A-Za-z]:\//.test(abs)) {
    if (!projectDir) return false;
    abs = path.posix.join(String(projectDir).replace(/\\/g, '/'), abs);
  }
  for (const dir of homeClaudeDirs()) {
    const d = dir.replace(/\\/g, '/');
    if (abs === d || abs.startsWith(d + '/')) {
      // The project itself living under ~/.claude would be pathological; treat
      // a path inside the project directory as project-level regardless.
      const proj = String(projectDir || '').replace(/\\/g, '/');
      if (proj && (abs === proj || abs.startsWith(proj + '/'))) return false;
      return true;
    }
  }
  return false;
}

const REASON = 'forge user-level-write guard: ~/.claude is the human\'s machine-wide '
  + 'configuration — every project on this machine reads it, and it is not under '
  + 'version control, so a change here is invisible in review. Put the change in '
  + 'the PROJECT\'s .claude/ instead, or hand the exact edit to the human to apply. '
  + 'If a user-level change is genuinely intended, the human makes it.';

module.exports = {
  name: 'user-level-write',
  isUserLevel,
  redirectTargets,
  reason: REASON,
  check(ctx) {
    const seg = ctx.segment;
    if (!/\.claude/.test(seg)) return null;
    // Redirects are read from the WHOLE command: the segment splitter treats
    // the `&` of `>& file` as a separator, which would hide the target.
    const redirected = redirectTargets(ctx.command || seg).filter((p) => isUserLevel(p, ctx.projectDir));
    const verbWrite = WRITE_VERBS.test(ctx.segmentLower) || INPLACE.test(ctx.segmentLower);
    const targets = verbWrite ? ctx.paths.filter((p) => isUserLevel(p, ctx.projectDir)) : [];
    for (const r of redirected) if (!targets.includes(r)) targets.push(r);
    if (!targets.length) return null;
    return { deny: `${REASON} Blocked path(s): ${targets.join(', ')}.` };
  },
};
