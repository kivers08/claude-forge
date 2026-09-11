#!/usr/bin/env node
'use strict';
// Node-only validator for when the `claude` CLI is unavailable in CI.
// Checks: marketplace.json shape, every plugin.json shape, every agent and
// skill frontmatter, hooks.json shape (exec form only, Node only), and that
// every referenced hook script exists and passes `node --check`.
// Exit 1 on any error. No npm dependencies.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    err(`${rel(file)}: invalid JSON (${e.message})`);
    return null;
  }
}
function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}
function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// ---- frontmatter -----------------------------------------------------------
function parseFrontmatter(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.startsWith('---\n')) return { fm: null, body: text };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { fm: null, body: text };
  const raw = text.slice(4, end);
  const fm = {};
  let currentKey = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (m) {
      currentKey = m[1];
      const v = m[2].trim();
      fm[currentKey] = v === '' ? [] : v;
    } else if (/^\s+-\s+/.test(line) && currentKey && Array.isArray(fm[currentKey])) {
      fm[currentKey].push(line.replace(/^\s+-\s+/, '').trim());
    } else if (/^\s+\S/.test(line) && currentKey && typeof fm[currentKey] === 'string') {
      fm[currentKey] += ' ' + line.trim();
    } else {
      err(`${rel(file)}: cannot parse frontmatter line: ${JSON.stringify(line)}`);
    }
  }
  return { fm, body: text.slice(end + 4) };
}

const AGENT_KEYS = new Set([
  'name', 'description', 'model', 'tools', 'disallowedTools', 'memory', 'skills',
  'maxTurns', 'background', 'effort', 'isolation', 'color', 'initialPrompt',
]);
const AGENT_KEYS_NOT_IN_PLUGINS = new Set(['permissionMode', 'mcpServers', 'hooks']);
const SKILL_KEYS = new Set([
  'name', 'description', 'disable-model-invocation', 'user-invocable',
  'allowed-tools', 'disallowed-tools', 'context', 'agent', 'paths', 'arguments',
  'background', 'model', 'effort', 'shell', 'argument-hint', 'version', 'license',
  'metadata', 'compatibility',
]);

function checkAgent(file) {
  const { fm } = parseFrontmatter(file);
  if (!fm) return err(`${rel(file)}: agent has no frontmatter`);
  if (!fm.name) err(`${rel(file)}: agent missing name`);
  else if (!KEBAB.test(fm.name)) err(`${rel(file)}: agent name not kebab-case: ${fm.name}`);
  else if (fm.name !== path.basename(file, '.md')) warn(`${rel(file)}: agent name "${fm.name}" differs from file name`);
  if (!fm.description) err(`${rel(file)}: agent missing description`);
  if (fm.memory && !['user', 'project', 'local'].includes(fm.memory)) err(`${rel(file)}: memory must be user|project|local`);
  for (const k of Object.keys(fm)) {
    if (AGENT_KEYS_NOT_IN_PLUGINS.has(k)) err(`${rel(file)}: "${k}" is not supported in plugin agents`);
    else if (!AGENT_KEYS.has(k)) warn(`${rel(file)}: unrecognized agent frontmatter key "${k}"`);
  }
}

function checkSkill(file) {
  const { fm } = parseFrontmatter(file);
  const dir = path.basename(path.dirname(file));
  if (!fm) return err(`${rel(file)}: skill has no frontmatter`);
  if (fm.name && fm.name !== dir) err(`${rel(file)}: skill name "${fm.name}" must match directory "${dir}"`);
  if (!KEBAB.test(dir)) err(`${rel(file)}: skill directory not kebab-case`);
  if (!fm.description) err(`${rel(file)}: skill missing description`);
  for (const k of Object.keys(fm)) {
    if (!SKILL_KEYS.has(k)) warn(`${rel(file)}: unrecognized skill frontmatter key "${k}"`);
  }
}

