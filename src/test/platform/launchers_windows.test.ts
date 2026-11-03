import * as assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import * as win32 from '../../core/platform/launchers/win32';
import * as platform from '../../core/platform';
import * as helpers from '../helpers';

const run = promisify(execFile);

function disk(): {
  effects: win32.Effects;
  files: Map<string, string>;
  replaced: string[];
  modes: [string, number][];
} {
  const files = new Map([['source.js', '#!/usr/bin/env node\noriginal bundle\n']]);
  const replaced: string[] = [];
  const modes: [string, number][] = [];
  return {
    files,
    replaced,
    modes,
    effects: {
      runtime: "C:\\IDE's 中文 & tools\\Code.exe",
      environment: {},
      readFile: (file) => {
        const text = files.get(file);
        if (text === undefined)
          return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        return Promise.resolve(text);
      },
      lstat: (file) => {
        if (!files.has(file))
          return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        return Promise.resolve({ isFile: () => true });
      },
      report: () => {},
      mkdir: async () => {},
      copyFile: (source, destination) => {
        const text = files.get(source);
        if (text === undefined) return Promise.reject(new Error('ENOENT'));
        files.set(destination, text);
        return Promise.resolve();
      },
      writeFile: (file, text) => {
        files.set(file, text);
        return Promise.resolve();
      },
      chmod: (file, mode) => {
        modes.push([file, mode]);
        return Promise.resolve();
      },
      replace: (source, destination) => {
        assert.ok(files.has(source));
        files.set(destination, files.get(source) ?? '');
        files.delete(source);
        replaced.push(destination);
        return Promise.resolve();
      },
      remove: (file) => {
        files.delete(file);
        return Promise.resolve();
      }
    }
  };
}

