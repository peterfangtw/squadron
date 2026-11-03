import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as win32 from '../../core/platform/processes/win32';
import * as reader from '../../core/platform/processes/win32_reader';
import * as helpers from '../helpers';

const NONCE = 'a'.repeat(32);
const DMTF = '20261025203303.813932+480';
/** The same start as `DMTF`, as FILETIME 100 ns units since 1601 UTC. */
const START = '134374051838139320';
const OWNED_MS = 1_792_931_583_813;

function field(text: string | null): string {
  return text === null ? '-' : `b64:${Buffer.from(text, 'utf8').toString('base64')}`;
}

function row(
  pid: number,
  ppid: number,
  command: string | null,
  start = START,
  image: string | null = 'node.exe'
): string {
  return `${pid} ${ppid} ${start} ${field(image)} ${field(command)}`;
}

function frame(options?: {
  nonce?: string;
  self?: number;
  kernel?: string;
  rows?: string[];
  count?: number;
  end?: string;
  extra?: string;
}): string {
  const nonce = options?.nonce ?? NONCE;
  const rows = options?.rows ?? [row(4, 0, null), row(10, 4, 'powershell')];
  const count = options?.count ?? rows.length;
  const lines = [
    `v3 ${nonce}`,
    `self ${options?.self ?? 10}`,
    options?.kernel ?? `kernel 4 0 ${START}`,
    `count ${count}`,
    ...rows,
    options?.end ?? `end ${nonce} ${count}`
  ];
  if (options?.extra) lines.push(options.extra);
  return `${lines.join('\n')}\n`;
}

function nonceOf(args: readonly string[]): string {
  const script = Buffer.from(args[args.length - 1] ?? '', 'base64').toString('utf16le');
  const nonce = /\$nonce = '([0-9a-f]{32})'/.exec(script)?.[1];
  if (!nonce) throw new Error('encoded script has no nonce');
  return nonce;
}

function effects(build: (nonce: string) => string): {
  effects: reader.ReaderEffects;
  calls: number;
} {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    effects: {
      windowsDirectory: 'D:\\Windows',
      run(_file, args) {
        state.calls += 1;
        return Promise.resolve({ stdout: build(nonceOf(args)), stderr: '', code: 0 });
      }
    }
  };
}

