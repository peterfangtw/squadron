'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Capture before a fixture changes TEMP: repeated homes must be siblings.
const base = fs.realpathSync(os.tmpdir());
const owned = new Set();

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function create(prefix = 'squadron-home-') {
  if (!/^[\w-]+$/.test(prefix)) throw new Error('fixture prefix must be a name');
  const home = fs.mkdtempSync(path.join(base, prefix));
  owned.add(home);
  environment(home);
  return home;
}

function environment(home) {
  if (!path.isAbsolute(home) || !inside(base, home) || fs.lstatSync(home).isSymbolicLink())
    throw new Error(`not a fixture directory: ${home}`);
  const realHome = fs.realpathSync(home);
  if (!inside(base, realHome)) throw new Error(`fixture home escaped: ${home}`);
  const tmp = path.join(home, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  if (fs.lstatSync(tmp).isSymbolicLink() || !inside(realHome, fs.realpathSync(tmp)))
    throw new Error(`fixture temp escaped: ${tmp}`);
  return { HOME: home, USERPROFILE: home, TMP: tmp, TEMP: tmp, TMPDIR: tmp };
}

const CLI_ROOTS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME'];

/**
 * An environment copy with no CLI root in it. Windows treats env names without
 * case and a copy does not, so one exact-case key would leave the reader's real
 * root in a child. Harmless on POSIX, where the other casings mean nothing.
 */
function withoutCliRoots(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !CLI_ROOTS.includes(key.toUpperCase()))
  );
}

function validate(home, target) {
  if (
    !owned.has(home) ||
    !path.isAbsolute(target) ||
    path.resolve(target) !== target ||
    !inside(home, target)
  )
    throw new Error(`refusing to remove ${target}: outside registered fixture ${home}`);
  // Check every component, including the root, before traversing a junction.
  let current = home;
  for (const part of ['', ...path.relative(home, target).split(path.sep)]) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error(`refusing to remove through fixture link: ${current}`);
      const real = fs.realpathSync(current);
      if (real !== home && !inside(home, real)) throw new Error(`fixture escaped: ${current}`);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
}

function remove(home) {
  if (!owned.has(home) || fs.lstatSync(home).isSymbolicLink() || fs.realpathSync(home) !== home)
    throw new Error(`refusing unowned fixture cleanup: ${home}`);
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  owned.delete(home);
}

module.exports = { create, environment, withoutCliRoots, validate, remove };