describe('Windows Git Bash launchers', () => {
  it('publishes a bounded helper locator as location data and preserves it after failed replacement', async () => {
    const fixture = disk();
    const backend = win32.launchers(fixture.effects);
    const bin = 'C:\\tools\\bin',
      extension = 'C:\\extensions\\squadron-1.0.0';
    await backend.installHelperLocator(bin, extension);
    const destination = path.win32.join(bin, '.scripts', 'private-files-v1.locator.json');
    const before = fixture.files.get(destination);
    assert.ok(before);
    assert.deepEqual(JSON.parse(before), { schema: 1, protocol: 1, extensionRoot: extension });
    await win32
      .launchers({ ...fixture.effects, replace: () => Promise.reject(new Error('locked')) })
      .installHelperLocator(bin, 'C:\\extensions\\squadron-1.0.1');
    assert.equal(fixture.files.get(destination), before);
  });
  it('publishes the unchanged JS payload before a quoted D1 wrapper and refreshes both', async () => {
    const { effects, files, replaced, modes } = disk();
    const bin = "C:\\user's 中文\\bin";
    const installed = path.win32.join(bin, 'squadron-step');
    const script = path.win32.join(bin, '.scripts', 'squadron-step.js');
    assert.equal(win32.launchers(effects).scriptPath(bin, 'squadron-step'), script);
    files.set(installed, 'old extensionless JavaScript');
    await win32.launchers(effects).install(bin, 'squadron-step', 'source.js');
    assert.equal(files.get(script), files.get('source.js'));
    assert.equal(
      files.get(installed),
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 MSYS_NO_PATHCONV=1 exec 'C:/IDE'\\''s 中文 & tools/Code.exe' 'C:/user'\\''s 中文/bin/.scripts/squadron-step.js' "$@"\n`
    );
    assert.deepEqual(replaced, [script, installed]);
    assert.equal(modes.length, 1);
    assert.ok(modes[0]?.[0].startsWith(`${installed}.`));
    assert.equal(modes[0]?.[1], 0o755);
    files.set('source.js', 'new bundle');
    await win32
      .launchers({ ...effects, runtime: 'D:\\new IDE\\Code.exe' })
      .install(bin, 'squadron-step', 'source.js');
    assert.equal(files.get(script), 'new bundle');
    assert.ok(files.get(installed)?.includes("'D:/new IDE/Code.exe'"));
    assert.deepEqual(
      [...files.keys()].sort(),
      [installed, `${installed}.cmd`, script, 'source.js'].sort()
    );
  });

  it('publishes an ASCII CRLF cmd launcher after the sh wrapper, on the same payload', async () => {
    const { effects, files, replaced, modes } = disk();
    const bin = 'C:\\Users\\用户 & 100%\\.squadron\\bin';
    const installed = path.win32.join(bin, 'squadron-step');
    const script = path.win32.join(bin, '.scripts', 'squadron-step.js');
    const launch = (runtime: string, environment: Record<string, string | undefined> = {}) =>
      win32
        .launchers({ ...effects, runtime, environment })
        .install(bin, 'squadron-step', 'source.js');
    await launch("C:\\Program Files\\100% IDE's ^&!\\Code.exe");
    assert.deepEqual(replaced, [script, installed, `${installed}.cmd`]);
    assert.equal(
      files.get(`${installed}.cmd`),
      '@echo off\r\n' +
        'rem Squadron launcher, rewritten on each activation.\r\n' +
        'setlocal EnableExtensions DisableDelayedExpansion\r\n' +
        'set "ELECTRON_RUN_AS_NODE=1"\r\n' +
        `"C:\\Program Files\\100%% IDE's ^&!\\Code.exe" "%~dp0.scripts\\squadron-step.js" %*\r\n`
    );
    // Only the sh wrapper asks for a mode; cmd needs none.
    assert.equal(modes.length, 1);
    assert.ok(!modes[0]?.[0].startsWith(`${installed}.cmd`));
    // cmd reads batch text in the console code page: a non-ASCII runtime is
    // named through the variable cmd expands, matched case-insensitively.
    await launch('C:\\Users\\用户\\AppData\\Local\\Programs\\IDE 50%\\Code.exe', {
      localappdata: 'C:\\Users\\用户\\AppData\\Local\\'
    });
    assert.ok(
      files
        .get(`${installed}.cmd`)
        ?.includes('"%LOCALAPPDATA%\\Programs\\IDE 50%%\\Code.exe" "%~dp0'),
      files.get(`${installed}.cmd`)
    );
    assert.match(files.get(`${installed}.cmd`) ?? '', /^[\x20-\x7e\r\n]*$/);
    // No ASCII spelling: the previous cmd launcher stays, the sh wrapper refreshes.
    const before = files.get(`${installed}.cmd`);
    await launch('D:\\工具\\Code.exe', { LOCALAPPDATA: 'C:\\Users\\用户\\AppData\\Local' });
    assert.equal(files.get(`${installed}.cmd`), before);
    assert.ok(files.get(installed)?.includes("'D:/工具/Code.exe'"));
    assert.ok([...files.keys()].every((file) => !file.endsWith('.tmp')));
  });

  it('a missing bundle or failed publication leaves the existing wrapper and siblings intact', async () => {
    const failures = [
      'missing',
      'mkdir',
      'writeFile',
      'chmod',
      'payload',
      'wrapper',
      'cmd'
    ] as const;
    for (const fail of failures) {
      const fixture = disk();
      const files = fixture.files;
      const effects: win32.Effects = { ...fixture.effects, runtime: 'C:\\IDE\\Code.exe' };
      const installed = 'C:\\bin\\squadron-step';
      const script = 'C:\\bin\\.scripts\\squadron-step.js';
      files.set(installed, 'old wrapper');
      const oldCmd = 'rem Squadron launcher, rewritten on each activation.\r\nold cmd';
      files.set(`${installed}.cmd`, oldCmd);
      files.set('C:\\bin\\sibling', 'sibling');
      const replace = effects.replace.bind(effects);
      if (fail === 'mkdir' || fail === 'writeFile' || fail === 'chmod') {
        effects[fail] = () => Promise.reject(new Error('EACCES'));
      }
      const refused = { payload: script, cmd: `${installed}.cmd` }[fail as string] ?? installed;
      effects.replace = (source, destination) =>
        destination === refused ? Promise.reject(new Error('EBUSY')) : replace(source, destination);
      await win32
        .launchers(effects)
        .install('C:\\bin', 'squadron-step', fail === 'missing' ? 'absent.js' : 'source.js');
      // Each wrapper is its own publication: one refused keeps its old bytes
      // and does not stop the other, and nothing launches a payload never published.
      const kept = ['missing', 'mkdir', 'payload', 'writeFile'].includes(fail);
      assert.equal(files.get(installed) === 'old wrapper', kept || fail !== 'cmd', fail);
      assert.equal(files.get(`${installed}.cmd`) === oldCmd, kept || fail === 'cmd', fail);
      if (!kept)
        assert.ok(
          files.get(fail === 'cmd' ? installed : `${installed}.cmd`)?.includes('Code.exe'),
          fail
        );
      assert.equal(files.get('C:\\bin\\sibling'), 'sibling', fail);
      assert.ok(
        [...files.keys()].every((file) => !file.endsWith('.tmp')),
        fail
      );
    }
  });

  it('refuses unreadable, linked and unrecognized cmd destinations without blocking siblings', async () => {
    for (const refusal of ['metadata', 'read', 'link', 'marker-substring'] as const) {
      const { effects, files, replaced } = disk();
      const bin = 'C:\\bin';
      const destination = path.win32.join(bin, 'probe.cmd');
      const before = 'custom rem Squadron launcher, rewritten on each activation.\r\n';
      files.set(destination, before);
      const reports: string[] = [];
      effects.report = (message) => reports.push(message);
      if (refusal === 'metadata')
        effects.lstat = () =>
          Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
      if (refusal === 'read')
        effects.readFile = () =>
          Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      if (refusal === 'link') effects.lstat = () => Promise.resolve({ isFile: () => false });
      await win32
        .launchers({ ...effects, runtime: 'C:\\IDE\\Code.exe' })
        .install(bin, 'probe', 'source.js');
      assert.equal(files.get(destination), before, refusal);
      assert.deepEqual(
        replaced,
        [path.win32.join(bin, '.scripts', 'probe.js'), path.win32.join(bin, 'probe')],
        refusal
      );
      assert.equal(reports.length, 1, refusal);
      assert.ok(reports[0]?.includes(destination), refusal);
      assert.ok(
        [...files.keys()].every((file) => !file.endsWith('.tmp')),
        refusal
      );
    }
  });

  it(
    'preserves foreign cmd files locally and upgrades marked launchers on the actual backend',
    { skip: helpers.testPlatform() !== 'win32' && 'posix: native Windows publication' },
    async (t) => {
      const home = await helpers.tempHome();
      t.after(() => helpers.disposeHome(home));
      const bin = path.join(home, 'bin');
      const source = path.join(home, 'source.js');
      const launcher = path.join(bin, 'probe.cmd');
      const warnings: unknown[][] = [];
      t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
      await fs.mkdir(bin);
      const foreign = '@echo foreign-user-launcher\r\n';
      await fs.writeFile(launcher, foreign);
      await fs.writeFile(source, 'original payload');
      await platform.launchers.install(bin, 'probe', source);
      assert.equal(await fs.readFile(launcher, 'utf8'), foreign);
      assert.equal(warnings.length, 1);
      assert.ok(warnings.flat().join(' ').includes(launcher));
      assert.equal(
        await fs.readFile(path.join(bin, '.scripts', 'probe.js'), 'utf8'),
        'original payload'
      );
      assert.match(await fs.readFile(path.join(bin, 'probe'), 'utf8'), /^#!\/bin\/sh\n/);
      // A marker is the refresh contract, including local edits to generated launchers.
      await fs.writeFile(
        launcher,
        '@echo off\r\nrem Squadron launcher, rewritten on each activation.\r\nold edited runtime\r\n'
      );
      await fs.writeFile(source, 'upgraded payload');
      await platform.launchers.install(bin, 'probe', source);
      const upgraded = await fs.readFile(launcher, 'utf8');
      assert.ok(upgraded.includes(process.execPath.replaceAll('%', '%%')));
      assert.ok(!upgraded.includes('old edited runtime'));
      assert.equal(warnings.length, 1);
      await fs.rm(launcher);
      await fs.mkdir(launcher);
      await platform.launchers.install(bin, 'probe', source);
      assert.ok((await fs.lstat(launcher)).isDirectory());
      assert.equal(warnings.length, 2);
      assert.ok((await fs.readdir(bin)).every((name) => !name.endsWith('.tmp')));
    }
  );

  it(
    'keeps explicit and PATH cmd lookup from executing the JavaScript payload',
    { skip: helpers.testPlatform() !== 'win32' && 'posix: native cmd PATHEXT lookup' },
    async (t) => {
      const home = await helpers.tempHome();
      t.after(() => helpers.disposeHome(home));
      const root = path.join(home, 'cmd-negative');
      await fs.mkdir(root);
      const marker = path.join(root, 'executed.txt');
      const source = path.join(root, 'source.js');
      // Valid, silent JScript if explicitly hosted; never send a Node payload
      // to Windows' GUI script association, even when this control regresses.
      await fs.writeFile(
        source,
        `new ActiveXObject("Scripting.FileSystemObject").CreateTextFile(${JSON.stringify(marker)}, true).Close();`
      );
      const bin = path.join(root, 'bin space');
      const name = 'launcher-probe';
      await platform.launchers.install(bin, name, source);
      // Fail before cmd on the unsafe layout, so the red control starts no WScript.
      assert.deepEqual((await fs.readdir(bin)).sort(), ['.scripts', name, `${name}.cmd`]);
      assert.equal(
        await fs.readFile(path.join(bin, '.scripts', `${name}.js`), 'utf8'),
        await fs.readFile(source, 'utf8')
      );
      const env: NodeJS.ProcessEnv = { ...process.env, ...helpers.homeEnv(home) };
      for (const key of Object.keys(env)) {
        if (/^(PATH|PATHEXT)$/i.test(key)) delete env[key];
      }
      env.PATH = bin;
      env.PATHEXT = '.JS;.CJS;.EXE;.CMD;.BAT';
      for (const command of [`""${path.join(bin, name)}""`, name]) {
        const result = await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], {
          env,
          cwd: root,
          timeout: 4000,
          windowsHide: true,
          windowsVerbatimArguments: true
        }).then(
          (value) => ({ code: 0, ...value }),
          (error: { code: number; stdout: string; stderr: string }) => error
        );
        // PATHEXT finds `name.cmd`, never the extensionless file: the payload
        // runs under the captured runtime, which has no ActiveXObject.
        assert.equal(result.code, 1, JSON.stringify(result));
        assert.match(result.stderr, /ActiveXObject is not defined/);
        await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
      }
    }
  );

  it(
    'forwards exact argv, binary stdin, streams and exit without Node on PATH',
    { skip: helpers.testPlatform() !== 'win32' && 'posix: native Windows Git Bash entry route' },
    async (t) => {
      const home = await helpers.tempHome();
      t.after(() => helpers.disposeHome(home));
      const bash = helpers.gitBash();
      assert.ok(bash, 'no Git Bash found through any git.exe or bash.exe on PATH');
      const source = path.join(home, 'source.js');
      await fs.writeFile(
        source,
        `const chunks=[]; process.stdin.on('data',x=>chunks.push(x));
process.stdin.on('end',()=>{console.log(JSON.stringify({args:process.argv.slice(2),
stdin:Buffer.concat(chunks).toString('base64'),mode:process.env.ELECTRON_RUN_AS_NODE}));
console.error('fixture stderr');process.exitCode=7;});`
      );
      const bin = path.join(home, "space & apostrophe's 中文");
      const effects = {
        runtime: process.execPath,
        environment: process.env,
        readFile: (file: string) => fs.readFile(file, 'utf8'),
        lstat: (file: string) => fs.lstat(file),
        report: (message: string) => assert.fail(message),
        mkdir: async (dir: string) => {
          await fs.mkdir(dir, { recursive: true });
        },
        copyFile: (from: string, to: string) => fs.copyFile(from, to),
        chmod: (file: string, mode: number) => fs.chmod(file, mode),
        writeFile: (file: string, text: string) => fs.writeFile(file, text, { flag: 'wx' }),
        replace: (from: string, to: string) => platform.files.replace(from, to, { kind: 'owned' }),
        remove: (file: string) => fs.rm(file, { force: true })
      };
      await win32.launchers(effects).install(bin, 'squadron-step', source);
      const args = [
        '',
        '中文 😀',
        `it's "quoted"`,
        '{"json":true}',
        'one\ntwo',
        'C:\\end\\',
        '%PATH% ! & | $ `',
        // MSYS rewrites these for a native child unless told not to (2026-10-27).
        '/runs/x.progress.json',
        '--cwd-path=/tmp/a',
        '/c/Users'
      ];
      const input = Buffer.from('binary\u0000stdin 中文\n');
      // MSYS startup splits a raw Win32 argv newline in the script-plus-argv
      // route. Enter through shell text, as an already running Bash would.
      const quoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
      const command = [path.join(bin, 'squadron-step').replaceAll('\\', '/'), ...args]
        .map(quoted)
        .join(' ');
      const child = spawn(bash, ['--noprofile', '--norc', '-c', `exec ${command}`], {
        env: {
          ...process.env,
          ...helpers.homeEnv(home),
          PATH: '',
          ELECTRON_RUN_AS_NODE: 'parent'
        },
        windowsHide: true,
        timeout: 8000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      child.stdin.end(input);
      assert.equal(await closed, 7, Buffer.concat(stderr).toString());
      assert.deepEqual(JSON.parse(Buffer.concat(stdout).toString()), {
        args,
        stdin: input.toString('base64'),
        mode: '1'
      });
      assert.equal(Buffer.concat(stderr).toString(), 'fixture stderr\n');
    }
  );

  it(
    'runs the cmd launcher from cmd and Windows PowerShell with hostile argv, stdin and exit',
    { skip: helpers.testPlatform() !== 'win32' && 'posix: native cmd and Windows PowerShell' },
    async (t) => {
      const home = await helpers.tempHome();
      t.after(() => helpers.disposeHome(home));
      const bin = path.join(home, "bin space & 100% it's 中文");
      const source = path.join(home, 'source.js');
      const receipt = path.join(home, 'receipt.json');
      // The receipt file carries argv, so neither shell's console encoding is under test.
      await fs.writeFile(
        source,
        `const fs=require('fs');const chunks=[];process.stdin.on('data',x=>chunks.push(x));
process.stdin.on('end',()=>{fs.writeFileSync(process.env.SQ_RECEIPT,JSON.stringify({args:process.argv.slice(2),
stdin:Buffer.concat(chunks).toString('base64'),mode:process.env.ELECTRON_RUN_AS_NODE}));
console.log('fixture stdout');console.error('fixture stderr');process.exitCode=7;});`
      );
      await platform.launchers.install(bin, 'squadron-step', source);
      const launcher = path.join(bin, 'squadron-step.cmd');
      const env: NodeJS.ProcessEnv = { ...process.env, ...helpers.homeEnv(home) };
      for (const key of Object.keys(env)) {
        if (/^(PATH|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete env[key];
      }
      // No Node on PATH; cmd and PowerShell themselves are found by absolute path.
      env.PATH = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
      env.SQ_RECEIPT = receipt;
      const args = [
        '',
        'two words',
        '{"a b":[1,"x"]}',
        '50%',
        '!x!',
        '中文 😀',
        'a&b|c<d>e^f',
        "it's",
        '--name'
      ];
      async function invoke(file: string, argv: string[], input: string): Promise<unknown> {
        await fs.rm(receipt, { force: true });
        const child = spawn(file, argv, {
          env,
          cwd: home,
          windowsHide: true,
          windowsVerbatimArguments: true,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
        const closed = new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        child.stdin.end(input);
        const code = await closed;
        const stderr = Buffer.concat(err).toString();
        assert.equal(code, 7, stderr);
        assert.match(Buffer.concat(out).toString(), /^fixture stdout\r?\n(exit=7\r?\n)?$/);
        assert.equal(stderr.trim(), 'fixture stderr');
        return JSON.parse(await fs.readFile(receipt, 'utf8'));
      }
      // cmd: each value in double quotes, JSON quotes as \" (the runtime's
      // argv rules); cmd only tracks the quotes, so no metacharacter is bare.
      const cmdWord = (arg: string): string => `"${arg.replaceAll('"', '\\"')}"`;
      const cmdLine = `""${launcher}" ${args.map(cmdWord).join(' ')}"`;
      assert.deepEqual(
        await invoke(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', cmdLine], 'cmd in'),
        { args, stdin: Buffer.from('cmd in').toString('base64'), mode: '1' }
      );
      // The caller expands a defined bang variable before the launcher's setlocal.
      env.SQ_SET = 'EXPANDED';
      assert.deepEqual(
        await invoke(
          process.env.ComSpec ?? 'cmd.exe',
          ['/d', '/v:on', '/s', '/c', `""${launcher}" "!SQ_SET!""`],
          ''
        ),
        { args: ['EXPANDED'], stdin: '', mode: '1' }
      );
      assert.deepEqual(
        await invoke(
          process.env.ComSpec ?? 'cmd.exe',
          ['/d', '/e:off', '/s', '/c', cmdLine],
          'extensions off'
        ),
        { args, stdin: Buffer.from('extensions off').toString('base64'), mode: '1' }
      );
      // Windows PowerShell 5.1: the skill's '"value"' form. PowerShell passes a
      // value already in double quotes as written, so cmd sees it quoted. A
      // value with a `"` inside is outside that form: '"{\"a b\":1}"' arrived
      // split at its space (2026-10-26), hence --answers-file.
      const plain = args.filter((arg) => !arg.includes('"'));
      const psWord = (arg: string): string => `'"${arg.replaceAll("'", "''")}"'`;
      const script = `& '${launcher.replaceAll("'", "''")}' ${plain.map(psWord).join(' ')}; "exit=$LASTEXITCODE"; exit $LASTEXITCODE`;
      const powershell = path.join(env.PATH, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      assert.deepEqual(
        await invoke(
          powershell,
          [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64')
          ],
          ''
        ),
        { args: plain, stdin: '', mode: '1' }
      );
      // Resolution without running anything: the explicit `.cmd` path is the
      // launcher, while the extensionless path resolves to the sh file first,
      // which PowerShell would hand to the file association.
      const resolve = `foreach ($p in @('${launcher.replaceAll("'", "''")}', '${launcher.slice(0, -4).replaceAll("'", "''")}')) { (Get-Command -All $p | Select-Object -First 1).Source }`;
      const resolved = await run(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(
            `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${resolve}`,
            'utf16le'
          ).toString('base64')
        ],
        { env, windowsHide: true, encoding: 'utf8' }
      );
      assert.deepEqual(resolved.stdout.trim().split(/\r?\n/), [launcher, launcher.slice(0, -4)]);
    }
  );
});

describe('Windows launcher targets for generated commands', () => {
  it('names the .cmd for PowerShell and the sh wrapper for Git Bash, with no effect', () => {
    const { effects, files, replaced } = disk();
    const launchers = win32.launchers(effects);
    const bin = "C:\\user's 中文\\bin";
    assert.equal(
      launchers.verbPath(bin, 'squadron-step', 'windows-powershell'),
      path.win32.join(bin, 'squadron-step.cmd')
    );
    assert.equal(
      launchers.verbPath(bin, 'squadron-step', 'posix'),
      path.win32.join(bin, 'squadron-step')
    );
    assert.deepEqual([...files.keys()], ['source.js']);
    assert.deepEqual(replaced, []);
  });

  it('starts an owned script on the captured IDE runtime in Node mode', () => {
    const { effects } = disk();
    assert.deepEqual(win32.launchers(effects).scriptCommand(), {
      program: "C:\\IDE's 中文 & tools\\Code.exe",
      quoting: 'quoted',
      env: { ELECTRON_RUN_AS_NODE: '1' }
    });
  });
});
