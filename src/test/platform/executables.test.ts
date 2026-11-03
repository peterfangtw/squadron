import * as assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, beforeEach, describe, it } from 'node:test';
import { executableEffects } from '../../core/platform';
import * as executables from '../../core/platform/executables';
import * as darwin from '../../core/platform/executables/darwin';
import * as win32 from '../../core/platform/executables/win32';
import { tempHome, testPlatform } from '../helpers';

const posix = darwin.executables(executableEffects);

let home: string;

before(async () => {
  home = await tempHome();
});

/** What a found program would be started as — the file and argv the
 *  capability hands the OS — read through the exec effect, never unwrapped. */
async function runs(program: executables.Program): Promise<string[]> {
  let started: string[] = [];
  const recorder = darwin.executables({
    ...executableEffects,
    execFile: (file, args) => {
      started = [file, ...args];
      return Promise.resolve({ stdout: '', stderr: '' });
    }
  });
  await recorder.exec(program, [], {});
  return started;
}

/** A search, with its program as what it would run. */
async function shown(search: executables.Search): Promise<unknown> {
  if (search.kind !== 'found') return search;
  return {
    kind: search.kind,
    path: search.path,
    source: search.source,
    runs: await runs(search.program)
  };
}

/** A brand's candidates under the test home, as `bin` states them. */
function candidates(name: string, installed: string, setting?: string): executables.Candidates {
  return { ...(setting ? { setting } : {}), installed: path.join(home, installed), name };
}
const CLAUDE = (setting?: string) =>
  candidates('claude', path.join('.local', 'bin', 'claude'), setting);

describe('posix search', () => {
  /** A file that runs, or one that only looks like it. */
  async function put(dir: string, name: string, mode = 0o755): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    await fs.writeFile(file, '#!/bin/sh\necho hi\n', { mode });
    await fs.chmod(file, mode);
    return file;
  }

  beforeEach(async () => {
    await fs.rm(path.join(home, '.local'), { recursive: true, force: true });
  });

  it('falls back to PATH, in the order PATH states', async () => {
    const first = path.join(home, 'a');
    const second = path.join(home, 'b');
    const wanted = await put(first, 'claude');
    await put(second, 'claude');
    const found = await posix.find(CLAUDE(), { PATH: [first, second].join(path.delimiter) });
    assert.deepEqual(await shown(found), {
      kind: 'found',
      path: wanted,
      source: 'path',
      runs: [wanted]
    });
  });

  it('ignores a directory named claude', async () => {
    const dirs = path.join(home, 'dir-case');
    await fs.mkdir(path.join(dirs, 'claude'), { recursive: true });
    const real = path.join(home, 'real');
    const wanted = await put(real, 'claude');
    const found = await posix.find(CLAUDE(), { PATH: [dirs, real].join(path.delimiter) });
    assert.equal(found.kind === 'found' && found.path, wanted);
  });

  it(
    'ignores a file with no execute bit',
    {
      skip:
        testPlatform() === 'win32' &&
        'win32: no execute bit; runnability is decided by extension — W2.3'
    },
    async () => {
      const unreadable = path.join(home, 'no-x');
      await put(unreadable, 'claude', 0o644);
      const real = path.join(home, 'real');
      const wanted = await put(real, 'claude');
      const found = await posix.find(CLAUDE(), {
        PATH: [unreadable, real].join(path.delimiter)
      });
      assert.equal(found.kind === 'found' && found.path, wanted);
    }
  );

  it('survives an empty or absent PATH', async () => {
    assert.equal((await posix.find(CLAUDE(), {})).kind, 'missing');
    assert.equal((await posix.find(CLAUDE(), { PATH: '' })).kind, 'missing');
    // An empty entry is `.` to a shell, and must not be here.
    assert.equal((await posix.find(CLAUDE(), { PATH: '::' })).kind, 'missing');
  });
});

/** npm 11.19's shim for a bin with a `node` shebang, as `npm install -g` wrote
 *  it (2026-10-21). */
const NPM_NODE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@probe\\fake-cli\\bin\\fake.js" %*',
  ''
].join('\r\n');

/** The same npm, for a bin that is itself an executable. */
const NPM_EXE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\@probe\\fake-cli\\bin\\fake.exe"   %*',
  ''
].join('\r\n');

