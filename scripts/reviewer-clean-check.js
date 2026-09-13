#!/usr/bin/env node
'use strict';
// D20/U3: "reviewer clean" commit status. Self-hosted runner only (the
// ci.yml job this runs in is gated the same way as the `validate` and
// `forge-validators` jobs) and pull_request events only. Dispatches the
// forge:reviewer agent headlessly (`claude -p`, fed its own
// agents/reviewer.md system prompt verbatim, same "full" mode the `review`
// skill defaults to) against the PR diff, then posts a commit status.
//
// Reuses the machine's own `claude` login (the owner's subscription auth,
// already present on the self-hosted runner) — this script never reads or
// requires ANTHROPIC_API_KEY or any other new secret. If `claude` isn't on
// PATH, isn't authenticated, or this isn't a self-hosted pull_request run,
// this posts a "success" status with a "skipped: <reason>" description
// rather than failing the build — the same graceful-degrade pattern as the
// "claude plugin validate --strict" step in ci.yml.
//
// Node builtins only (fs, path, https, child_process, url) — no npm deps,
// matching every other script in this repo.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CONTEXT = 'reviewer clean';
const DIFF_FILE = path.join(ROOT, '.reviewer-clean-diff.txt');
// Cap so the reviewer isn't handed an unusable wall of text. (It is NOT a
// spawnSync argv/maxBuffer guard: the diff goes to a file rather than through
// argv, and git's own output is captured under an explicit 64MB maxBuffer
// before this cap is applied.) Truncation is reported all the way out to the
// posted status — see computeAndWriteDiff's `truncated` return.
const DIFF_MAX_CHARS = 400 * 1000;
// Separate, much smaller cap for the --stat block: it is a file list, not
// content, and a few thousand chars covers any reviewable PR.
const STAT_MAX_CHARS = 8 * 1000;

function log(msg) {
  console.log(`reviewer clean: ${msg}`);
}