describe('Windows one-shot process reader', () => {
  it('does not acquire a table at import or factory construction', () => {
    const fake = effects(() => {
      throw new Error('run');
    });
    reader.reader(fake.effects);
    win32.processes({
      ...fake.effects,
      start: () => assert.fail('start'),
      kill: () => {},
      record: () => {}
    });
    assert.equal(fake.calls, 0);
  });

  it('floors DMTF microseconds with the offset applied once', () => {
    assert.equal(reader.dmtfToUnixMs(DMTF), OWNED_MS);
    assert.equal(reader.dmtfToUnixMs('20261025123303.813932+000'), OWNED_MS);
    assert.equal(reader.dmtfToUnixMs('20261025043303.813932-480'), OWNED_MS);
    assert.equal((134374051838139320n - 116444736000000000n) / 10000n, BigInt(OWNED_MS));
    assert.equal(reader.dmtfToUnixMs('20261025203303.857173+480'), 1_792_931_583_857);
    assert.equal((134374051838571739n - 116444736000000000n) / 10000n, 1792931583857n);
    assert.equal(reader.dmtfToUnixMs('20260231010101.000000+000'), undefined);
    assert.equal(reader.dmtfToUnixMs('20261025203303.813932+999'), undefined);
    assert.equal(reader.dmtfToUnixMs('20261325203303.813932+000'), undefined);
    assert.equal(reader.dmtfToUnixMs('20261025203303.81369+480'), undefined);
    assert.equal(reader.dmtfToUnixMs('20000229000000.000000+000'), Date.UTC(2000, 1, 29));
    for (const date of [
      '19000229000000.000000+000',
      '20260001000000.000000+000',
      '20260100240000.000000+000',
      '20260101240000.000000+000',
      '20260101006000.000000+000',
      '20260101000060.000000+000',
      '20260101000000.000000-841'
    ]) {
      assert.equal(reader.dmtfToUnixMs(date), undefined);
    }
  });

  it('floors FILETIME to milliseconds and refuses anything but a canonical in-range integer', () => {
    assert.equal(reader.filetimeToUnixMs(START), OWNED_MS);
    // 2026-10-25: WMI DMTF and FILETIME of one owned process, the same millisecond.
    assert.equal(reader.filetimeToUnixMs('134374051838139320'), reader.dmtfToUnixMs(DMTF));
    assert.equal(reader.filetimeToUnixMs('134374051838571739'), 1_792_931_583_857);
    assert.equal(reader.filetimeToUnixMs('134374051838139999'), OWNED_MS, 'floored, never rounded');
    assert.equal(reader.filetimeToUnixMs('116444736000000000'), 0);
    assert.equal(
      reader.filetimeToUnixMs('2650467743999999999'),
      Date.UTC(9999, 11, 31, 23, 59, 59, 999)
    );
    for (const text of [
      '',
      '0',
      '?',
      '116444735999999999',
      '2650467744000000000',
      '12345678901234567890',
      '013437405183813932',
      '-134374051838139320',
      '+134374051838139320',
      '134374051838139320.0',
      '1.3437405183813932e17',
      ' 134374051838139320',
      '0x1dd4ac1b9d6c4b8'
    ])
      assert.equal(reader.filetimeToUnixMs(text), undefined, JSON.stringify(text));
  });

  it('reads one nonce-bound table and keeps a null command null', async () => {
    const text = `中文\n😀`;
    const fake = effects((nonce) =>
      frame({ nonce, rows: [row(4, 0, null), row(10, 4, 'powershell'), row(50, 10, text)] })
    );
    const read = await reader.reader(fake.effects).read();
    assert.equal(fake.calls, 1);
    assert.equal(read.status, 'ok');
    if (read.status !== 'ok') return;
    assert.equal(read.value.source, reader.WIN32_FILETIME_MS_V1);
    assert.equal(read.value.selfPid, 10);
    assert.equal(read.value.kernelPid, 4);
    assert.equal(read.value.rows[0]?.command, null);
    assert.equal(read.value.rows[2]?.command, text);
    assert.equal(read.value.rows[2]?.startedAt, OWNED_MS);
    assert.equal('pgid' in (read.value.rows[0] ?? {}), false);
  });

  it('asks for the absolute PowerShell and the cold bounds', async () => {
    let seen:
      { file: string; args: readonly string[]; timeoutMs: number; maxBuffer: number } | undefined;
    const read = await reader
      .reader({
        windowsDirectory: 'D:\\Windows',
        run(file, args, options) {
          seen = { file, args, ...options };
          const script = Buffer.from(args[args.length - 1] ?? '', 'base64').toString('utf16le');
          const nonce = /\$nonce = '([0-9a-f]{32})'/.exec(script)?.[1] ?? '';
          return Promise.resolve({ stdout: frame({ nonce }), stderr: '', code: 0 });
        }
      })
      .read();
    assert.equal(read.status, 'ok');
    assert.equal(seen?.file, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(seen?.args.slice(0, 4), [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass'
    ]);
    assert.equal(seen?.args[4], '-EncodedCommand');
    assert.equal(seen?.timeoutMs, reader.TIMEOUT_MS);
    assert.equal(seen?.maxBuffer, reader.MAX_OUTPUT);
  });

  it('fails a malformed, duplicate, truncated or oversize frame with no rows', () => {
    assert.equal(reader.parseFrame('not a table', NONCE).status, 'failed');
    assert.equal(reader.parseFrame(frame({ nonce: 'b'.repeat(32) }), NONCE).status, 'failed');
    assert.equal(reader.parseFrame(frame().replace(`end ${NONCE}`, 'end'), NONCE).status, 'failed');
    assert.equal(reader.parseFrame(`${frame()}${frame()}`, NONCE).status, 'failed');
    assert.equal(reader.parseFrame(frame({ extra: `end ${NONCE} 2` }), NONCE).status, 'failed');
    const duplicate = reader.parseFrame(
      frame({ rows: [row(4, 0, null), row(10, 4, 'powershell'), row(10, 4, 'other')] }),
      NONCE
    );
    assert.equal(duplicate.status, 'failed');
    assert.equal('value' in duplicate, false);
    assert.equal(reader.parseFrame(`${'x'.repeat(reader.MAX_OUTPUT + 1)}`, NONCE).status, 'failed');
    assert.equal(
      reader.parseFrame(frame({ rows: [], count: 0, end: `end ${NONCE} 0` }), NONCE).status,
      'failed'
    );
  });

  it('stays incomplete for a bad start, a missing witness, or an absent identity', () => {
    const badDate = reader.parseFrame(
      frame({
        rows: [row(4, 0, null), row(10, 4, 'powershell'), `50 10 0 - ${field('x')}`]
      }),
      NONCE
    );
    assert.equal(badDate.status, 'incomplete');
    if (badDate.status === 'incomplete') {
      assert.deepEqual(
        badDate.value.rows.map((item) => item.pid),
        [4, 10]
      );
      assert.match(badDate.reason, /no usable start/);
    }
    const noSelf = reader.parseFrame(frame({ self: 99 }), NONCE);
    assert.equal(noSelf.status, 'incomplete');
    if (noSelf.status === 'incomplete') assert.equal(noSelf.reason, 'self witness missing');
    const noKernel = reader.parseFrame(frame({ kernel: 'kernel missing' }), NONCE);
    assert.equal(noKernel.status, 'incomplete');
    if (noKernel.status === 'incomplete') {
      assert.equal(noKernel.reason, 'kernel witness missing');
      assert.equal(noKernel.value.kernelPid, undefined);
    }
    const badOffset = reader.parseFrame(
      frame({
        rows: [row(4, 0, null), row(10, 4, 'powershell'), row(50, 10, 'x', '01343740518381393')]
      }),
      NONCE
    );
    assert.equal(badOffset.status, 'incomplete');
  });

  it('fails a bounded timeout or stderr instead of returning an empty table', async () => {
    const timed = await reader
      .reader({
        windowsDirectory: 'D:\\Windows',
        run(_file, _args, options) {
          assert.equal(options.timeoutMs, 5_000);
          return Promise.reject(new Error('powershell timed out'));
        }
      })
      .read();
    assert.deepEqual(timed, { supported: true, status: 'failed', reason: 'powershell timed out' });
    const noisy = await reader
      .reader({
        windowsDirectory: 'D:\\Windows',
        run: () => Promise.resolve({ stdout: frame(), stderr: 'CLIXML', code: 0 })
      })
      .read();
    assert.equal(noisy.status, 'failed');
    const died = await reader
      .reader({
        windowsDirectory: 'D:\\Windows',
        run: () => Promise.resolve({ stdout: '', stderr: '', code: 1 })
      })
      .read();
    assert.equal(died.status, 'failed');
  });

  it('requires a positive reader witness and checks duplicate identities even with bad starts', () => {
    assert.equal(
      reader.parseFrame(frame({ self: 0, rows: [row(0, 0, null), row(4, 0, null)] }), NONCE).status,
      'failed'
    );
    assert.equal(
      reader.parseFrame(
        frame({ rows: [row(4, 0, null), row(10, 4, 'powershell'), row(10, 4, null, '?')] }),
        NONCE
      ).status,
      'failed'
    );
  });

  it('uses the supplied Windows directory and refuses missing or relative roots before spawn', async () => {
    for (const directory of ['Z:\\Windows', undefined, 'Windows', 'Z:Windows', '\\Windows']) {
      let called = false;
      const effect = {
        windowsDirectory: directory,
        run(file: string, args: readonly string[]) {
          called = true;
          assert.equal(file, 'Z:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
          return Promise.resolve({ stdout: frame({ nonce: nonceOf(args) }), stderr: '', code: 0 });
        }
      };
      const result = await reader.reader(effect).read();
      assert.equal(called, directory === 'Z:\\Windows');
      assert.equal(result.status, called ? 'ok' : 'failed');
    }
  });

  it('reads the image name beside the command, each nullable and each checked', () => {
    const read = reader.parseFrame(
      frame({
        rows: [
          row(4, 0, null, START, 'System'),
          row(10, 4, 'powershell', START, 'powershell.exe'),
          row(20, 10, null, START, null)
        ]
      }),
      NONCE
    );
    assert.equal(read.status, 'ok');
    if (read.status !== 'ok') return;
    assert.deepEqual(
      read.value.rows.map((item) => item.image),
      ['System', 'powershell.exe', null]
    );
    const bad = reader.parseFrame(
      frame({ rows: [row(4, 0, null), row(10, 4, 'powershell'), `50 10 ${START} b64:/w== -`] }),
      NONCE
    );
    assert.equal(bad.status, 'incomplete');
    if (bad.status === 'incomplete') {
      assert.match(bad.reason, /image or command/);
      assert.deepEqual(
        bad.value.rows.find((item) => item.pid === 50),
        { pid: 50, ppid: 10, startedAt: OWNED_MS, image: null, command: null }
      );
    }
    assert.equal(
      reader.parseFrame(frame({ rows: [row(4, 0, null), `10 4 ${START} b64:eA==`] }), NONCE).status,
      'failed'
    );
  });

  it('does not accept invalid UTF-8 or noncanonical base64 as complete metadata', () => {
    for (const text of ['b64:/w==', 'b64:AB==', 'b64:YQ=']) {
      const read = reader.parseFrame(
        frame({ rows: [row(4, 0, null), row(10, 4, 'powershell'), `50 10 ${START} - ${text}`] }),
        NONCE
      );
      assert.equal(read.status, 'incomplete');
      if (read.status === 'incomplete')
        assert.equal(read.value.rows.find((item) => item.pid === 50)?.command, null);
    }
  });

  it('bounds the frame in UTF-8 bytes rather than UTF-16 characters', () => {
    assert.equal(
      reader.parseFrame(
        frame({
          rows: [
            row(4, 0, null),
            row(10, 4, 'powershell'),
            `50 10 ${START} - b64:${'中'.repeat(reader.MAX_OUTPUT / 3)}`
          ]
        }),
        NONCE
      ).status,
      'failed'
    );
  });

  it('does not accept a kernel witness with contradictory raw precision', () => {
    assert.equal(
      reader.parseFrame(frame({ kernel: 'kernel 4 0 134374051838139329' }), NONCE).status,
      'incomplete'
    );
  });

  it('rejects contradictory counts, unknown envelopes and out-of-range identities', () => {
    for (const text of [
      frame({ count: 1 }),
      frame({ end: `end ${NONCE} 3` }),
      frame().replace('v3 ', 'v2 '),
      frame({ self: 4294967296 }),
      frame().replace('self 10', 'self 010'),
      frame({ rows: [row(4, 0, null), row(10, 4, 'powershell'), '99 0 malformed'] }),
      frame({ count: reader.MAX_ROWS + 1 })
    ]) {
      const result = reader.parseFrame(text, NONCE);
      assert.equal(result.status, 'failed');
      assert.equal('value' in result, false);
    }
    assert.throws(() => reader.powershellArgs("' forged"), /nonce/);
  });

  it('accepts exactly the row limit without accepting a shorter claimed table', () => {
    const rows = [
      row(4, 0, null),
      ...Array.from({ length: reader.MAX_ROWS - 1 }, (_, index) => row(index + 10, 4, null))
    ];
    assert.equal(reader.parseFrame(frame({ rows }), NONCE).status, 'ok');
    assert.equal(
      reader.parseFrame(frame({ rows, count: rows.length - 1 }), NONCE).status,
      'failed'
    );
  });

  it(
    'retains a native row with a lone surrogate command as incomplete metadata',
    { skip: helpers.testPlatform() !== 'win32' && 'posix: native one-shot process reader' },
    async () => {
      const read = await reader
        .reader({
          windowsDirectory: process.env.SystemRoot,
          run(file, args, options) {
            const substituted = [...args];
            const script = Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le');
            assert.ok(script.includes('$command = $_.CommandLine'));
            substituted[substituted.length - 1] = Buffer.from(
              script.replace('$command = $_.CommandLine', '$command = "a$([char]0xD800)"'),
              'utf16le'
            ).toString('base64');
            return capture(file, substituted, options, () => {});
          }
        })
        .read();
      assert.equal(read.status, 'incomplete', read.status === 'ok' ? '' : read.reason);
      if (read.status !== 'incomplete') return;
      const self = read.value.rows.find((item) => item.pid === read.value.selfPid);
      assert.ok(self, 'reader row retained');
      assert.equal(self.command, null);
      assert.match(read.reason, /image or command/);
    }
  );

  it(
    'rejects unavailable native identities and acquisition limits before publishing a frame',
    { skip: helpers.testPlatform() !== 'win32' && 'posix: native one-shot process reader' },
    async () => {
      for (const [before, after, reason] of [
        ['$rawProcessId = $_.ProcessId', '$rawProcessId = $null', /process identity unavailable/],
        [
          '$rawParentId = $_.ParentProcessId',
          '$rawParentId = $null',
          /process identity unavailable/
        ],
        ['$maxRows = 65536', '$maxRows = 1', /row limit/],
        ['$maxOutput = 8388608', '$maxOutput = 1024', /byte limit/],
        ['$command = $_.CommandLine', "$command = 'x' * 7000000", /byte limit/],
        [
          'Get-CimInstance -ClassName Win32_Process',
          "throw 'owned fixture query error'; Get-CimInstance -ClassName Win32_Process",
          /owned fixture query error/
        ]
      ] as const) {
        const args = [...reader.powershellArgs(NONCE)];
        const script = Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le');
        args[args.length - 1] = Buffer.from(script.replace(before, after), 'utf16le').toString(
          'base64'
        );
        const powershell = reader.powershellPath(process.env.SystemRoot);
        assert.ok(powershell);
        let closed = false;
        let helperPid: number | undefined;
        const result = await capture(
          powershell,
          args,
          { maxBuffer: 16384, timeoutMs: 5000 },
          (child) => {
            helperPid = child.pid;
            child.once('close', () => {
              closed = true;
            });
          }
        );
        assert.equal(closed, true);
        assert.ok(helperPid);
        assert.throws(() => process.kill(helperPid ?? 0, 0));
        assert.notEqual(result.code, 0);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, reason);
      }
    }
  );

  it(
    'closes the native PowerShell on timeout and either output overflow',
    { skip: helpers.testPlatform() !== 'win32' && 'posix: native PowerShell lifetime' },
    async () => {
      const powershell = reader.powershellPath(process.env.SystemRoot);
      assert.ok(powershell);
      for (const [script, timeoutMs, reason] of [
        ['Start-Sleep -Seconds 30', 1000, /timed out/],
        ["[Console]::Out.Write(('x' * 65536)); Start-Sleep -Seconds 30", 5000, /stdout maxBuffer/],
        ["[Console]::Error.Write(('x' * 65536)); Start-Sleep -Seconds 30", 5000, /stderr maxBuffer/]
      ] as const) {
        let closed = false;
        let pid: number | undefined;
        await assert.rejects(
          capture(
            powershell,
            [
              '-NoProfile',
              '-NonInteractive',
              '-EncodedCommand',
              Buffer.from(script, 'utf16le').toString('base64')
            ],
            { maxBuffer: 1024, timeoutMs },
            (child) => {
              pid = child.pid;
              child.once('close', () => {
                closed = true;
              });
            }
          ),
          reason
        );
        assert.equal(closed, true);
        assert.ok(pid);
        assert.throws(() => process.kill(pid ?? 0, 0));
      }
    }
  );

  it('waits for exact child close on timeout and either stream overflow', async () => {
    for (const source of [
      'setInterval(() => {}, 1000)',
      "process.stdout.write('x'.repeat(65536)); setInterval(() => {}, 1000)",
      "process.stderr.write('x'.repeat(65536)); setInterval(() => {}, 1000)"
    ]) {
      let pid: number | undefined;
      let closed = false;
      await assert.rejects(
        capture(process.execPath, ['-e', source], { maxBuffer: 1024, timeoutMs: 1000 }, (child) => {
          pid = child.pid;
          child.once('close', () => {
            closed = true;
          });
        }),
        source.includes('stdout')
          ? /stdout maxBuffer/
          : source.includes('stderr')
            ? /stderr maxBuffer/
            : /timed out/
      );
      assert.equal(closed, true);
      assert.ok(pid);
      assert.throws(() => process.kill(pid ?? 0, 0));
    }
  });

  it('settles spawn failure only after close', async () => {
    let closed = false;
    await assert.rejects(
      capture(
        path.join(os.tmpdir(), `squadron-missing-${crypto.randomBytes(12).toString('hex')}`),
        [],
        { maxBuffer: 1024, timeoutMs: 1000 },
        (child) =>
          child.once('close', () => {
            closed = true;
          })
      ),
      /ENOENT/
    );
    assert.equal(closed, true);
  });

  it(
    'agrees with raw System.Management DMTF on every row both reads saw',
    { skip: helpers.testPlatform() !== 'win32' && 'posix: native one-shot process reader' },
    async () => {
      const read = await reader
        .reader({
          windowsDirectory: process.env.SystemRoot,
          run: (file, args, options) => capture(file, args, options, () => {})
        })
        .read();
      assert.equal(read.status, 'ok', read.status === 'ok' ? '' : read.reason);
      if (read.status !== 'ok') return;
      const raw = await capture(
        reader.powershellPath(process.env.SystemRoot) ?? '',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(
            "$s = New-Object System.Management.ManagementObjectSearcher 'SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process'; " +
              "foreach ($r in $s.Get()) { [Console]::Out.WriteLine(('{0} {1} {2}' -f $r['ProcessId'], $r['ParentProcessId'], $r['CreationDate'])); $r.Dispose() }; $s.Dispose()",
            'utf16le'
          ).toString('base64')
        ],
        { maxBuffer: 4 * 1024 * 1024, timeoutMs: 15_000 },
        () => {}
      );
      const dmtf = new Map<number, { ppid: number; ms: number | undefined }>();
      const lines = raw.stdout.trim().split(/\r?\n/);
      for (const line of lines) {
        const [pid, ppid, created] = line.split(' ');
        dmtf.set(Number(pid), { ppid: Number(ppid), ms: reader.dmtfToUnixMs(created ?? '') });
      }
      // Same pid and parent in both reads: the same process, barring reuse within a second.
      const shared = read.value.rows.filter((item) => dmtf.get(item.pid)?.ppid === item.ppid);
      assert.ok(
        shared.length >= read.value.rows.length * 0.9,
        `${shared.length} of ${read.value.rows.length} rows in both reads`
      );
      const disagree = shared.filter((item) => dmtf.get(item.pid)?.ms !== item.startedAt);
      assert.deepEqual(
        disagree.map((item) => item.pid),
        []
      );
    }
  );

  it(
    'reads an owned child start and leaves no powershell',
    { skip: helpers.testPlatform() !== 'win32' && 'posix: native one-shot process reader' },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squadron-reader-'));
      const release = path.join(dir, 'release');
      const ready = path.join(dir, 'ready');
      const marker = `${crypto.randomBytes(12).toString('hex')}-中文`;
      const script = path.join(dir, 'hold.js');
      await fs.promises.writeFile(
        script,
        `const fs = require('fs');\n` +
          `fs.writeFileSync(process.argv[3], 'ready');\n` +
          `const timer = setInterval(() => { if (fs.existsSync(process.argv[2])) { clearInterval(timer); process.exit(0); } }, 20);\n` +
          `setTimeout(() => process.exit(3), 20000);\n`
      );
      const child = spawn(process.execPath, [script, release, ready, marker], {
        windowsHide: true,
        stdio: 'ignore'
      });
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      let fixtureError: Error | undefined;
      child.once('error', (error) => {
        fixtureError = error;
      });
      let readerPid: number | undefined;
      let readerChild: ChildProcess | undefined;
      try {
        const started = Date.now();
        while (!fs.existsSync(ready)) {
          if (fixtureError) throw fixtureError;
          assert.ok(Date.now() - started < 5_000, 'fixture did not become ready');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const read = await reader
          .reader({
            windowsDirectory: process.env.SystemRoot,
            run: (file, args, options) =>
              capture(file, args, options, (child) => {
                readerPid = child.pid;
                readerChild = child;
              })
          })
          .read();
        const rows = read.status === 'failed' ? [] : read.value.rows;
        const found = rows.find((item) => item.pid === child.pid && item.command?.includes(marker));
        assert.ok(
          found,
          `fixture pid ${child.pid} missing from ${rows.length} ${read.status} rows`
        );
        assert.equal(read.status, 'ok', read.status === 'incomplete' ? read.reason : read.status);
        if (read.status !== 'ok') return;
        assert.equal(read.value.selfPid, readerPid);
        assert.equal(read.value.kernelPid, 4);
        assert.ok(
          read.value.rows.some((item) => item.pid === readerPid && item.ppid === process.pid)
        );
        const oracle = await capture(
          reader.powershellPath(process.env.SystemRoot) ?? '',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `[Console]::Out.WriteLine((Get-Process -Id ${child.pid}).StartTime.ToFileTime())`
          ],
          { maxBuffer: 1024 * 1024, timeoutMs: 8_000 },
          () => {}
        );
        const filetimeMs = (BigInt(oracle.stdout.trim()) - 116444736000000000n) / 10000n;
        assert.equal(found.startedAt, Number(filetimeMs));
        assert.equal(found.command?.includes(marker), true);
        assert.equal(found.image, 'node.exe');
        assert.equal(readerChild?.stdout?.destroyed && readerChild.stderr?.destroyed, true);
        assert.ok(readerPid);
        assert.throws(() => process.kill(readerPid ?? 0, 0));
        await fs.promises.writeFile(release, '1');
        await closed;
      } finally {
        await fs.promises.writeFile(release, '1').catch(() => {});
        if (child.exitCode === null) child.kill();
        await closed;
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    }
  );
});

function capture(
  file: string,
  args: readonly string[],
  options: { maxBuffer: number; timeoutMs: number },
  observe: (child: ChildProcess) => void
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    observe(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let failed: Error | undefined;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > options.maxBuffer) {
        failed = new Error('stdout maxBuffer exceeded');
        child.kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > options.maxBuffer) {
        failed = new Error('stderr maxBuffer exceeded');
        child.kill();
        return;
      }
      stderr.push(chunk);
    });
    const timer = setTimeout(() => {
      failed ??= new Error('powershell timed out');
      child.kill();
    }, options.timeoutMs);
    child.once('error', (error) => {
      failed ??= error;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failed) reject(failed);
      else {
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          code: code ?? 1
        });
      }
    });
  });
}