/** The older cmd-shim, as Node 24.20 ships `corepack.cmd`. */
const LEGACY_SHIM = [
  '@SETLOCAL',
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\node_modules\\corepack\\dist\\corepack.js" %*',
  ') ELSE (',
  '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
  '  node  "%~dp0\\node_modules\\corepack\\dist\\corepack.js" %*',
  ')',
  ''
].join('\r\n');

const SCRIPT = 'node_modules\\@probe\\fake-cli\\bin\\fake.js';
const NATIVE = 'node_modules\\@probe\\fake-cli\\bin\\fake.exe';
const COREPACK = 'node_modules\\corepack\\dist\\corepack.js';

/** A shim-relative path under `dir`, the way the shim spells it. */
const under = (dir: string, relative: string): string => path.win32.join(dir, relative);

describe('parseShim', () => {
  it('reads npm 11’s node shim as a script and where its runtime is', () => {
    assert.deepEqual(win32.parseShim(NPM_NODE_SHIM), {
      target: SCRIPT,
      runtime: { beside: 'node.exe', name: 'node' }
    });
  });

  it('reads npm 11’s shim for an executable as that executable', () => {
    assert.deepEqual(win32.parseShim(NPM_EXE_SHIM), { target: NATIVE });
  });

  it('reads the older shape Node ships its own shims in', () => {
    assert.deepEqual(win32.parseShim(LEGACY_SHIM), {
      target: COREPACK,
      runtime: { beside: 'node.exe', name: 'node' }
    });
  });

  it('refuses what it cannot account for in full', () => {
    // A shebang's extra arguments sit between the target and `%*`.
    assert.equal(win32.parseShim('@node "%~dp0\\x.js" --flag %*'), undefined);
    assert.equal(win32.parseShim('node "%~dp0\\a.js" %*\r\nnode "%~dp0\\b.js" %*'), undefined);
    assert.equal(win32.parseShim('call %RUNNER% "%~dp0\\a.js" %*'), undefined);
    // Run directly on one line and through a runtime on another.
    assert.equal(win32.parseShim('"%~dp0\\a.js" %*\r\nnode "%~dp0\\a.js" %*'), undefined);
    assert.equal(win32.parseShim('@echo off\r\nwsl claude %*'), undefined);
  });

  it('refuses a wrapper that does more than launch', () => {
    // Followed, each would start the CLI without what the wrapper set up.
    const launch = '"%~dp0\\claude.exe" %*';
    assert.deepEqual(win32.parseShim(`@echo off\r\n${launch}`), { target: 'claude.exe' });
    assert.equal(
      win32.parseShim(`@echo off\r\nset ANTHROPIC_BASE_URL=http://x\r\n${launch}`),
      undefined
    );
    assert.equal(win32.parseShim(`@echo off\r\ncd /d C:\\work\r\n${launch}`), undefined);
    assert.equal(win32.parseShim(`${launch} > "%TEMP%\\log.txt"`), undefined);
    assert.equal(
      win32.parseShim(NPM_NODE_SHIM.replace('title %COMSPEC%', 'set NODE_OPTIONS=--inspect')),
      undefined
    );
  });
});

