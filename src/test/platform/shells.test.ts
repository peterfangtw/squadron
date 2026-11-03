import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import * as platform from '../../core/platform';
import type * as commands from '../../core/platform/commands';
import * as darwin from '../../core/platform/commands/darwin';
import * as win32 from '../../core/platform/commands/win32';
import { tempHome, testPlatform } from '../helpers';

const WORD: commands.Policy = { program: 'quoted', args: 'word' };
const QUOTED: commands.Policy = { program: 'quoted', args: 'quoted' };
const LITERAL: commands.Policy = { program: 'literal', args: 'quoted' };
const PS = 'windows-powershell';
const nativeOnly =
  testPlatform() !== 'win32' && 'posix: Windows PowerShell and Git Bash are win32 shells';

describe('which shell a consumer runs', () => {
  it('maps a native consumer to Windows PowerShell on win32 and to sh elsewhere', () => {
    assert.equal(win32.commands().shell('native'), PS);
    assert.equal(win32.commands().shell('posix'), 'posix');
    assert.equal(darwin.commands().shell('native'), 'posix');
    assert.equal(darwin.commands().shell('posix'), 'posix');
  });
});

describe('Windows PowerShell 5.1 spelling', () => {
  const cmd = 'C:\\Users\\me x\\.squadron\\bin\\squadron-step.cmd';

  it('hands a .cmd every value written as a quoted single-quoted string', () => {
    assert.equal(
      win32.commands().render(cmd, ['start', '--workflow-id', "it's a&b", '--opened', 7], WORD, PS),
      `& 'C:\\Users\\me x\\.squadron\\bin\\squadron-step.cmd' '"start"' '"--workflow-id"' '"it''s a&b"' '"--opened"' 7`
    );
    assert.equal(win32.commands().placeholder('<what you did>', PS), `'"<what you did>"'`);
  });

  it('spells native-exe values by the C runtime rule, with the environment before the program', () => {
    assert.equal(
      win32.commands().render('C:\\Program Files\\Code\\Code.exe', ['C:\\a b\\r.js'], QUOTED, PS, {
        ELECTRON_RUN_AS_NODE: '1'
      }),
      `$env:ELECTRON_RUN_AS_NODE='1'; & 'C:\\Program Files\\Code\\Code.exe' 'C:\\a b\\r.js'`
    );
    assert.equal(
      win32
        .commands()
        .render('codex', ['-c', 'k=[{a="x"}]', '', 'a b\\', `m="& 'C:\\x y'"`], LITERAL, PS),
      `codex '-c' 'k=[{a=\\"x\\"}]' '""' 'a b\\\\' '"m=""& ''C:\\x y''"""'`
    );
  });

  it('rejects cmd losses and native values whose target parser is unknown', () => {
    const carried = (value: string) => win32.commands().carries(cmd, [value], PS);
    for (const value of ['', 'a b', '50%', '!x!', 'x&y|z<>^', "it's", '日本']) {
      assert.equal(carried(value), true, value);
    }
    for (const value of ['a"b', 'two\nlines', 'cr\r', 'tail\\', '%PATH%']) {
      assert.equal(carried(value), false, value);
    }
    assert.equal(win32.commands().carries('C:\\n.exe', ['a"b c'], PS), false);
    assert.equal(
      win32.commands().carries('codex', [{ option: '-c', value: 'a="b c"' }], PS),
      false
    );
    assert.equal(win32.commands().carries('C:\\n.exe', ['a"b', 'two\nlines', 'x\\'], PS), true);
    assert.equal(darwin.commands().carries('/bin/x', ['a"b', 'two\nlines'], 'posix'), true);
  });

  it('leaves the POSIX spelling byte for byte on both backends', () => {
    for (const backend of [darwin.commands(), win32.commands()]) {
      assert.equal(
        backend.render("/opt/it's", ['a b', 7], WORD, 'posix', { ELECTRON_RUN_AS_NODE: '1' }),
        `ELECTRON_RUN_AS_NODE=1 '/opt/it'\\''s' 'a b' 7`
      );
      assert.equal(backend.placeholder('<what you did>', 'posix'), '"<what you did>"');
    }
  });

  it('keeps doubled-backslash transport limits in the Windows backend', () => {
    const value = '\\\\server\\share';
    assert.equal(win32.commands().carries(value, [], 'posix'), false);
    assert.equal(
      win32.commands().carries('verb', [{ option: '--cwd-path', value }], 'posix'),
      false
    );
    assert.equal(darwin.commands().carries(value, [value], 'posix'), true);
  });
});

