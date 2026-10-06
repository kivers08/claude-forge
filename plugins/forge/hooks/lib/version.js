'use strict';
// Which forge is running, and is it the latest the marketplace has? (opusjevos
// D-W, D-BL, D-BT: a session must SAY which forge loaded, never assume it.)
//
//   version   this plugin's .claude-plugin/plugin.json
//   commit    the installed commit: Claude Code's installed_plugins.json entry
//             whose installPath is this plugin, else `git rev-parse HEAD` in a
//             development checkout
//   latest    HEAD of the local marketplace clone the setup script refreshed
//             (no network call here; the setup script did the fetch)
//
// The config dir is $CLAUDE_CONFIG_DIR, else ~/.claude. Read-only; every
// lookup fails soft to null. Node stdlib only (D11).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function gitHead(dir) {
  try {
    if (!fs.statSync(path.join(dir, '.git'))) return null;
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', timeout: 5000 });
    const sha = r.status === 0 ? r.stdout.trim() : '';
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch (e) {
    return null;
  }
}

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function samePath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch (e) {
    return path.resolve(String(a)) === path.resolve(String(b));
  }
}

// { version, commit, latest, marketplace, source }
function info(root) {
  const pluginRoot = root || PLUGIN_ROOT;
  const manifest = readJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json')) || {};
  const name = manifest.name || 'forge';
  const out = { name, version: manifest.version || null, commit: null, latest: null, marketplace: null, source: null };

  const installed = readJson(path.join(configDir(), 'plugins', 'installed_plugins.json'));
  const plugins = (installed && installed.plugins) || {};
  for (const key of Object.keys(plugins)) {
    if (!key.startsWith(`${name}@`)) continue;
    const entries = Array.isArray(plugins[key]) ? plugins[key] : [];
    const hit = entries.find((e) => e && e.installPath && samePath(e.installPath, pluginRoot));
    if (!hit) continue;
    out.commit = /^[0-9a-f]{7,40}$/.test(String(hit.gitCommitSha || '')) ? String(hit.gitCommitSha) : null;
    out.marketplace = key.slice(name.length + 1);
    out.source = 'installed';
    break;
  }
  if (!out.source) {
    const dev = gitHead(pluginRoot) || gitHead(path.resolve(pluginRoot, '..', '..'));
    if (dev) {
      out.commit = dev;
      out.source = 'checkout';
    }
  }
  if (out.marketplace) {
    out.latest = gitHead(path.join(configDir(), 'plugins', 'marketplaces', out.marketplace));
  }
  return out;
}

function short(sha) {
  return sha ? String(sha).slice(0, 7) : 'commit unknown';
}

// The lines the SessionStart hook prints. The first always starts
// "forge <version> (<commit>) loaded" so its absence is itself the alarm.
function lines(i) {
  const v = i || info();
  const out = [`${v.name} ${v.version || '?'} (${short(v.commit)}) loaded${v.source === 'checkout' ? ' from a development checkout' : ''}.`];
  if (v.commit && v.latest && !v.latest.startsWith(v.commit) && !v.commit.startsWith(v.latest)) {
    out.push(`forge WARNING: OUT OF DATE. The marketplace has ${short(v.latest)} but this session runs ${short(v.commit)}. `
      + 'Tell the human first, before anything else: "forge is out of date in this session"; '
      + 'the fix is the environment setup script (it reinstalls on a commit mismatch), then a new session.');
  } else if (v.source === 'installed' && !v.commit) {
    out.push('forge WARNING: the installed commit could not be read, so "up to date" is unconfirmed. Say so to the human.');
  }
  return out;
}

module.exports = { info, lines, configDir, PLUGIN_ROOT };