// ---- hooks.json ------------------------------------------------------------
const HOOK_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied',
  'UserPromptSubmit', 'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop',
  'SessionStart', 'SessionEnd', 'PreCompact', 'PostCompact', 'WorktreeCreate', 'WorktreeRemove',
  'Setup', 'TeammateIdle', 'TaskCreated', 'TaskCompleted', 'ConfigChange', 'InstructionsLoaded',
  'FileChanged', 'CwdChanged', 'Elicitation', 'ElicitationResult',
]);

function checkHooks(pluginDir) {
  const file = path.join(pluginDir, 'hooks', 'hooks.json');
  if (!fs.existsSync(file)) return;
  const json = readJson(file);
  if (!json) return;
  if (!isObj(json.hooks)) return err(`${rel(file)}: top-level "hooks" object required`);
  for (const [event, matchers] of Object.entries(json.hooks)) {
    if (!HOOK_EVENTS.has(event)) warn(`${rel(file)}: unknown hook event "${event}"`);
    if (!Array.isArray(matchers)) { err(`${rel(file)}: hooks.${event} must be an array`); continue; }
    matchers.forEach((m, i) => {
      if (!isObj(m) || !Array.isArray(m.hooks)) return err(`${rel(file)}: hooks.${event}[${i}] needs a "hooks" array`);
      m.hooks.forEach((h, j) => {
        const where = `${rel(file)}: hooks.${event}[${i}].hooks[${j}]`;
        if (h.type !== 'command') return err(`${where}: type must be "command" (D11)`);
        if (h.command !== 'node') return err(`${where}: command must be "node" (D11), got ${JSON.stringify(h.command)}`);
        if (!Array.isArray(h.args) || h.args.length === 0) return err(`${where}: exec form requires a non-empty "args" array (D11)`);
        const script = h.args[0];
        if (!script.startsWith('${CLAUDE_PLUGIN_ROOT}/')) return err(`${where}: script must start with \${CLAUDE_PLUGIN_ROOT}/`);
        const local = path.join(pluginDir, script.slice('${CLAUDE_PLUGIN_ROOT}/'.length));
        if (!fs.existsSync(local)) return err(`${where}: script not found: ${rel(local)}`);
        if (!local.endsWith('.js')) return err(`${where}: hook script must be .js (D11)`);
      });
    });
  }
}

// ---- node --check over every .js -------------------------------------------
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
function nodeCheck(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) err(`${rel(file)}: node --check failed\n${r.stderr.trim()}`);
}

// ---- plugin ---------------------------------------------------------------
function checkPlugin(pluginDir) {
  const manifest = path.join(pluginDir, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifest)) return err(`${rel(pluginDir)}: missing .claude-plugin/plugin.json`);
  const json = readJson(manifest);
  if (!json) return;
  if (!json.name) err(`${rel(manifest)}: name required`);
  else if (!KEBAB.test(json.name)) err(`${rel(manifest)}: name must be kebab-case`);
  else if (json.name !== path.basename(pluginDir)) warn(`${rel(manifest)}: name "${json.name}" differs from directory name`);
  if (!json.version) warn(`${rel(manifest)}: no version`);
  if (!json.description) warn(`${rel(manifest)}: no description`);
  if (json.author !== undefined && !isObj(json.author)) err(`${rel(manifest)}: author must be an object`);

  for (const f of walk(path.join(pluginDir, 'agents'))) if (f.endsWith('.md')) checkAgent(f);
  for (const f of walk(path.join(pluginDir, 'skills'))) if (path.basename(f) === 'SKILL.md') checkSkill(f);
  checkHooks(pluginDir);
  for (const f of walk(pluginDir)) if (f.endsWith('.js')) nodeCheck(f);
  return json;
}