/** Values the observed shells deliver exactly; the hard part of each route. */
const HARD = [
  'plain',
  '',
  'a b',
  '{"k":1}',
  '{"a b":[1,"x"]}',
  'tail\\',
  'a b\\',
  'x&y|z',
  '$x $(1+1) `b',
  "it's",
  '日本 ünï',
  '50% !x!',
  'two\nlines',
  '\\\\server\\share'
];

describe('native shell round trips', { skip: nativeOnly }, () => {
  let dir: string;
  let echo: string;
  const powershell = () =>
    path.win32.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const argvOf = (run: cp.SpawnSyncReturns<string>): unknown => {
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };

  before(async () => {
    dir = await fs.mkdtemp(path.join(await tempHome(), "shell 日本 & it's "));
    echo = path.join(dir, 'echo.cjs');
    await fs.writeFile(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  });

  it('delivers every value to a native exe through Windows PowerShell 5.1 -Command', () => {
    const text = platform.commands.render(process.execPath, [echo, ...HARD], QUOTED, PS);
    const run = cp.spawnSync(powershell(), ['-NoProfile', '-NonInteractive', '-Command', text], {
      encoding: 'utf8',
      windowsHide: true
    });
    assert.deepEqual(argvOf(run), HARD);
  });

  it('delivers each value carries admits to a .cmd through Windows PowerShell 5.1', async () => {
    const launcher = path.join(dir, 'verb.cmd');
    await fs.writeFile(
      launcher,
      `@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\n"${process.execPath}" "%~dp0echo.cjs" %*\r\n`
    );
    const admitted = HARD.filter((value) => platform.commands.carries(launcher, [value], PS));
    assert.deepEqual(
      HARD.filter((value) => !admitted.includes(value)),
      ['{"k":1}', '{"a b":[1,"x"]}', 'tail\\', 'a b\\', 'two\nlines']
    );
    const text = platform.commands.render(launcher, admitted, WORD, PS);
    const run = cp.spawnSync(powershell(), ['-NoProfile', '-NonInteractive', '-Command', text], {
      encoding: 'utf8',
      windowsHide: true
    });
    assert.deepEqual(argvOf(run), admitted);
  });

  it(
    'observes doubled-backslash loss before Bash regardless of MSYS child path conversion',
    { skip: !fsSync.existsSync(gitBash) && 'win32: Git Bash is not installed here' },
    () => {
      const values = ['a\\\\b', '\\\\server\\share', 'C:\\x\\\\'];
      const text = platform.commands.render(process.execPath, [echo, ...values], WORD, 'posix');
      for (const extra of [{}, { MSYS_NO_PATHCONV: '1' }, { MSYS2_ARG_CONV_EXCL: '*' }]) {
        const run = cp.spawnSync(gitBash, ['-c', text], {
          encoding: 'utf8',
          windowsHide: true,
          env: { ...process.env, ...extra }
        });
        assert.deepEqual(argvOf(run), ['a\\b', '\\server\\share', 'C:\\x\\']);
      }
    }
  );

  it(
    'runs POSIX text naming a native backslash path in Git Bash',
    { skip: !fsSync.existsSync(gitBash) && 'win32: Git Bash is not installed here' },
    async () => {
      const verb = path.join(dir, 'squadron-x');
      const posixPath = (native: string) =>
        `'${native.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
      await fs.writeFile(
        verb,
        `#!/bin/sh\nexec ${posixPath(process.execPath)} ${posixPath(echo)} "$@"\n`,
        { mode: 0o755 }
      );
      const carried = HARD.filter((value) => platform.commands.carries(verb, [value], 'posix'));
      const text = platform.commands.render(verb, carried, WORD, 'posix');
      const run = cp.spawnSync(gitBash, ['-c', text], { encoding: 'utf8', windowsHide: true });
      assert.deepEqual(argvOf(run), carried);
    }
  );
});