// Never rejects: a transient failure to POST the status (network blip, API
// hiccup) must not crash main() and turn an actual clean/failed review into
// a misreported process crash — every call site relies on this resolving.
function postStatus(state, description) {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.PR_HEAD_SHA;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !sha || !token) {
    log(`cannot post status (missing GITHUB_REPOSITORY/PR_HEAD_SHA/GITHUB_TOKEN) — would have posted ${state}: ${description}`);
    return Promise.resolve();
  }
  const body = JSON.stringify({
    state,
    description: description.slice(0, 140),
    context: CONTEXT,
  });
  const [owner, name] = repo.split('/');
  // Join onto GITHUB_API_URL's own path, not just its hostname — on GitHub
  // Enterprise that URL includes a `/api/v3` prefix the request must keep.
  const apiBase = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const apiUrl = new URL(`${apiBase}/repos/${owner}/${name}/statuses/${sha}`);
  // Carry the URL's own port and scheme, not just its hostname — a GitHub
  // Enterprise instance on a non-443 port or plain http would otherwise
  // silently get a request to the wrong endpoint (the GHE path-prefix fix
  // above only carried the path, not port/protocol).
  // http: is supported for a GHE instance that genuinely serves plain HTTP,
  // but only when explicitly opted into: transmitting `Authorization: Bearer
  // <GITHUB_TOKEN>` in cleartext should be a deliberate choice, not something
  // a mistyped GITHUB_API_URL does silently. Without the opt-in this refuses
  // rather than downgrading (postStatus never rejects, so the caller's own
  // exit path still runs).
  if (apiUrl.protocol === 'http:' && process.env.FORGE_ALLOW_INSECURE_API !== '1') {
    log('refusing to post the status token over plaintext http: — set FORGE_ALLOW_INSECURE_API=1 if this GHE instance really serves http');
    return Promise.resolve();
  }
  const transport = apiUrl.protocol === 'http:' ? http : https;
  const options = {
    hostname: apiUrl.hostname,
    port: apiUrl.port || undefined,
    path: apiUrl.pathname + apiUrl.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'forge-reviewer-clean-check',
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  };
  return new Promise((resolve) => {
    const fail = (e) => {
      log(`could not post status ${state}: ${e.message}`);
      resolve();
    };
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          log(`posted status ${state} (HTTP ${res.statusCode})`);
          resolve();
        } else {
          fail(new Error(`GitHub statuses API returned HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', fail);
    req.write(body);
    req.end();
  });
}

async function skip(reason) {
  log(`skipped (${reason})`);
  await postStatus('success', `skipped: ${reason}`);
  process.exit(0);
}

function hasClaude() {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

// Reads the reviewer agent's system prompt from the BASE ref, not the PR's
// own checked-out working tree. ROOT is the checked-out PR merge ref, so
// `plugins/forge/agents/reviewer.md` there is content the PR author
// controls — a PR that edits that file rewrites the system prompt of the
// very agent deciding whether the PR is clean (e.g. appending an
// instruction to always report zero findings). The same trust-boundary
// argument that motivated computing the diff in the trusted parent process
// applies here: every input to the reviewer child must come from a trusted
// ref, not the untrusted worktree. Returns null (not a thrown error) on
// failure so the caller can fail the build with a clear reason.
function readReviewerSystemPromptFromBase(base) {
  const r = spawnSync('git', ['show', `origin/${base}:plugins/forge/agents/reviewer.md`], { cwd: ROOT, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const text = r.stdout;
  const end = text.startsWith('---\n') ? text.indexOf('\n---', 4) : -1;
  return end === -1 ? text : text.slice(end + 4).trim();
}

// Parses the reviewer agent's required closing summary line, e.g.
// "2 bugs, 0 security issues, 1 convention violation, 3 suggestions."
function parseSummary(resultText) {
  // Global + last-match: the reviewer's own instructions require this as
  // the closing line, but its report body can legitimately contain earlier
  // text matching the same shape (an example, a quoted finding). Anchoring
  // on the last occurrence picks the actual closing summary instead of
  // whichever matches first.
  const re = /(\d+)\s+bugs?,\s*(\d+)\s+security\s+issues?,\s*(\d+)\s+convention\s+violations?,\s*(\d+)\s+suggestions?/gi;
  let m;
  let last = null;
  while ((m = re.exec(resultText || '')) !== null) last = m;
  if (!last) return null;
  return {
    bugs: Number(last[1]),
    security: Number(last[2]),
    convention: Number(last[3]),
    suggestions: Number(last[4]),
  };
}

// Resolves the base branch's current SHA on origin. Returns null (rather
// than throwing) on failure so the caller can post a clear `failure` status
// instead of crashing main() past every postStatus() call site. Same policy
// as resolveHeadSha: a git error is a fault, not a reason to skip — skip()
// is reserved for runner/auth availability (see D20).
function resolveBaseSha(base) {
  const r = spawnSync('git', ['rev-parse', `origin/${base}`], { cwd: ROOT, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return r.stdout.trim();
}

// The commit actually checked out, which on a pull_request event is the merge
// commit actions/checkout produces — never github.event.pull_request.head.sha.
// Guarded like resolveBaseSha: on a spawn failure `stdout` is null, and an
// unchecked .trim() there would throw past every postStatus call site and
// leave the required context unwritten for that SHA.
function resolveHeadSha() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const sha = r.stdout.trim();
  return sha || null;
}

// Instruction surfaces the reviewer child reads out of the checked-out
// (PR-controlled) tree, which no other defense here covers. Two ways a file
// lands in this category:
//
//   (a) the CLI loads it automatically — a CLAUDE.md is injected as project
//       memory (root, or in a subtree whose files get read; plus the
//       .local.md variant), and .claude/settings.json still applies under
//       --restricted (exactly why --settings disableAllHooks was needed;
//       --settings layers on top rather than replacing);
//   (b) the base-ref reviewer prompt itself directs the child to read it —
//       .claude/forge.json supplies `agents.reviewer.extraChecks` (free text
//       appended straight to the review checklist), `agents.reviewer.budget`
//       and `readDiscipline.*` (a budget of 1 neuters the review with no
//       prose at all); .claude/rules/*.md are cited as authoritative
//       conventions; and the configured taskFiles.lessons file is grepped
//       and quoted (resolved from the BASE ref's config — see below).
//
// A PR touching any of these is writing trusted-position instructions for
// the agent judging it, so fail closed and defer to a human. Deterministic
// path check, not a model judgment.
//
// plugins/forge/agents/reviewer.md is deliberately NOT listed: it is already
// read from the base ref by readReviewerSystemPromptFromBase(), so a PR
// editing it cannot influence its own review. Listing it would block every
// legitimate change to the reviewer agent for no added protection.
const SELF_REVIEW_FORBIDDEN_PATTERNS = [
  // AGENTS.md alongside CLAUDE.md: recent CLI versions load it as an
  // alternative memory file, so if the pinned runner CLI does, it carries the
  // same weight. The repo has none today, so listing it blocks nothing.
  /(^|\/)(CLAUDE(\.local)?|AGENTS)\.md$/,
  /^\.claude\/settings(\.local)?\.json$/,
  /^\.claude\/forge\.json$/,
  /^\.claude\/rules\//,
  // Project skills, subagents and slash commands are discovered from the
  // project directory and their name/description text is surfaced to the
  // model. It is plausible the CLI suppresses skill metadata when the Skill
  // and Task tools aren't granted (this child gets Read,Glob,Grep only), but
  // that is unverified against the pinned runner CLI — and the repo has none
  // of these today, so listing them blocks nothing and costs nothing.
  // plugins/forge/skills/ is deliberately NOT here: per .claude/settings.json
  // the forge plugin loads from the marketplace clone of this repo, not from
  // the PR worktree, so a PR editing it cannot reach its own review.
  /^\.claude\/(skills|agents|commands)\//,
  // Project hooks, registered by .claude/settings.json and executable. The
  // --settings disableAllHooks flag is what actually stops them firing inside
  // the child, but a PR can edit .claude/hooks/session-start.sh WITHOUT
  // touching settings.json, so that flag is the single point of failure. Note
  // this failure is not symmetric with the Stop-hook case that motivated the
  // flag: a Stop hook clobbering the report trips the ack gate and fails
  // loudly, but a SessionStart/UserPromptSubmit hook could inject "report zero
  // findings" while leaving the ack intact. Path-gating costs nothing — the
  // only edits to that directory are deliberate infrastructure changes that
  // warrant human review anyway.
  /^\.claude\/hooks\//,
];

// The lessons file's path is itself configurable, so resolve it from the base
// ref's config — never the PR's, or moving the key would sidestep the check.
//
// Absence and error are deliberately distinguished. Collapsing both to "no
// lessons path" would silently disable half this gate whenever git hiccups,
// which is the fail-open this whole check exists to avoid. Returns:
//   { path: string|null }  — config read cleanly (path null = key unset)
//   { error: string }      — config exists but could not be read or parsed
function lessonsPathFromBase(base) {
  const spec = `origin/${base}:.claude/forge.json`;
  // NOT `git cat-file -e`: for a path missing from the tree that exits 128
  // ("fatal: path ... does not exist in ..."), which is indistinguishable
  // from a genuine fault — the first cut of this function used it and failed
  // every run on this very repo, which has no .claude/forge.json. `ls-tree`
  // lists nothing and exits 0 when the path is absent. It also exits 0 on a
  // bad ref (writing to stderr), but resolveBaseSha() has already proved
  // origin/<base> resolves before this runs, and a non-empty stderr is
  // treated as a fault regardless.
  const probe = spawnSync('git', ['ls-tree', '--name-only', `origin/${base}`, '--', '.claude/forge.json'], {
    cwd: ROOT, encoding: 'utf8',
  });
  if (probe.error) return { error: `git ls-tree failed: ${probe.error.message}` };
  if (probe.status !== 0) return { error: `git ls-tree exited ${probe.status} for ${spec}` };
  if ((probe.stderr || '').trim()) return { error: `git ls-tree: ${probe.stderr.trim()}` };
  if (!probe.stdout.trim()) return { path: null }; // no config in the base ref

  const r = spawnSync('git', ['show', spec], { cwd: ROOT, encoding: 'utf8' });
  if (r.error) return { error: `git show failed: ${r.error.message}` };
  if (r.status !== 0) return { error: `git show exited ${r.status} for ${spec}` };
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    // A config that exists but won't parse is an error, not an absence: we
    // cannot know whether it sets taskFiles.lessons.
    return { error: `${spec} is not valid JSON: ${e.message}` };
  }
  const p = parsed?.taskFiles?.lessons;
  return { path: typeof p === 'string' && p.trim() ? p.trim().replace(/^\.\//, '') : null };
}

// Exported for tests: every pattern here is anchored, so the exact bytes git
// hands back decide whether the gate fires — see changedInstructionSurfaces.
function matchesInstructionSurface(p, lessonsPath) {
  return SELF_REVIEW_FORBIDDEN_PATTERNS.some((re) => re.test(p))
    || (typeof lessonsPath === 'string' && lessonsPath !== '' && p === lessonsPath);
}

function changedInstructionSurfaces(base) {
  // -z is load-bearing, not a style choice. git quotes paths by default
  // (core.quotePath), wrapping any path with a non-ASCII byte, a quote, a
  // backslash or a control character in double quotes with C-style escapes:
  //   ".claude/rules/caf\303\251.md"
  // Every pattern above is anchored, so a leading `"` defeats `^` and a
  // trailing `"` defeats `$` — a PR adding .claude/rules/<non-ascii>.md would
  // sail straight past a gate whose whole purpose is to fail closed. -z emits
  // raw NUL-separated paths, which also removes the newline-in-filename
  // ambiguity a split('\n') would have. --no-renames so a rule file moved out
  // of .claude/rules/ is reported as both paths, not just its destination.
  const r = spawnSync('git', [
    '-c', 'core.quotePath=false',
    'diff', '--name-only', '-z', '--no-renames', `origin/${base}...HEAD`,
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  const changed = r.stdout.split('\0').filter(Boolean);
  const lessons = lessonsPathFromBase(base);
  // Propagate a config-read fault as a gate fault, same as a failed git diff:
  // main() posts `failure` on null rather than running a half-applied gate.
  if (lessons.error) {
    log(`could not resolve the lessons path from the base ref: ${lessons.error}`);
    return null;
  }
  return changed.filter((p) => matchesInstructionSurface(p, lessons.path));
}

// Computes the PR diff on the trusted parent process (this script already
// has full git access and a fetch-depth: 0 checkout) and writes it to
// DIFF_FILE, inside ROOT so --add-dir ROOT already covers it for the
// reviewer child's Read tool. Also writes a random verification token into
// the file — see verifyDiffResolvedAck for why the prompt must never state
// this value. Returns { token, truncated } — the token so main() can verify
// it against the reviewer's ack line, and `truncated` so a verdict derived
// from a partial diff can never be posted as an unqualified clean review.
function computeAndWriteDiff(base, baseSha, headSha) {
  const range = `origin/${base}...HEAD`;
  const opts = { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  const stat = spawnSync('git', ['diff', range, '--stat'], opts);
  const body = spawnSync('git', ['diff', range], opts);
  if (stat.error || stat.status !== 0 || body.error || body.status !== 0) {
    throw new Error(`git diff ${range} failed: ${(stat.stderr || body.stderr || '').trim()}`);
  }
  let diffBody = body.stdout;
  let truncationNote = '';
  let bodyTruncated = false;
  let statTruncated = false;
  if (diffBody.length > DIFF_MAX_CHARS) {
    const full = diffBody.length;
    diffBody = diffBody.slice(0, DIFF_MAX_CHARS);
    truncationNote = `\n\n[TRUNCATED — ${DIFF_MAX_CHARS} of ${full} chars shown]\n`;
    bodyTruncated = true;
  }
  // The --stat block is capped too, and its truncation counts toward the same
  // flag: a PR touching thousands of files produces a stat wall of its own,
  // and a file list the reviewer never saw the end of is exactly as partial a
  // review as a body it never saw the end of.
  let statBlock = stat.stdout;
  if (statBlock.length > STAT_MAX_CHARS) {
    const full = statBlock.length;
    statBlock = `${statBlock.slice(0, STAT_MAX_CHARS)}\n[TRUNCATED — ${STAT_MAX_CHARS} of ${full} chars shown]\n`;
    statTruncated = true;
  }
  const token = crypto.randomBytes(8).toString('hex');
  const content = [
    `base: ${base} (${baseSha})`,
    `head: HEAD (${headSha})`,
    `verification-token: ${token}`,
    '',
    '--- git diff --stat ---',
    statBlock,
    '--- git diff (full body) ---',
    diffBody + truncationNote,
  ].join('\n');
  fs.writeFileSync(DIFF_FILE, content, 'utf8');
  // Returned separately, not as one collapsed label, because they mean
  // different things: losing the tail of the BODY means the reviewer never
  // saw part of the change set, while losing the tail of the --stat table
  // costs only a redundant summary — every changed file still appears in the
  // body under its own `diff --git` header. Only the former can invalidate a
  // verdict; see the gate in main().
  return { token, bodyTruncated, statTruncated };
}

// Fix 3 (defense in depth): the reviewer must explicitly acknowledge it read
// the exact diff this script computed. The SHA-only version of this check
// proved NOT to be adversarial evidence: the prompt itself states both SHAs
// verbatim (so it can tell the reviewer what to echo), so a model that never
// opens DIFF_FILE — or finds it missing — can still echo the example line
// perfectly. `expectedToken` comes from `computeAndWriteDiff` and is written
// ONLY into the diff file, never into the prompt text, so producing it
// requires having actually read that file. The SHA check is kept alongside
// it (tightened: a real minimum-length prefix, case-normalized) as a
// readable, loggable sanity check, but the token is what actually proves
// the file was read.
function verifyDiffResolvedAck(resultText, baseSha, headSha, expectedToken) {
  // Token accepts either case, like the SHAs: a reviewer that echoes it
  // uppercased has demonstrably read the file, and failing the regex would
  // report it as the far more confusing "missing acknowledgement line".
  // Global, and every match is considered: like parseSummary (which keeps the
  // LAST match for the same reason), a report body can legitimately restate
  // this shape — a quoted example earlier in the text must not shadow the
  // real ack line and fail the run with a bogus "SHA mismatch".
  // Punctuation around the fields is deliberately loose: a reviewer that
  // renders the line as `**diff-resolved:** <sha>..<sha> token=…` or wraps it
  // in backticks is still demonstrably quoting the file, and a strict regex
  // would fail a required check for a markdown-formatting reason while
  // reporting it as "missing the acknowledgement line". The token carries the
  // security weight, so loosening the surrounding punctuation costs nothing.
  // Token width derives from the real token rather than a second hardcoded
  // 16 — otherwise widening randomBytes() would silently break every ack.
  const hex = '[0-9a-fA-F]';
  const re = new RegExp(
    `diff-resolved:[\\s*\`_:]*(${hex}{7,40})\\s*\\.{2,3}\\s*(${hex}{7,40})[\\s*\`_]*token[\\s*\`_]*=[\\s*\`_]*(${hex}{${expectedToken.length}})`,
    'g',
  );
  const all = [...(resultText || '').matchAll(re)];
  if (all.length === 0) {
    return { ok: false, reason: 'reviewer output is missing the required "diff-resolved: <base>..<head> token=<token>" acknowledgement line' };
  }
  // Accept if any match validates; otherwise report against the first, which
  // is the one the prompt asked for (the very first line of the response).
  const valid = all.find((c) => (
    baseSha.startsWith(c[1].toLowerCase())
    && headSha.startsWith(c[2].toLowerCase())
    && c[3].toLowerCase() === expectedToken.toLowerCase()
  ));
  if (valid) return { ok: true };
  const [, foundBase, foundHead] = all[0];
  // One-directional: the reviewer may abbreviate a SHA, but the abbreviation
  // it supplies must be a genuine prefix of the real (lowercase) value — not
  // the other way around, which would let a single hex character pass.
  const matches = (expected, found) => expected.startsWith(found.toLowerCase());
  if (!matches(baseSha, foundBase)) {
    return { ok: false, reason: `diff-resolved base SHA mismatch (expected prefix of ${baseSha}, got ${foundBase})` };
  }
  if (!matches(headSha, foundHead)) {
    return { ok: false, reason: `diff-resolved head SHA mismatch (expected prefix of ${headSha}, got ${foundHead})` };
  }
  // No trailing `return { ok: true }`: the three guards above are the same
  // predicate as the `valid` search, so reaching here means all three passed
  // and `valid` would have returned already.
  return { ok: false, reason: 'diff-resolved verification token does not match — the reviewer did not demonstrably read the diff file' };
}

async function main() {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') {
    log('not a pull_request event, nothing to review');
    return;
  }
  // Case-insensitive: the CORP_RUNNER repo/org variable has been observed
  // set as "TRUE" (uppercase). GitHub Actions' own `vars.CORP_RUNNER ==
  // 'true'` expression (used for `runs-on` in ci.yml) is case-insensitive;
  // this must match that or it silently no-ops on a runner it's actually on.
  if ((process.env.CORP_RUNNER || '').toLowerCase() !== 'true') {
    return skip('self-hosted runner (CORP_RUNNER) not available on this run');
  }
  if (!hasClaude()) {
    return skip('claude CLI not on PATH');
  }

  const base = process.env.GITHUB_BASE_REF;
  if (!base) {
    return skip('GITHUB_BASE_REF not set (not a pull_request run)');
  }

  const baseSha = resolveBaseSha(base);
  if (!baseSha) {
    log(`could not resolve origin/${base} to a SHA`);
    await postStatus('failure', `reviewer clean: could not resolve origin/${base} to a SHA`);
    process.exit(1);
  }
  // Deliberately NOT PR_HEAD_SHA. On a pull_request event, actions/checkout
  // checks out the *merge* ref, so the tree we diff is a merge commit whose
  // SHA is never github.event.pull_request.head.sha. The diff file's label,
  // the prompt, and the diff-resolved ack must all name the commit actually
  // diffed, or the gate's claim ("the exact diff this script computed, by
  // SHA") is untrue and CI logs mislead when triaging a stale-diff report.
  // PR_HEAD_SHA stays reserved for postStatus(), which reads it directly —
  // GitHub's Status API keys on the real PR head, not the merge commit.
  const diffHeadSha = resolveHeadSha();
  if (!diffHeadSha) {
    log('could not resolve HEAD to a SHA');
    await postStatus('failure', 'reviewer clean: could not resolve HEAD to a SHA');
    process.exit(1);
  }

  const touchedInstructionSurfaces = changedInstructionSurfaces(base);
  if (touchedInstructionSurfaces === null) {
    log(`could not list files changed against origin/${base}`);
    await postStatus('failure', 'reviewer clean: could not list changed files');
    process.exit(1);
  }
  if (touchedInstructionSurfaces.length > 0) {
    const list = touchedInstructionSurfaces.join(', ');
    log(`PR modifies the reviewer child's own instruction surface (${list}) — refusing to self-review`);
    await postStatus('failure', `reviewer clean: PR modifies reviewer instruction surface (${list}); needs human review`);
    process.exit(1);
  }

  const systemPrompt = readReviewerSystemPromptFromBase(base);
  if (systemPrompt === null) {
    log(`could not read plugins/forge/agents/reviewer.md from origin/${base}`);
    await postStatus('failure', 'reviewer clean: could not read reviewer system prompt from base ref');
    process.exit(1);
  }
  // Diff computed here, in the trusted parent process (already has full git
  // access via the workflow's fetch-depth: 0 checkout), not by the reviewer
  // child — see the --tools/--restricted comment below for why.
  let diffFileWritten = false;
  let verificationToken;
  let bodyTruncated = false;
  let statTruncated = false;
  try {
    ({ token: verificationToken, bodyTruncated, statTruncated } = computeAndWriteDiff(base, baseSha, diffHeadSha));
    diffFileWritten = true;
  } catch (e) {
    log(`could not compute diff: ${e.message}`);
    await postStatus('failure', 'reviewer clean: could not compute diff');
    process.exit(1);
  }

  const prompt = [
    'Review this repository\'s current branch diff against its base branch',
    `"${base}" (base SHA ${baseSha}, head SHA ${diffHeadSha}), in "full" mode`,
    '(the review skill\'s default: correctness bugs, security issues,',
    'convention violations, test coverage gaps, simplification suggestions,',
    'in that priority order). The diff has already been computed for you —',
    `Read the file \`${DIFF_FILE}\` (it is within your allowed directory);`,
    'do not attempt to run any diff/git command yourself. That file states',
    'the exact base and head SHAs at its top, plus a line starting',
    '`verification-token:` — as the very first line of your response, output',
    'exactly `diff-resolved: <base-sha>..<head-sha> token=<the value from',
    'that verification-token line, verbatim>`, then your report. Follow your',
    'report format exactly, and end with the required one-line summary: "N',
    'bugs, N security issues, N convention violations, N suggestions." with a',
    'real count in every N, even when a category is zero.',
  ].join(' ');

  const args = [
    '-p', prompt,
    '--append-system-prompt', systemPrompt,
    // --restricted confines Read/Glob/Grep (and every other file tool) to
    // --add-dir's working directories and strips Bash/WebFetch/etc. unless
    // named in --tools. The diff is now precomputed by this trusted parent
    // process and handed to the reviewer as a file (see computeAndWriteDiff
    // above), so the reviewer child needs no command-execution surface at
    // all — --tools grants only Read/Glob/Grep, no Bash. (`--tools` only
    // accepts bare tool names per `claude --help`; scoped patterns like
    // `Bash(git diff:*)` are not valid tool names there, so a prior version
    // of this script that tried that granted no Bash access whatsoever —
    // avoiding the need for Bash here sidesteps that fragility entirely.)
    '--restricted', '--add-dir', ROOT,
    '--tools', 'Read,Glob,Grep',
    // --restricted does NOT strip MCP servers by itself (`claude --help`:
    // "...--strict-mcp-config to skip MCP servers too"). Without this flag
    // the reviewer child — fed untrusted PR diff content, on a persistent
    // self-hosted runner — would inherit the runner owner's full personal
    // MCP server configuration (live credentialed connectors), letting a
    // prompt injection in a malicious PR ride those credentials into
    // real-world side effects. `--mcp-config '{"mcpServers":{}}'` supplies
    // an explicit empty server set (a bare `{}` is rejected as invalid).
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    // Fix 4: --restricted still
    // honors managed/global settings and project-level hooks per `claude
    // --help` ("...managed settings and --settings still apply..."), so
    // this repo's own forge plugin Stop hook (stop-git-check.js) was firing
    // inside the reviewer child too, injecting a trailing "you have
    // uncommitted work" turn that overwrote the real report as the final
    // captured result. Disabling all hooks for this headless, read-only
    // child eliminates that trailing turn; it never has anything to
    // commit/push (--restricted + Read/Glob/Grep only) so no hook behavior
    // is actually needed here.
    '--settings', '{"disableAllHooks":true}',
    '--output-format', 'json',
  ];
  // Explicit minimal env: the reviewed diff is untrusted PR content, so the
  // child must not inherit GITHUB_TOKEN (this job's own repo-scoped
  // credential, only needed by this script's own postStatus() call) or
  // PR_HEAD_SHA/GITHUB_* run metadata it has no legitimate use for.
  // PATH/HOME (+ TMPDIR if set) are all `claude` itself needs to run and
  // find its own auth.
  const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  if (process.env.TMPDIR) childEnv.TMPDIR = process.env.TMPDIR;
  // Bounded: this runs on the single self-hosted runner (kewi-dev). An
  // unbounded hang here (network blip, a stuck permission wait, claude
  // itself wedging) would block every subsequent CI job on that runner,
  // not just this PR's check, for up to GitHub's 360-minute default cap.
  const TIMEOUT_MS = 10 * 60 * 1000;
  let result;
  try {
    result = spawnSync('claude', args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 32,
      env: childEnv,
      timeout: TIMEOUT_MS,
    });
  } finally {
    // Never leave the diff file lingering in the working tree, success or
    // failure.
    if (diffFileWritten) {
      try { fs.unlinkSync(DIFF_FILE); } catch (e) { /* already gone */ }
    }
  }

  // Check timeout/kill before the generic result.error case: Node's
  // spawnSync sets BOTH result.error (code ETIMEDOUT) AND result.signal
  // when the timeout fires, so checking result.error first would swallow
  // a hang as a benign "couldn't start" skip() — success — which is
  // exactly backwards from why TIMEOUT_MS exists.
  const timedOut = result.signal || (result.error && result.error.code === 'ETIMEDOUT');
  if (timedOut) {
    log(`claude timed out or was killed (signal=${result.signal || 'n/a'}, error=${result.error ? result.error.code : 'n/a'})`);
    await postStatus('failure', `reviewer timed out after ${TIMEOUT_MS / 1000}s`);
    process.exit(1);
  }
  if (result.error) {
    // ENOENT means the binary genuinely isn't there to run — a legitimate
    // skip. Anything else (e.g. E2BIG on a huge prompt, ENOBUFS past the 32
    // MiB output cap) means claude did start, so treating it as a skip
    // would post a false "success" for a review that never completed.
    if (result.error.code === 'ENOENT') {
      return skip(`claude invocation failed to start (${result.error.message})`);
    }
    log(`claude invocation errored (${result.error.code || 'unknown'}): ${result.error.message}`);
    await postStatus('failure', `reviewer invocation errored: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    if (/not logged in|authentication|please run `?claude login|not authenticated/i.test(stderr)) {
      return skip('claude CLI not authenticated');
    }
    log(`claude exited ${result.status}: ${stderr.slice(0, 2000)}`);
    await postStatus('failure', 'reviewer invocation failed — see CI logs');
    process.exit(1);
  }

  let resultText = result.stdout;
  try {
    const parsed = JSON.parse(result.stdout);
    resultText = parsed.result || parsed.output || result.stdout;
  } catch (e) {
    // --output-format json didn't parse (unexpected shape); fall back to
    // treating stdout as plain text and search it directly.
  }

  // Fix 3 gate: must run before, and independent of, parseSummary — if the
  // reviewer never acknowledges reading the exact diff this script
  // computed, fail closed regardless of what parseSummary would otherwise
  // find (a hallucinated "0 bugs, 0 security issues, ..." must not pass).
  const ack = verifyDiffResolvedAck(resultText, baseSha, diffHeadSha, verificationToken);
  if (!ack.ok) {
    log(`diff-resolved acknowledgement check failed: ${ack.reason}`);
    log(`full reviewer output follows:\n${resultText}`);
    await postStatus('failure', `reviewer clean: ${ack.reason}`);
    process.exit(1);
  }

  const summary = parseSummary(resultText);
  if (!summary) {
    log('could not find the reviewer\'s required summary line in its output');
    log(`full reviewer output follows:\n${resultText}`);
    await postStatus('failure', 'reviewer clean: could not parse reviewer summary');
    process.exit(1);
  }

  // Blocking = bugs + security issues + convention violations. Bare
  // suggestions (simplification/dead-code) do not block on their own, per
  // the reviewer agent's own framing of that category as "suggestions
  // only" (lowest of its four severities).
  // D20: the model's VERDICT is advisory; only deterministic faults block.
  //
  // Rationale, recorded because it is not obvious: the finding count is not
  // reproducible run-to-run. On this unit's own PR the count rose (1 bug/2
  // security -> 2 bugs/3 security) after every finding from the previous run
  // was fixed — the reviewer surfaces a different subset of a large candidate
  // set each time rather than converging monotonically. A required check that
  // cannot be driven to green by fixing what it reports is not a gate, it is
  // a coin flip with a merge button attached. So the findings inform (status
  // description, plus the full report in the job log) and the mechanics gate:
  // the ack/token check, diff truncation, git faults, an unreadable base-ref
  // system prompt, and a PR touching the reviewer's own instruction surface
  // are all reproducible, and all still fail the check above.
  let truncationSuffix = '';
  if (bodyTruncated && statTruncated) truncationSuffix = ' (diff and file list truncated — partial review)';
  else if (bodyTruncated) truncationSuffix = ` (diff truncated at ${DIFF_MAX_CHARS} chars — partial review)`;
  else if (statTruncated) truncationSuffix = ` (file list truncated at ${STAT_MAX_CHARS} chars — body diff complete)`;
  const counts = `${summary.bugs} bugs, ${summary.security} security, ${summary.convention} convention, ${summary.suggestions} suggestions`;
  const desc = `${counts}${truncationSuffix}`;
  const findings = summary.bugs + summary.security + summary.convention;

  // Only a truncated BODY blocks. A truncated --stat table is noted in the
  // description but is not a partial review: the body diff still contains
  // every changed file under its own `diff --git` header, so the reviewer saw
  // the whole change set and lost only a summary. Blocking on it would make a
  // routine ~100-file rename or lint sweep unmergeable under D26, with the
  // useless advice to split the PR.
  if (bodyTruncated) {
    // Deterministic, and it blocks: the reviewer never saw the tail of the
    // change set, so its verdict — clean or not — does not describe this PR.
    // Branch protection evaluates the status state, not its description, so
    // qualifying the text is not enough. Split the PR.
    log(`partial review: ${desc}`);
    log(`full reviewer report follows:\n${resultText}`);
    await postStatus('failure', desc);
    process.exit(1);
  }

  // Always log the full report, findings or not: it is the whole value of an
  // advisory check, and a green status must never be the only thing a
  // reviewer of this PR sees.
  log(`full reviewer report follows:\n${resultText}`);
  if (findings > 0) {
    log(`advisory findings (not blocking): ${desc}`);
  } else {
    log(`clean: ${desc}`);
  }
  await postStatus('success', desc);
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error(`reviewer clean: unexpected error: ${e.stack || e.message}`);
    // Post before exiting: once D26 makes this context required, an unposted
    // status is a permanently pending PR — the same failure mode the
    // resolveHeadSha guard exists to prevent, reached generically.
    await postStatus('failure', 'reviewer clean: unexpected error — see CI logs');
    process.exit(1);
  });
} else {
  // verifyDiffResolvedAck is exported alongside parseSummary as a test seam:
  // both are pure, and the ack gate is what decides whether a review counts.
  module.exports = { parseSummary, verifyDiffResolvedAck, matchesInstructionSurface };
}
