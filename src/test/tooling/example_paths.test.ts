import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { repoRoot } from '../helpers';

/**
 * Squadron runs on other people's machines, and `src/` ships to the public
 * snapshot, so an example path names a placeholder account, never the one it
 * was observed under. A measurement keeps its date and figures; only whose
 * machine it was goes.
 */
const ROOT = repoRoot();

/**
 * Accounts the tree uses as examples — prefer `me` for a new one — and Grok's
 * sandbox, `/home/workdir`.
 */
const PLACEHOLDERS = new Set([
  'me',
  'x',
  'someone',
  'u',
  'reader',
  'maya',
  'Test Person',
  'workdir'
]);

/**
 * Build output, dependencies, linked checkouts and per-machine state; never
 * shipped. A linked worktree's `.git` is a file naming the main checkout.
 */
const SKIP = new Set([
  '.git',
  'node_modules',
  'out',
  'dist',
  'dist-releases',
  '.worktrees',
  '.claude',
  '.impeccable',
  '.stryker-tmp',
  'reports'
]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|mp3|mp4|wav|zip|vsix|pdf)$/i;

/**
 * Patterns that identify one maintainer's employer, private repos or tickets.
 * Kept in `scripts/local/`, which the public snapshot drops, so the list does
 * not publish what it guards; a checkout without it checks home paths only.
 */
const PRIVATE_NAMES = path.join(ROOT, 'scripts', 'local', 'private_names.txt');

/** An account segment: starts with a letter or digit, so `/Users/)` in a regex literal is not one. */
const ACCOUNT = String.raw`[A-Za-z0-9][^\\/\s'"\`<>{}$…*%]*`;

/**
 * Every spelling of a home the tree has carried, each capturing the account:
 * POSIX and JSON-escaped (`\/Users\/`, which also covers Git Bash's
 * `/c/Users/` and WSL's `/mnt/c/Users/`), `/home/` only where it starts a path
 * (`cwd/home/temp` in prose is not one), a drive path with one to four
 * backslashes, URL-encoded, and the CLIs' encoded project folders — `-home-`
 * only at a folder name's start, since `squadron-home-<tmp>` is not a home.
 */
const HOMES = [
  String.raw`\\?/Users\\?/(${ACCOUNT})`,
  String.raw`(?<![\w.])\\?/home\\?/(${ACCOUNT})`,
  String.raw`[A-Za-z]:\\{1,4}Users\\{1,4}(${ACCOUNT}(?: Person)?)`,
  String.raw`%2F(?:Users|home)%2F(${ACCOUNT})`,
  String.raw`-Users-([A-Za-z0-9._]+)-`,
  String.raw`(?<![\w-])-home-([A-Za-z0-9._]+)-`
].map((source) => new RegExp(source, 'g'));

/** macOS's per-account temp directory, `/var/folders/<2>/<hash>/T`; write `$TMPDIR`. */
const ACCOUNT_TMP = /\/var\/folders\/[\w+]{2}\/[\w+]{20,}/;

describe('example paths', () => {
  const files = textFiles(ROOT);

  it('name a placeholder account, never a real home', () => {
    const found: string[] = [];
    for (const file of files)
      eachLine(file, (line, at) => {
        for (const shape of HOMES)
          for (const match of line.matchAll(shape))
            if (!PLACEHOLDERS.has(match[1] ?? '')) found.push(`${at}: ${match[0]}`);
      });
    assert.deepEqual(found, []);
  });

  it('name no account temp directory', () => {
    const found: string[] = [];
    for (const file of files)
      eachLine(file, (line, at) => {
        const match = ACCOUNT_TMP.exec(line);
        if (match) found.push(`${at}: ${match[0]}`);
      });
    assert.deepEqual(found, []);
  });

  it('name no private repo, employer or ticket', () => {
    const names = privateNames();
    if (names.length === 0) return;
    const pattern = new RegExp(names.join('|'), 'i');
    const found: string[] = [];
    for (const file of files)
      if (file !== PRIVATE_NAMES)
        eachLine(file, (line, at) => {
          const match = pattern.exec(line);
          if (match) found.push(`${at}: ${match[0]}`);
        });
    assert.deepEqual(found, []);
  });
});

function textFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (SKIP.has(entry.name)) continue;
    if (entry.isDirectory()) out.push(...textFiles(full));
    else if (entry.isFile() && !BINARY.test(entry.name)) out.push(full);
  }
  return out;
}

function eachLine(file: string, visit: (line: string, at: string) => void): void {
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('\0')) return;
  const rel = path.relative(ROOT, file);
  text.split('\n').forEach((line, i) => visit(line, `${rel}:${i + 1}`));
}

/** One regular expression per line, matched case-insensitively; `#` at a line's start is a comment. */
function privateNames(): string[] {
  if (!fs.existsSync(PRIVATE_NAMES)) return [];
  return fs
    .readFileSync(PRIVATE_NAMES, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}