describe('win32 search', () => {
  const home = String.raw`C:\Users\Test Person`;
  let files: Map<string, string>;
  let probes: string[];
  let windows: executables.Executables;
  let serial = 0;

  beforeEach(() => {
    files = new Map();
    probes = [];
    windows = win32.executables({
      ...executableEffects,
      homedir: () => home,
      stat: (file) => {
        probes.push(file);
        const content = files.get(file.toLowerCase());
        if (content === undefined) return Promise.reject(new Error('ENOENT'));
        return Promise.resolve({ isFile: () => true, size: Buffer.byteLength(content) });
      },
      readText: (file) => {
        const content = files.get(file.toLowerCase());
        if (content === undefined) return Promise.reject(new Error('ENOENT'));
        return Promise.resolve(content);
      },
      access: () => Promise.reject(new Error('Windows does not use X_OK'))
    });
  });

  function file(dir: string, name: string, content = ''): string {
    const at = path.win32.join(dir, name);
    files.set(at.toLowerCase(), content);
    return at;
  }

  function directory(prefix: string): string {
    return prefix + serial++;
  }

  function prefix(shim: string, entry: string): string {
    const dir = directory(path.win32.join(home, 'npm-'));
    file(dir, 'claude.cmd', shim);
    file(dir, entry);
    return dir;
  }

  function choices(name: string, installed: string, setting?: string): executables.Candidates {
    return { ...(setting ? { setting } : {}), installed: path.win32.join(home, installed), name };
  }
  const claude = (setting?: string) => choices('claude', '.local\\bin\\claude', setting);

  it('finds the installer’s claude.exe through PATHEXT', async () => {
    const exe = file(path.win32.join(home, '.local', 'bin'), 'claude.exe');
    assert.deepEqual(await shown(await windows.find(claude(), {})), {
      kind: 'found',
      path: exe,
      source: 'home',
      runs: [exe]
    });
  });

  it('finds grok.exe under ~/.grok/bin', async () => {
    const exe = file(path.win32.join(home, '.grok', 'bin'), 'grok.exe');
    const grok = choices('grok', path.win32.join('.grok', 'bin', 'grok'));
    const found = await windows.find(grok, {});
    assert.deepEqual(found.kind === 'found' && [found.path, found.source], [exe, 'home']);
  });

  it('passes over a file whose extension win32 would not start', async () => {
    const bare = directory(path.win32.join(home, 'bare-'));
    file(bare, 'claude', '#!/bin/sh\n');
    file(bare, 'claude.ps1');
    const real = directory(path.win32.join(home, 'real-'));
    const exe = file(real, 'claude.exe');
    const found = await windows.find(claude(), { PATH: [bare, real].join(';') });
    assert.deepEqual(found.kind === 'found' && [found.path, found.source], [exe, 'path']);
  });

  it('reads PATH under any casing, and unquotes its entries', async () => {
    const dir = directory(path.win32.join(home, 'cased-'));
    const exe = file(dir, 'codex.exe');
    const codex = choices('codex', path.win32.join('.local', 'bin', 'codex'));
    const cased = await windows.find(codex, { Path: dir });
    assert.equal(cased.kind === 'found' && cased.path, exe);
    const quoted = await windows.find(codex, { PATH: `"${dir}"` });
    assert.equal(quoted.kind === 'found' && quoted.path, exe);
  });

  it('tries PATHEXT in order within a directory, before the next one', async () => {
    const first = directory(path.win32.join(home, 'first-'));
    const wanted = file(first, 'claude.com');
    file(first, 'claude.exe');
    const second = directory(path.win32.join(home, 'second-'));
    file(second, 'claude.com');
    const env = { PATH: [first, second].join(';'), PATHEXT: '.COM;.EXE' };
    const found = await windows.find(claude(), env);
    assert.equal(found.kind === 'found' && found.path, wanted);
  });

  it('runs an npm node shim’s script with the node beside it', async () => {
    const dir = prefix(NPM_NODE_SHIM, SCRIPT);
    const node = file(dir, 'node.exe');
    assert.deepEqual(await shown(await windows.find(claude(), { PATH: dir })), {
      kind: 'found',
      path: under(dir, SCRIPT),
      source: 'path',
      runs: [node, under(dir, SCRIPT)]
    });
  });

  it('runs it with the node on PATH when none is beside it', async () => {
    const dir = prefix(NPM_NODE_SHIM, SCRIPT);
    const runtime = directory(path.win32.join(home, 'nodejs-'));
    const node = file(runtime, 'node.exe');
    const env = { PATH: [dir, runtime].join(';') };
    const found = await windows.find(claude(), env);
    assert.deepEqual(found.kind === 'found' && (await runs(found.program)), [
      node,
      under(dir, SCRIPT)
    ]);
  });

  it('runs the executable a shim names directly, with no runner', async () => {
    const dir = prefix(NPM_EXE_SHIM, NATIVE);
    assert.deepEqual(await shown(await windows.find(claude(), { PATH: dir })), {
      kind: 'found',
      path: under(dir, NATIVE),
      source: 'path',
      runs: [under(dir, NATIVE)]
    });
  });

  it('follows the older shim shape too', async () => {
    const dir = prefix(LEGACY_SHIM, COREPACK);
    const node = file(dir, 'node.exe');
    const found = await windows.find(claude(), { PATH: dir });
    assert.deepEqual(found.kind === 'found' && (await runs(found.program)), [
      node,
      under(dir, COREPACK)
    ]);
  });

  it('refuses a shim whose runtime is nowhere, saying which', async () => {
    // `bin` adds the setting to fix (`bin.test.ts`).
    const dir = prefix(NPM_NODE_SHIM, SCRIPT);
    const found = await windows.find(claude(), { PATH: dir });
    assert.equal(found.kind, 'missing');
    assert.match((found.kind === 'missing' && found.refused) || '', /`node`/);
  });

  it('refuses a shim whose script is not there', async () => {
    const dir = directory(path.win32.join(home, 'gone-'));
    file(dir, 'claude.cmd', NPM_NODE_SHIM);
    file(dir, 'node.exe');
    const found = await windows.find(claude(), { PATH: dir });
    assert.match((found.kind === 'missing' && found.refused) || '', /not there/);
  });

  it('searches past a batch file it cannot follow', async () => {
    const odd = directory(path.win32.join(home, 'odd-'));
    file(odd, 'claude.cmd', '@echo off\r\nwsl claude %*\r\n');
    const real = directory(path.win32.join(home, 'real-'));
    const exe = file(real, 'claude.exe');
    const found = await windows.find(claude(), { PATH: [odd, real].join(';') });
    assert.equal(found.kind === 'found' && found.path, exe);
  });

  it('completes a setting with PATHEXT, and follows a shim it names', async () => {
    const dir = directory(path.win32.join(home, 'named-'));
    const exe = file(dir, 'claude.exe');
    const found = await windows.find(claude(path.win32.join(dir, 'claude')), {});
    assert.deepEqual(found.kind === 'found' && [found.path, found.source], [exe, 'setting']);

    const shimmed = prefix(NPM_NODE_SHIM, SCRIPT);
    const setting = path.win32.join(shimmed, 'claude.cmd');
    const named = await windows.find(claude(setting), {});
    assert.equal(named.kind, 'setting');
    assert.equal(named.kind === 'setting' && named.file, setting);
    assert.match((named.kind === 'setting' && named.refused) || '', /`node`/);
  });

  it('joins literal drive and UNC PATH entries with Windows syntax', async () => {
    files.set(String.raw`\\server\share space\tools\claude.exe`.toLowerCase(), '');
    const found = await windows.find(claude(), {
      pAtH: String.raw`;"D:\missing tools";;"\\server\share space\tools";`,
      pAtHeXt: '.EXE'
    });
    assert.deepEqual(await shown(found), {
      kind: 'found',
      path: String.raw`\\server\share space\tools\claude.exe`,
      source: 'path',
      runs: [String.raw`\\server\share space\tools\claude.exe`]
    });
    assert.deepEqual(probes, [
      String.raw`C:\Users\Test Person\.local\bin\claude.exe`,
      String.raw`D:\missing tools\claude.exe`,
      String.raw`\\server\share space\tools\claude.exe`
    ]);
  });

  it('filters and deduplicates PATHEXT before probing in declared order', async () => {
    const found = await windows.find(claude(), {
      PATH: String.raw`D:\bin`,
      PATHEXT: '.JS;.EXE;.exe;.PS1;.CMD;.BAT;.COM;.com;bad;.EXE/evil'
    });
    assert.equal(found.kind, 'missing');
    assert.deepEqual(probes, [
      String.raw`C:\Users\Test Person\.local\bin\claude.exe`,
      String.raw`C:\Users\Test Person\.local\bin\claude.cmd`,
      String.raw`C:\Users\Test Person\.local\bin\claude.bat`,
      String.raw`C:\Users\Test Person\.local\bin\claude.com`,
      String.raw`D:\bin\claude.exe`,
      String.raw`D:\bin\claude.cmd`,
      String.raw`D:\bin\claude.bat`,
      String.raw`D:\bin\claude.com`
    ]);
  });

  it('defaults only absent or empty PATHEXT and never adds cwd for an empty PATH entry', async () => {
    for (const PATHEXT of [undefined, '', ' ; "" ; ']) {
      probes.length = 0;
      assert.equal((await windows.find(claude(), { PATHEXT, PATH: ';;' })).kind, 'missing');
      assert.deepEqual(probes, [
        String.raw`C:\Users\Test Person\.local\bin\claude.com`,
        String.raw`C:\Users\Test Person\.local\bin\claude.exe`,
        String.raw`C:\Users\Test Person\.local\bin\claude.bat`,
        String.raw`C:\Users\Test Person\.local\bin\claude.cmd`
      ]);
    }
    probes.length = 0;
    assert.equal((await windows.find(claude(), { PATHEXT: '.JS;.PS1' })).kind, 'missing');
    assert.deepEqual(probes, []);
  });

  it('classifies explicit suffixes independently of PATHEXT without falling past a setting', async () => {
    files.set(String.raw`D:\tools\claude.exe`.toLowerCase(), '');
    files.set(String.raw`D:\tools\claude.ps1.exe`.toLowerCase(), '');
    files.set(String.raw`C:\Users\Test Person\.local\bin\claude.exe`.toLowerCase(), '');
    for (const setting of [String.raw`D:\tools\claude.EXE`, 'D:/tools/claude.EXE']) {
      probes.length = 0;
      assert.deepEqual(await shown(await windows.find(claude(setting), { PATHEXT: '.CMD' })), {
        kind: 'found',
        path: String.raw`D:\tools\claude.EXE`,
        source: 'setting',
        runs: [String.raw`D:\tools\claude.EXE`]
      });
      assert.deepEqual(probes, [String.raw`D:\tools\claude.EXE`]);
    }
    for (const setting of [String.raw`D:\tools\claude.ps1`, String.raw`D:\gone.exe`]) {
      probes.length = 0;
      assert.deepEqual(await windows.find(claude(setting), { PATH: String.raw`D:\tools` }), {
        kind: 'setting',
        file: setting
      });
      assert.ok(probes.every((file) => file === setting));
    }
  });

  it('keeps explicit installed and PATH-name suffixes when PATHEXT omits them', async () => {
    files.set(String.raw`D:\bin\claude.exe`.toLowerCase(), '');
    for (const candidates of [
      { installed: String.raw`D:\bin\claude.exe`, name: 'claude' },
      { installed: String.raw`D:\missing`, name: 'claude.exe' }
    ]) {
      const found = await windows.find(candidates, { PATH: String.raw`D:\bin`, PATHEXT: '.COM' });
      assert.equal(found.kind === 'found' && found.path, String.raw`D:\bin\claude.exe`);
    }
  });

  it('resolves an explicitly suffixed native shim runtime without chaining batch files', async () => {
    const shim = String.raw`C:\npm\claude.cmd`;
    const target = String.raw`C:\npm\entry.js`;
    files.set(shim.toLowerCase(), String.raw`node.exe "%~dp0\entry.js" %*`);
    files.set(target.toLowerCase(), '');
    files.set(String.raw`D:\runtime\node.exe`.toLowerCase(), '');
    const found = await windows.find(claude(shim), {
      PATH: String.raw`D:\runtime`,
      PATHEXT: '.COM'
    });
    assert.deepEqual(await shown(found), {
      kind: 'found',
      path: target,
      source: 'setting',
      runs: [String.raw`D:\runtime\node.exe`, target]
    });
    files.set(shim.toLowerCase(), String.raw`node "%~dp0\entry.js" %*`);
    files.delete(String.raw`D:\runtime\node.exe`.toLowerCase());
    files.set(String.raw`D:\runtime\node.cmd`.toLowerCase(), NPM_NODE_SHIM);
    const refused = await windows.find(claude(shim), { PATH: String.raw`D:\runtime` });
    assert.equal(refused.kind, 'setting');
    assert.match(refused.kind === 'setting' ? (refused.refused ?? '') : '', /`node`/);
  });

  it('refuses oversized and unaccounted shim text even when fallback binaries exist', async () => {
    files.set(String.raw`D:\other\claude.exe`.toLowerCase(), '');
    for (const text of ['x'.repeat(16 * 1024 + 1), '@echo off\r\nwsl claude %*']) {
      files.set(String.raw`C:\npm\claude.cmd`.toLowerCase(), text);
      const found = await windows.find(claude(String.raw`C:\npm\claude.cmd`), {
        PATH: String.raw`D:\other`
      });
      assert.equal(found.kind, 'setting');
      assert.match(found.kind === 'setting' ? (found.refused ?? '') : '', /cannot follow/);
    }
  });

  it('invokes a discovered shim Program with exact argv through exec and spawn', async () => {
    const dir = prefix(NPM_NODE_SHIM, SCRIPT);
    const node = file(dir, 'node.exe');
    const found = await windows.find(claude(), { PATH: dir });
    assert.equal(found.kind, 'found');
    if (found.kind !== 'found') return;
    const calls: unknown[] = [];
    const recorder = win32.executables({
      ...executableEffects,
      execFile: (file, args) => {
        calls.push([file, ...args]);
        return Promise.resolve({ stdout: '', stderr: '' });
      },
      spawn: (file, args) => {
        calls.push([file, ...args]);
        throw new Error('recorded');
      }
    });
    await recorder.exec(found.program, AWKWARD, {});
    recorder.spawn(found.program, AWKWARD, {});
    assert.deepEqual(calls, [
      [node, under(dir, SCRIPT), ...AWKWARD],
      [node, under(dir, SCRIPT), ...AWKWARD]
    ]);
  });

  it('expands a leading ~\\ in a setting', async () => {
    const exe = file(path.win32.join(home, 'tools'), 'claude.exe');
    const found = await windows.find(claude('~\\tools\\claude.exe'), {});
    assert.equal(found.kind === 'found' && found.path, exe);
  });
});