describe('generated commands carry their receiver', () => {
  let paths: typeof import('../../core/paths');
  let briefing: typeof import('../../core/workflows/progress_briefing');
  const windows = testPlatform() === 'win32';

  before(async () => {
    await tempHome();
    paths = await import('../../core/paths');
    briefing = await import('../../core/workflows/progress_briefing');
  });

  it("writes each brand's verbs for its command tool's shell", () => {
    assert.equal(paths.toolShell('claude'), 'posix');
    assert.equal(paths.toolShell(undefined), 'posix');
    assert.equal(paths.toolShell('codex'), windows ? PS : 'posix');
    assert.equal(paths.toolShell('grok'), windows ? PS : 'posix');
  });

  it('hands a PowerShell receiver its platform launcher and argument quoting', () => {
    const verb = path.join(paths.BIN_DIR, `squadron-step${windows ? '.cmd' : ''}`);
    const next = windows ? `'"next"'` : "'next'";
    const done = windows ? `'"done"' '"--note"'` : "'done' '--note'";
    assert.equal(paths.stepCommand(PS, 'next'), `& '${verb.replaceAll("'", "''")}' ${next}`);
    assert.ok(
      briefing
        .progressBriefing('/runs/x.progress.json', PS)
        .includes(
          `run \`& '${verb.replaceAll("'", "''")}' ${next}\` for your next instruction, and \`& '${verb.replaceAll("'", "''")}' ${done} '"<what you did>"'\``
        )
    );
  });

  it(
    'executes the generated POSIX argv-file fallback without losing doubled backslashes',
    { skip: !windows && 'posix: native-to-Git-Bash command transport is win32 only' },
    async () => {
      const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
      const argv = ['done', '--note', 'a\\\\b \\\\server\\share C:\\x\\\\'];
      const text = paths.stepCommand('posix', ...argv);
      const marker = ', <file> being a UTF-8 file holding the JSON array ';
      assert.ok(text.includes(marker), text);
      const [command, json] = text.split(marker);
      assert.ok(command && json);
      assert.deepEqual(JSON.parse(json), argv);
      await fs.mkdir(paths.BIN_DIR, { recursive: true });
      const echo = path.join(paths.BIN_DIR, 'echo.cjs');
      const input = path.join(path.dirname(paths.BIN_DIR), 'argv.json');
      const prelude = path.resolve(__dirname, '../../cli/input_file.js');
      await fs.writeFile(
        echo,
        `require(${JSON.stringify(prelude)}).argvOrExit('probe').then(argv => process.stdout.write(JSON.stringify(argv)))`
      );
      await fs.writeFile(input, json);
      const bundle = path.join(paths.BIN_DIR, 'bundle.js');
      await fs.copyFile(echo, bundle);
      await platform.launchers.install(paths.BIN_DIR, 'squadron-step', bundle);
      const line = command.replace('"<file>"', platform.commands.render(input, [], WORD, 'posix'));
      const run = cp.spawnSync(gitBash, ['-c', line], { encoding: 'utf8', windowsHide: true });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), argv);
    }
  );

  it(
    'reports an unsupported POSIX route when the launcher program itself has doubled backslashes',
    { skip: !windows && 'posix: native-to-Git-Bash command transport is win32 only' },
    () => {
      const helpers = path.resolve(__dirname, '../helpers.js');
      const module = path.resolve(__dirname, '../../core/paths.js');
      const script = `const h = require(${JSON.stringify(helpers)}); const os = require('node:os'); (async () => { const home = await h.tempHome(); const homedir = os.homedir; try { os.homedir = () => '\\\\\\\\server\\\\share\\\\home'; console.log(require(${JSON.stringify(module)}).stepCommand('posix', 'next')); } finally { os.homedir = homedir; await h.disposeHome(home); } })()`;
      const run = cp.spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        windowsHide: true
      });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /^Unsupported command route:/);
      assert.match(run.stdout, /program path/);
      assert.doesNotMatch(run.stdout, /--argv-file/);
    }
  );

  it(
    'routes a value cmd would lose through --argv-file instead of spelling it wrong',
    { skip: !windows && 'posix: only a win32 PowerShell receiver hands a .cmd' },
    () => {
      const fetch = path.join(paths.BIN_DIR, 'squadron-fetch-file.cmd').replaceAll("'", "''");
      assert.equal(
        paths.verbCommand(PS, 'squadron-fetch-file', '--file-id', 'it\'s\n日本 {"j":1}'),
        `& '${fetch}' '"--argv-file"' '"<file>"', <file> being a UTF-8 file holding the JSON array ["--file-id","it's\\n日本 {\\"j\\":1}"]`
      );
    }
  );
});