// ---- marketplace -----------------------------------------------------------
function checkMarketplace() {
  const file = path.join(ROOT, '.claude-plugin', 'marketplace.json');
  if (!fs.existsSync(file)) return err('missing .claude-plugin/marketplace.json');
  const json = readJson(file);
  if (!json) return;
  if (!json.name || !KEBAB.test(json.name)) err(`${rel(file)}: name required, kebab-case`);
  if (!isObj(json.owner) || !json.owner.name) err(`${rel(file)}: owner.name required`);
  if (!Array.isArray(json.plugins)) return err(`${rel(file)}: plugins must be an array`);
  const seen = new Set();
  for (const p of json.plugins) {
    if (!p.name) { err(`${rel(file)}: plugin entry missing name`); continue; }
    if (seen.has(p.name)) err(`${rel(file)}: duplicate plugin "${p.name}"`);
    seen.add(p.name);
    if (typeof p.source !== 'string' || !p.source.startsWith('./')) {
      err(`${rel(file)}: plugin "${p.name}" source must be a relative path starting with ./ (D2)`);
      continue;
    }
    const dir = path.join(ROOT, p.source);
    if (!fs.existsSync(dir)) { err(`${rel(file)}: plugin "${p.name}" source dir not found: ${p.source}`); continue; }
    const manifest = checkPlugin(dir);
    if (manifest && manifest.name !== p.name) err(`${rel(file)}: entry "${p.name}" but plugin.json says "${manifest.name}"`);
    if (manifest && p.version && manifest.version && p.version !== manifest.version) {
      err(`${rel(file)}: entry "${p.name}" version ${p.version} != plugin.json ${manifest.version}`);
    }
  }
}

// ---- settings ---------------------------------------------------------------
function checkSettings() {
  const file = path.join(ROOT, '.claude', 'settings.json');
  if (!fs.existsSync(file)) return warn('no .claude/settings.json');
  const json = readJson(file);
  if (!json) return;
  if (!isObj(json.enabledPlugins)) return err(`${rel(file)}: enabledPlugins object required`);
  const mk = readJson(path.join(ROOT, '.claude-plugin', 'marketplace.json')) || { plugins: [] };
  const names = new Set((mk.plugins || []).map((p) => p.name));
  for (const key of Object.keys(json.enabledPlugins)) {
    const [plugin, market] = key.split('@');
    if (market !== mk.name) err(`${rel(file)}: "${key}" does not reference marketplace "${mk.name}"`);
    if (!names.has(plugin)) err(`${rel(file)}: "${key}" names a plugin not in the marketplace`);
  }
}

// ---- schema -----------------------------------------------------------------
function checkSchema() {
  const file = path.join(ROOT, 'plugins', 'forge', 'schema', 'forge.schema.json');
  const json = readJson(file);
  if (!json) return;
  if (json.$schema !== 'https://json-schema.org/draft/2020-12/schema') err(`${rel(file)}: must be draft 2020-12`);
  // Every object node must set additionalProperties:false (or a typed additionalProperties) and describe every property.
  (function visit(node, p) {
    if (!isObj(node)) return;
    if (node.type === 'object') {
      if (node.additionalProperties === undefined || node.additionalProperties === true) err(`${rel(file)}: ${p} lacks additionalProperties`);
      if (node.description === undefined && p !== '#') err(`${rel(file)}: ${p} lacks description`);
      for (const [k, v] of Object.entries(node.properties || {})) {
        if (v.description === undefined) err(`${rel(file)}: ${p}/${k} lacks description`);
        visit(v, `${p}/${k}`);
      }
      if (isObj(node.additionalProperties)) visit(node.additionalProperties, `${p}/*`);
    }
    if (node.type === 'array' && isObj(node.items)) visit(node.items, `${p}[]`);
  })(json, '#');
}

checkMarketplace();
checkSettings();
checkSchema();
for (const f of walk(path.join(ROOT, 'scripts'))) if (f.endsWith('.js')) nodeCheck(f);

for (const w of warnings) console.log(`warn: ${w}`);
for (const e of errors) console.error(`error: ${e}`);
const strict = process.argv.includes('--strict');
if (errors.length || (strict && warnings.length)) {
  console.error(`\n${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log(`ok: ${warnings.length} warning(s), 0 errors`);