/** Arguments a shell would have mangled, as a CLI's launch line carries them. */
const AWKWARD = [
  'with space',
  `it's "quoted"`,
  '日本語 ✓',
  '{"settings":{"hooks":[1,"two"]}}',
  'line one\nline two',
  ''
];

/** Prints the arguments it was given after its own script, as JSON. */
const ECHO = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';

describe('starting a program', () => {
  let script: string;

  before(async () => {
    script = path.join(home, 'echo-argv.js');
    await fs.writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  });

  /** Everything a child wrote to stdout, once it has exited. */
  async function output(child: ChildProcess): Promise<unknown> {
    let text = '';
    child.stdout?.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0);
    return JSON.parse(text);
  }

  it('hands a program exactly the arguments it was given', async () => {
    const node = executables.named(process.execPath);
    const { stdout } = await posix.exec(node, ['-e', ECHO, ...AWKWARD], {});
    assert.deepEqual(JSON.parse(stdout), AWKWARD);

    const spawned = posix.spawn(node, ['-e', ECHO, ...AWKWARD], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.equal(spawned.status, 'ok');
    assert.deepEqual(spawned.status === 'ok' && (await output(spawned.value)), AWKWARD);
  });

  it('runs a script under its runner, the script first', async () => {
    const program = executables.named(script, process.execPath);
    const { stdout } = await posix.exec(program, AWKWARD, {});
    assert.deepEqual(JSON.parse(stdout), AWKWARD);

    const spawned = posix.spawn(program, AWKWARD, {});
    assert.equal(spawned.status, 'ok');
    if (spawned.status !== 'ok') return;
    spawned.value.stdin.end();
    assert.deepEqual(await output(spawned.value), AWKWARD);
  });

  it('answers with the pid of the child it started', async () => {
    // Under a runner that child is the runtime; nothing here claims a
    // grandchild the runtime may start.
    const program = executables.named(process.execPath);
    const spawned = posix.spawn(program, ['-e', 'process.stdout.write(String(process.pid))'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.equal(spawned.status, 'ok');
    if (spawned.status !== 'ok') return;
    assert.equal(await output(spawned.value), spawned.value.pid);
  });

  it('answers a spawn that throws as a refusal, and an exec as a rejection', async () => {
    // A NUL throws synchronously on every platform, standing in for win32's
    // EINVAL on a `.cmd`.
    const broken = executables.named('claude\0');
    const spawned = posix.spawn(broken, [], {});
    assert.equal(spawned.status, 'failed');
    assert.match(spawned.status === 'failed' ? spawned.reason : '', /null bytes/);
    await assert.rejects(posix.exec(broken, [], {}), /null bytes/);
  });

  it('rejects a failed exec with its exit and both streams', async () => {
    const node = executables.named(process.execPath);
    const code = 'process.stdout.write("out");process.stderr.write("err");process.exit(3)';
    await assert.rejects(posix.exec(node, ['-e', code], {}), {
      code: 3,
      stdout: 'out',
      stderr: 'err'
    });
  });

  it('hides the console window of every CLI child, keeping the caller’s options', async () => {
    // Without `windowsHide` every child of a GUI host flashes a console on win32.
    const seen: unknown[] = [];
    const recorder = win32.executables({
      ...executableEffects,
      spawn: (_file, _args, options) => {
        seen.push(options);
        throw new Error('recorded');
      },
      execFile: (_file, _args, options) => {
        seen.push(options);
        return Promise.resolve({ stdout: '', stderr: '' });
      }
    });
    const program = executables.named('claude');
    recorder.spawn(program, [], { cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
    await recorder.exec(program, [], { cwd: home, timeout: 5 });
    assert.deepEqual(seen, [
      { cwd: home, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      { cwd: home, timeout: 5, encoding: 'utf8', windowsHide: true }
    ]);
  });
});
