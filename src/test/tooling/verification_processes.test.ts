import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import * as roots from '../../../scripts/fixture-roots.cjs';
import { outRoot, repoRoot, testPlatform } from '../helpers';
import { preloadEnv } from '../fixtures/preload';

const BOOTSTRAP = path.join(repoRoot(), 'scripts/verification_processes.mjs');
const url = pathToFileURL(BOOTSTRAP).href;

describe('precompile verification process boundary', () => {
  it('keeps failed, truncated, denied and malformed native reads unknown', () => {
    const root = roots.create('sq-bootstrap-');
    try {
      for (const mode of ['timeout', 'overflow', 'truncated', 'denied', 'malformed']) {
        const preload = preloadEnv(
          root,
          `
          const cp=require('node:child_process');
          const run=cp.execFileSync;
          cp.execFileSync=(file,args,options)=>{
            if(${JSON.stringify(mode)}==='timeout') return run(process.execPath,['-e','setInterval(()=>{},1000)'],options);
            if(${JSON.stringify(mode)}==='overflow') return run(process.execPath,['-e',"process.stdout.write('x'.repeat(5*1024*1024))"],options);
            if(${JSON.stringify(mode)}==='truncated') return '23 1 134000000000000000';
            if(${JSON.stringify(mode)}==='denied') return '23 1 ?\\nend\\n';
            return '{broken';
          };`
        );
        const ran = cp.spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
          import * as p from ${JSON.stringify(url)};
          const s=p.snapshot();
          if(s.complete || s.rows.length || p.identity(23,s)) throw Error('unknown read established identity');
          console.log(s.reason);
        `
          ],
          { env: { ...process.env, ...roots.environment(root), ...preload }, encoding: 'utf8' }
        );
        assert.equal(ran.status, 0, ran.stderr);
        assert.match(
          ran.stdout,
          mode === 'timeout'
            ? /ETIMEDOUT/
            : mode === 'overflow'
              ? /ENOBUFS/
              : /incomplete|malformed|unavailable|invalid/,
          mode
        );
      }
    } finally {
      roots.remove(root);
    }
  });

  it('reads the native start clock and refuses cross-clock or stale member ending', () => {
    const root = roots.create('sq-native-');
    try {
      const ran = cp.spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import * as assert from 'node:assert/strict';
        import * as p from ${JSON.stringify(url)};
        const table=p.snapshot();assert.equal(table.complete,true,table.reason);
        const self=p.identity(process.pid,table);assert.ok(self);
        assert.equal(self.source,${JSON.stringify(testPlatform() === 'win32' ? 'win32-filetime-ms-v1' : 'ps-lstart-v1')});
        assert.equal(p.sameIdentity(self,{...self,source:'another-clock'}),false);
        assert.equal(p.end({...self,started:'stale'},'SIGTERM'),false);
        assert.equal(p.end({pid:-1},'SIGTERM'),false);
        const cp=await import('node:child_process');
        const child=cp.spawn(process.execPath,['-e',"process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
        const closed=new Promise(resolve=>child.once('close',resolve));
        try {
          await new Promise(resolve=>child.stdout.once('data',resolve));
          const member=p.identity(child.pid);assert.ok(member);
          assert.equal(p.end({...member,source:'another-clock'}),false);
          const stale={...member,started:typeof member.started==='number'?member.started+1:'Mon Jan  1 00:00:00 2001'};
          assert.equal(p.validIdentity(stale),true,'stale identity has a valid native clock');
          assert.equal(p.end(stale),false,'a reused PID does not authorize ending its current process');
          assert.equal(process.kill(child.pid,0),true,'unrelated process survives stale authority');
          assert.equal(p.end(member),true);
          await closed;
        } finally { if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL'); await closed; }
      `
        ],
        { env: { ...process.env, ...roots.environment(root) }, encoding: 'utf8' }
      );
      assert.equal(ran.status, 0, ran.stderr);
    } finally {
      roots.remove(root);
    }
  });

  it(
    'shares FILETIME flooring and bounds with the runtime identity contract',
    { skip: testPlatform() !== 'win32' && 'posix: Windows native clock contract' },
    () => {
      const root = roots.create('sq-clock-');
      try {
        const ticks = [
          '134374051838139320',
          '134374051838571739',
          '116444736000000000',
          '2650467743999999999'
        ];
        for (const tick of [...ticks, '116444735999999999', '2650467744000000000']) {
          const preload = preloadEnv(
            root,
            `require('node:child_process').execFileSync=()=>${JSON.stringify(`23 1 ${tick}\nend\n`)};`
          );
          const ran = cp.spawnSync(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              `
          import * as assert from 'node:assert/strict';
          import * as p from ${JSON.stringify(url)};
          import { filetimeToUnixMs } from ${JSON.stringify(pathToFileURL(path.join(outRoot(), 'core/platform/processes/index.js')).href)};
          const expected=filetimeToUnixMs(${JSON.stringify(tick)});
          const read=p.snapshot();
          if(expected===undefined) assert.equal(read.complete,false);
          else { assert.equal(read.complete,true,read.reason);assert.equal(read.rows[0].started,expected); }
        `
            ],
            { env: { ...process.env, ...roots.environment(root), ...preload }, encoding: 'utf8' }
          );
          assert.equal(ran.status, 0, ran.stderr);
        }
      } finally {
        roots.remove(root);
      }
    }
  );

  it('loads a clean two-file archive and resolves one account root across shells and moved homes', () => {
    const root = roots.create('sq-archive-');
    try {
      const outputs = new Set<string>();
      for (const clone of ['clone', 'archive']) {
        const dir = path.join(root, clone);
        fs.mkdirSync(dir);
        for (const file of ['checkpoints.mjs', 'verification_processes.mjs'])
          fs.copyFileSync(path.join(repoRoot(), 'scripts', file), path.join(dir, file));
        const script = path.join(dir, 'resolve.mjs');
        fs.writeFileSync(
          script,
          `
          import * as fs from 'node:fs';import * as path from 'node:path';
          import * as assert from 'node:assert/strict';
          import * as p from './verification_processes.mjs';
          import * as c from './checkpoints.mjs';
          assert.throws(()=>c.gateRoot({SQUADRON_GATE_DIR:'relative'}),/absolute/);
          assert.equal(c.gateRoot(),process.env.SQUADRON_GATE_DIR);
          const candidate=c.Candidate.create(path.join(process.cwd(),'candidates'),{runs:path.join(process.cwd(),'runs')});
          assert.equal(candidate.manifest.package.entries.length,2);
          console.log(p.accountGateRoot());
        `
        );
        const env = {
          ...process.env,
          ...roots.environment(root),
          SQUADRON_GATE_DIR: path.join(root, 'gate')
        };
        const routes = [{ command: process.execPath, args: [script] }];
        if (testPlatform() === 'win32') {
          routes.push({
            command: 'powershell.exe',
            args: [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `& '${process.execPath.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}'`
            ]
          });
          routes.push({
            command: process.env.ComSpec ?? 'cmd.exe',
            args: ['/d', '/s', '/c', `""${process.execPath}" "${script}""`]
          });
        } else
          routes.push({ command: 'sh', args: ['-c', '"$1" "$2"', 'sh', process.execPath, script] });
        for (const route of routes) {
          const ran = cp.spawnSync(route.command, route.args, {
            cwd: dir,
            env,
            encoding: 'utf8',
            timeout: 15000,
            windowsVerbatimArguments: route.command === (process.env.ComSpec ?? 'cmd.exe')
          });
          assert.equal(ran.status, 0, ran.stderr);
          outputs.add(ran.stdout.trim());
        }
        assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false);
        assert.equal(fs.existsSync(path.join(dir, 'out')), false);
        assert.equal(fs.existsSync(path.join(dir, 'dist')), false);
      }
      assert.equal(outputs.size, 1);
      const actual = [...outputs][0];
      assert.ok(actual && path.isAbsolute(actual));
      assert.equal(
        actual?.startsWith(root),
        false,
        'moved fixture home must not select production authority'
      );
    } finally {
      roots.remove(root);
    }
  });
});
