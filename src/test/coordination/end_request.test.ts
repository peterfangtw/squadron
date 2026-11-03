import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { before, it } from 'node:test';
import { promisify } from 'node:util';
import * as helpers from '../helpers';
import type { Session } from '../../core/model';
import { scanProcesses } from '../../core/scan';

const run = promisify(childProcess.execFile);
let home: string;

before(async () => {
  home = await helpers.tempHome();
});

it('squadron-end exits 5 when a member or self request cannot be written', async () => {
  const state = path.join(home, '.squadron');
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, 'requests'), 'not a directory');
  await helpers.writeLiveClaim(home);
  const table = await scanProcesses(true);
  const session: Session = {
    pid: process.pid,
    sessionId: 'caller',
    cwd: home,
    name: 'caller',
    status: 'idle',
    hasCommand: false,
    startedAt: table.starts.get(process.pid) ?? 10,
    updatedAt: 10,
    transcript: '',
    source: 'owned',
    windowId: 'w1'
  };
  const preload = path.join(home, 'board.cjs');
  await fs.writeFile(
    preload,
    `require(${JSON.stringify(path.join(helpers.outRoot(), 'cli/board.js'))}).loadBoard = async () => ` +
      `(${JSON.stringify({ ok: true, sessions: [session, { ...session, pid: 101, sessionId: 'other' }], claims: [] })});`
  );
  for (const self of [false, true]) {
    const result = await run(
      process.execPath,
      [
        '--require',
        preload,
        path.join(helpers.outRoot(), 'cli/end.js'),
        '--pid',
        String(session.pid),
        '--caller-session-id',
        self ? 'caller' : 'other',
        ...(self ? ['--self'] : ['--any'])
      ],
      { env: helpers.homeEnv(home) }
    ).then(
      () => {
        throw new Error('end unexpectedly succeeded');
      },
      (error: { code: number; stderr: string }) => error
    );
    assert.match(result.stderr, /could not write the request/);
    assert.equal(result.code, 5);
  }
});
