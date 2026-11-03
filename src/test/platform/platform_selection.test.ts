import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import { describe, it } from 'node:test';
import * as platform from '../../core/platform';
import * as results from '../../core/platform/unsupported';

describe('platform selection', () => {
  it('constructs only the selected backend, retaining legacy POSIX routing', () => {
    const calls: string[] = [];
    const backends = {
      darwin: () => calls.push('darwin'),
      win32: () => calls.push('win32'),
      posix: () => calls.push('posix')
    };
    const hosts: NodeJS.Platform[] = [
      'darwin',
      'win32',
      'linux',
      'freebsd',
      'openbsd',
      'sunos',
      'aix',
      'android'
    ];
    for (const host of hosts) platform.select(backends, host);
    assert.deepEqual(calls, [
      'darwin',
      'win32',
      'posix',
      'posix',
      'posix',
      'posix',
      'posix',
      'posix'
    ]);
  });

  it('uses a dedicated Linux factory without applying it to other POSIX hosts', () => {
    const calls: string[] = [];
    const backends = {
      darwin: () => calls.push('darwin'),
      win32: () => calls.push('win32'),
      linux: () => calls.push('linux'),
      posix: () => calls.push('unknown')
    };
    platform.select(backends, 'linux');
    platform.select(backends, 'freebsd');
    assert.deepEqual(calls, ['linux', 'unknown']);
  });

  it('retains explicit unsupported fallbacks for Darwin-only mechanisms', () => {
    for (const os of ['win32', 'linux', 'freebsd'] as const) {
      const backends = {
        darwin: (): results.Unsupported => {
          throw new Error('must not enable a Darwin hold');
        },
        win32: () => results.unsupported('power.hold', os, 'No hold backend — W7.1'),
        posix: () => results.unsupported('power.hold', os, 'No hold backend')
      };
      assert.deepEqual(platform.select(backends, os), {
        supported: false,
        reason: `power.hold is unavailable on ${os}: No hold backend${os === 'win32' ? ' — W7.1' : ''}`
      });
    }
  });

  it('imports and answers unsupported without starting any effects', () => {
    const output = cp.execFileSync(
      process.execPath,
      [
        '-e',
        `
      let effects = 0;
      const refuse = () => { effects++; throw new Error('unexpected platform effect'); };
      for (const module of ['node:child_process', 'node:fs/promises']) {
        const api = require(module);
        for (const key of Object.keys(api)) if (typeof api[key] === 'function') api[key] = refuse;
      }
      global.setTimeout = global.setInterval = global.setImmediate = refuse;
      const platform = require(${JSON.stringify(require.resolve('../../core/platform'))});
      const { unsupported } = require(${JSON.stringify(require.resolve('../../core/platform/unsupported'))});
      const answer = platform.select({
        darwin: refuse, posix: refuse,
        win32: () => () => unsupported('processes.snapshot', 'win32', 'No native reader — W3')
      }, 'win32')();
      console.log(JSON.stringify({ answer, effects }));
    `
      ],
      { encoding: 'utf8', timeout: 5000 }
    );
    assert.deepEqual(JSON.parse(output), {
      answer: {
        supported: false,
        reason: 'processes.snapshot is unavailable on win32: No native reader — W3'
      },
      effects: 0
    });
  });
});