describe("execution hooks through each brand's own hook shell", { skip: nativeOnly }, () => {
  const powershell = path.win32.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  let home: string;
  let source: string;
  let execution: typeof import('../../core/execution');
  let adapters: typeof import('../../core/adapter');

  before(async () => {
    home = await tempHome();
    execution = await import('../../core/execution');
    adapters = await import('../../core/adapter');
    source = path.join(home, 'recorder.js');
    // Stands in for the execution bundle: what the hook's runtime receives.
    await fs.writeFile(
      source,
      [
        "const fs = require('fs');",
        "let stdin = '';",
        "process.stdin.on('data', (d) => (stdin += d)).on('end', () => {",
        '  fs.writeFileSync(process.env.SQ_HOOK_OUT, JSON.stringify({ argv: process.argv.slice(2), mode: process.env.ELECTRON_RUN_AS_NODE, stdin }));',
        '});'
      ].join('\n')
    );
  });

  for (const brand of ['claude', 'codex', 'grok'] as const) {
    it(`${brand}: the hook command runs the runner on the IDE runtime, stdin intact`, async () => {
      const integration = adapters.adapter(brand)?.execution;
      assert.ok(integration);
      let hook = '';
      const prepared = await execution.prepareExecution(
        { ...integration, configure: (command) => Promise.resolve((hook = command)) },
        source,
        true
      );
      assert.ok(prepared.runtime.runner);
      const shell = platform.commands.shell(integration.hookShell);
      const quoted = (text: string, posix: boolean) =>
        posix ? `'${text.replaceAll("'", "'\\''")}'` : `'${text.replaceAll("'", "''")}'`;
      assert.equal(
        hook,
        shell === 'posix'
          ? `ELECTRON_RUN_AS_NODE=1 ${quoted(process.execPath, true)} ${quoted(prepared.runtime.runner, true)}`
          : `$env:ELECTRON_RUN_AS_NODE='1'; & ${quoted(process.execPath, false)} ${quoted(prepared.runtime.runner, false)}`
      );
      const out = path.join(home, `${brand}-hook.json`);
      const payload = JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_input: { command: 'echo "a b"' }
      });
      const env: NodeJS.ProcessEnv = { ...process.env, SQ_HOOK_OUT: out };
      for (const key of Object.keys(env))
        if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
      const run =
        shell === 'posix'
          ? cp.spawnSync(gitBash, ['-c', hook], {
              input: payload,
              encoding: 'utf8',
              env,
              windowsHide: true
            })
          : cp.spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', hook], {
              input: payload,
              encoding: 'utf8',
              env,
              windowsHide: true
            });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(await fs.readFile(out, 'utf8')), {
        argv: [],
        mode: '1',
        stdin: payload
      });
    });
  }

  it("names Codex's review shell and spells its flags for Windows PowerShell", async () => {
    const codex = adapters.adapter('codex')?.execution;
    assert.ok(codex);
    const hook = `$env:ELECTRON_RUN_AS_NODE='1'; & '${process.execPath}' 'C:\\it''s a\\r.js'`;
    const directory = await fs.mkdtemp(path.join(home, 'codex-'));
    const args = (await codex.configure(hook, directory)) as string[];
    const review = await fs.readFile(path.join(directory, 'codex-hook-review.txt'), 'utf8');
    assert.ok(
      review.startsWith('Run this in Windows PowerShell 5.1 in the same Codex environment')
    );
    assert.match(review, /standalone codex\.exe/);
    assert.match(review, /codex\.ps1.*codex\.cmd/);
    const line = review.trimEnd().split('\n').at(-1) ?? '';
    assert.ok(line.startsWith('codex '));
    // codex.exe is Rust; its parser and the UCRT's agree on this spelling (2026-10-27).
    const echo = path.join(directory, 'echo.cjs');
    await fs.writeFile(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const text = line.replace(/^codex /, `& '${process.execPath}' '${echo}' `);
    const run = cp.spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', text], {
      encoding: 'utf8',
      windowsHide: true
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), args);
    const shim = path.join(directory, 'codex.ps1');
    await fs.writeFile(shim, 'ConvertTo-Json -InputObject @($args) -Compress');
    const shimText = line.replace(/^codex /, `& '${shim}' `);
    const shimRun = cp.spawnSync(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', shimText],
      {
        encoding: 'utf8',
        windowsHide: true
      }
    );
    assert.equal(shimRun.status, 0, shimRun.stderr);
    const received = JSON.parse(shimRun.stdout) as string[];
    assert.notDeepEqual(
      received,
      args,
      'a PowerShell shim receives the native-parser spelling literally'
    );
    assert.ok(received.some((value) => value.startsWith('"hooks.')));
  });
});
