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
const REDIRECT = />>?/;
const INPLACE = /\b(sed|perl|awk)\b[^|;]*\s-i\b/;

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
  reason: REASON,
  check(ctx) {
    const seg = ctx.segment;
    if (!/\.claude/.test(seg)) return null;
    const writes = WRITE_VERBS.test(ctx.segmentLower) || REDIRECT.test(seg) || INPLACE.test(ctx.segmentLower);
    if (!writes) return null;
    const targets = ctx.paths.filter((p) => isUserLevel(p, ctx.projectDir));
    if (!targets.length) return null;
    return { deny: `${REASON} Blocked path(s): ${targets.join(', ')}.` };
  },
};
