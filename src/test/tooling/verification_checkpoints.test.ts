import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import * as store from '../../../scripts/checkpoints.mjs';
import * as registry from '../smoke/scenarios';
import { needsFileSymlinks, repoRoot, testPlatform } from '../helpers';
import { preloadEnv } from '../fixtures/preload';
import { AFFECTED_SCRIPTS } from './affected_scripts';

const ROOT = repoRoot();
const clean = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith('SQUADRON_VERIFY_') &&
      !key.startsWith('SQUADRON_RUN') &&
      !key.startsWith('GIT_') &&
      key !== 'NODE_TEST_CONTEXT'
  )
);

async function storeProbe(body: string, preload = ''): Promise<void> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sq-store-')));
  try {
    const source = `import * as assert from 'node:assert/strict';
      import * as fs from 'node:fs'; import * as path from 'node:path';
      import * as cp from 'node:child_process';
      import * as store from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts/checkpoints.mjs')).href)};
      const root=${JSON.stringify(dir)};
      process.env.SQUADRON_GATE_DIR=path.join(root,'gate');
      const c=store.Candidate.create(path.join(root,'candidates'),{runs:path.join(root,'runs')}).take();
      ${body}`;
    const ran = cp.spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...clean, ...(preload ? preloadEnv(dir, preload) : {}) },
      encoding: 'utf8'
    });
    assert.equal(ran.status, 0, ran.stderr + ran.stdout);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('durable candidate checkpoints', () => {
  for (const failure of ['EBUSY', 'EPERM', 'EACCES', 'ENOSPC']) {
    it(`atomic replacement preserves the target and cleans its temporary after ${failure}`, async () => {
      await storeProbe(
        `
        const file=path.join(root,'atomic.json');
        store.atomic(file,'atomic-before');
        const began=Date.now();
        if(${JSON.stringify(failure)}==='EBUSY'&&${JSON.stringify(testPlatform() === 'win32')}) {
          store.atomic(file,'atomic-next');
          assert.equal(store.read(file),'atomic-next');
        } else {
          assert.throws(()=>store.atomic(file,'atomic-next'),error=>error.code===${JSON.stringify(failure)}&&error.message==='fixture atomic denied');
          assert.equal(store.read(file),'atomic-before');
        }
        const attempts=Number(fs.readFileSync(path.join(root,'atomic-attempts'),'utf8'));
        if(${JSON.stringify(failure)}==='EPERM'&&${JSON.stringify(testPlatform() === 'win32')}) {
          assert.ok(attempts>1,'transient Windows errors retry');
          assert.ok(Date.now()-began>=1900,'persistent denial exhausts the existing two-second bound');
        } else assert.equal(attempts,${JSON.stringify(failure === 'EBUSY' && testPlatform() === 'win32' ? 2 : 1)});
        assert.ok(Date.now()-began<5000,'failure cannot retry indefinitely');
        assert.equal(fs.readdirSync(root).some(name=>name.endsWith('.tmp')),false,'no orphaned temporary');
        c.release('passed');
      `,
        `
        const fs=require('node:fs'),path=require('node:path');
        const rename=fs.renameSync,write=fs.writeFileSync;
        let attempts=0;
        const denied=()=>Object.assign(Error('fixture atomic denied'),{code:${JSON.stringify(failure)}});
        fs.renameSync=function(from,to){
          if(path.basename(String(to))==='atomic.json'&&JSON.parse(fs.readFileSync(from,'utf8'))==='atomic-next') {
            write(path.join(path.dirname(to),'atomic-attempts'),String(++attempts));
            if(${JSON.stringify(failure)}!=='EBUSY'||attempts===1)throw denied();
          }
          return rename.apply(this,arguments);
        };
        fs.writeFileSync=function(fd,data){
          if(${JSON.stringify(failure)}==='ENOSPC'&&typeof fd==='number'&&String(data).includes('atomic-next')) {
            const root=path.dirname(process.env.SQUADRON_GATE_DIR);
            write(path.join(root,'atomic-attempts'),String(++attempts));
            write(fd,'partial');throw denied();
          }
          return write.apply(this,arguments);
        };
      `
      );
    });
  }
  for (const kind of ['candidate', 'metadata']) {
    it(`preserves replacement authority during ${kind} release`, async () => {
      await storeProbe(`
        let at, replacement;
        if(${JSON.stringify(kind)}==='candidate') {
          at=path.join(c.dir,'owner.json');replacement=store.read(at);
          replacement.gate=path.join(root,'replacement-gate');store.atomic(at,replacement);
          c.release('passed');
        } else {
          c.release('passed');
          store.locked(c.runs,()=>{
            at=path.join(c.runs,'.verification-lock','owner.json');replacement=store.read(at);
            replacement.generation++;store.atomic(at,replacement);
          });
        }
        assert.deepEqual(store.read(at),replacement,'release cannot remove replaced authority');
      `);
    });
  }
  it('retains a completed receipt across owners, refuses mismatches and competing writers', async () => {
    await storeProbe(`
      c.checkpoint('check:format',{scope:'all'},123);
      assert.throws(()=>new store.Candidate(c.dir).take(),/running|unknown/);
      c.release('interrupted');
      const next=new store.Candidate(c.dir).take();
      assert.equal(next.reuse('check:format',{scope:'all'}).ms,123);
      assert.equal(next.reuse('check:format',{scope:'other'}),undefined);
      next.release('passed');
    `);
  });
  it('binds authority to the intended workspace/stage and removes it from nested workers', async () => {
    await storeProbe(`
      Object.assign(process.env,c.context('check'));
      assert.equal(store.context('check'),undefined);
      process.chdir(c.workspace);
      assert.ok(store.context('check'));
      assert.equal(store.context('test:smoke'),undefined);
      assert.equal(store.cleanEnv(process.env).SQUADRON_VERIFY_CONTEXT,undefined);
      const at=path.join(c.dir,'owner.json'),owner=store.read(at);
      for(const replacement of [
        {...owner,version:2},
        {...owner,gate:path.join(root,'replacement-gate')},
        {...owner,token:'malformed'},
        {...owner,generation:owner.generation+1},
        {...owner,generation:undefined},
        null
      ]) {
        store.atomic(at,replacement);
        assert.throws(()=>store.context('check'),/owner|mismatch/);
      }
      store.atomic(at,owner);
      c.release('passed');
    `);
  });
  it('invalidates dependent results and repairs missing outputs despite retained build metadata', async () => {
    await storeProbe(`
      fs.mkdirSync(path.join(c.workspace,'out'));fs.mkdirSync(path.join(c.workspace,'dist'));
      fs.writeFileSync(path.join(c.workspace,'out','test.js'),'old');
      fs.writeFileSync(path.join(c.workspace,'tsconfig.tsbuildinfo'),'stale');
      c.built(); c.checkpoint('file:x',{},5);
      fs.rmSync(path.join(c.workspace,'out','test.js'));
      assert.equal(c.outputsMatch(),false);
      c.rebuild();
      assert.equal(c.reuse('file:x',{}),undefined);
      assert.equal(fs.existsSync(path.join(c.workspace,'tsconfig.tsbuildinfo')),false);
      assert.equal(fs.existsSync(path.join(c.workspace,'out')),false);
      c.release('passed');
    `);
  });
  it('keeps compact history when inactive candidate workspaces expire', async () => {
    await storeProbe(`
      c.checkpoint('check:format',{},10);c.release('failed');
      store.pruneCandidates(path.dirname(c.dir),c.runs,Date.now()+8*86400000);
      assert.equal(fs.existsSync(c.workspace),false);
      assert.ok(fs.readFileSync(path.join(c.dir,'history.jsonl'),'utf8').includes('expired'));
      assert.throws(()=>new store.Candidate(c.dir).take(),/expired/);
    `);
  });
});

describe('Node runner checkpoint integration', () => {
  it('executes only outstanding files on resume and gives nested workers no receipt authority', async () => {
    await storeProbe(`
      const scripts=path.join(c.workspace,'scripts');fs.mkdirSync(scripts);
      for(const name of ${JSON.stringify(AFFECTED_SCRIPTS)}) fs.copyFileSync(${JSON.stringify(path.join(ROOT, 'scripts'))}+'/'+name,path.join(scripts,name));
      fs.mkdirSync(path.join(c.workspace,'src/test'),{recursive:true});fs.mkdirSync(path.join(c.workspace,'out/test'),{recursive:true});
      fs.writeFileSync(path.join(root,'fail'),'yes');
      for(const name of ['a','b']) {
        fs.writeFileSync(path.join(c.workspace,'src/test',name+'.test.ts'),'');
        fs.writeFileSync(path.join(c.workspace,'out/test',name+'.test.js'),
          "const fs=require('node:fs');require('node:test').it('run',()=>{if(process.env.SQUADRON_VERIFY_CONTEXT)throw Error('leaked authority');fs.appendFileSync("+JSON.stringify(path.join(root,'calls'))+","+JSON.stringify(name)+");if("+JSON.stringify(name)+"==='b'&&fs.existsSync("+JSON.stringify(path.join(root,'fail'))+"))throw Error('red');});");
      }
      const env={...c.context('check'),npm_lifecycle_event:'check',SQUADRON_RUN:c.runs};
      await assert.rejects(c.run('tests',process.execPath,[path.join(scripts,'affected.mjs'),'--all'],env));
      fs.rmSync(path.join(root,'fail'));
      await c.run('tests',process.execPath,[path.join(scripts,'affected.mjs'),'--all'],env);
      const calls=fs.readFileSync(path.join(root,'calls'),'utf8');
      assert.equal([...calls].filter(x=>x==='a').length,1);
      assert.equal([...calls].filter(x=>x==='b').length,2);
      assert.ok(fs.readFileSync(path.join(c.dir,'history.jsonl'),'utf8').split(String.fromCharCode(10)).filter(Boolean).map(line=>JSON.parse(line)).some(row=>row.key==='node:src/test/b.test.ts'&&row.outcome==='failed'));
      c.release('passed');
    `);
  });
});

describe('checkpoint interruption and retention', () => {
  for (const kind of ['candidate', 'metadata']) {
    it(`retains malformed launch authority in a ${kind} record after its process exits`, async () => {
      await storeProbe(`
        c.release('passed');
        const child=cp.spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'ignore'});
        const closed=new Promise(resolve=>child.once('close',resolve));
        const native=store.processIdentity(child.pid);
        assert.notEqual(native.source,'unknown','fixture has an independent native start');
        child.kill();await closed;
        const owner={...native,gate:process.env.SQUADRON_GATE_DIR,root:c.runs,token:'malformed',generation:0};
        const at=${JSON.stringify(kind)}==='candidate'?path.join(c.dir,'owner.json'):path.join(c.runs,'.verification-lock','owner.json');
        fs.mkdirSync(path.dirname(at),{recursive:true});store.atomic(at,owner);
        let acted=false;
        assert.throws(()=>{
          if(${JSON.stringify(kind)}==='candidate')new store.Candidate(c.dir).take();
          else store.locked(c.runs,()=>{acted=true;});
        },/running|unknown|busy/);
        assert.equal(acted,false);
        assert.deepEqual(store.read(at),owner,'malformed authority must not be reaped');
      `);
    });
  }
  for (const mode of [
    'missing-publication',
    'publication-death',
    'incomplete-native',
    'replacement-job',
    'replacement-owner',
    'replacement-generation',
    'reused-pid'
  ]) {
    it(`retains candidate authority after ${mode} at acknowledgment`, async () => {
      await storeProbe(
        `
        const marker=path.join(root,'command-started');
        const bystander=cp.spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{stdio:'ignore'});
        const closed=new Promise(resolve=>bystander.once('close',resolve));
        try {
          await assert.rejects(c.run('boundary',process.execPath,['-e',
            'require("node:fs").writeFileSync('+JSON.stringify(marker)+',"started")']));
          assert.equal(fs.existsSync(marker),false);
          assert.equal(process.kill(bystander.pid,0),true,'unrelated process survives refusal');
          const owner=store.read(path.join(c.dir,'owner.json'));
          c.release('failed');
          assert.deepEqual(store.read(path.join(c.dir,'owner.json')),owner,'release preserves retained or replacement authority');
          assert.throws(()=>new store.Candidate(c.dir).take(),/running|unknown/);
          store.pruneCandidates(path.dirname(c.dir),c.runs,Date.now()+8*86400000);
          assert.equal(fs.existsSync(c.workspace),true);
        } finally {bystander.kill();await closed;}
      `,
        `
        const fs=require('node:fs'),cp=require('node:child_process');
        const mode=${JSON.stringify(mode)},rename=fs.renameSync,run=cp.execFileSync,spawn=cp.spawn;
        cp.execFileSync=function(command,args,options){
          if(mode==='incomplete-native'&&process.argv.includes('--job')&&(command==='powershell.exe'||command==='ps')) return '23 1 ?';
          return run.apply(this,arguments);
        };
        fs.renameSync=function(from,to){
          if(String(to).endsWith('.ready.json')) {
            if(mode==='missing-publication') process.exit(17);
            if(mode==='publication-death') {rename.apply(this,arguments);process.exit(17);}
            if(mode==='reused-pid') {
              const ready=JSON.parse(fs.readFileSync(from,'utf8'));
              ready.wrapper.started=typeof ready.wrapper.started==='number'?ready.wrapper.started+1:'Mon Jan  1 00:00:00 2001';
              fs.writeFileSync(from,JSON.stringify(ready));
            }
          }
          return rename.apply(this,arguments);
        };
        cp.spawn=function(command,args,options){
          const child=spawn.apply(this,arguments);
          if(args?.includes('--job')&&mode.startsWith('replacement-')) {
            const file=args[args.indexOf('--job')+1],send=child.send;
            child.send=function(message){
              const target=mode==='replacement-job'?file:JSON.parse(fs.readFileSync(file,'utf8')).authority.file;
              const value=JSON.parse(fs.readFileSync(target,'utf8'));if(mode!=='replacement-generation')value.token=require('node:crypto').randomUUID();value.generation++;
              fs.writeFileSync(target,JSON.stringify(value));
              return send.apply(this,arguments);
            };
          }
          return child;
        };
      `
      );
    });
  }
  for (const denied of [false, true]) {
    it(
      denied
        ? 'retains an ordinary shell descendant after a Windows running-state replace EPERM'
        : 'retains an ordinary shell descendant after writer death with an empty gate',
      {
        skip:
          denied &&
          testPlatform() !== 'win32' &&
          'posix: transient replacement retry is Windows only'
      },
      async () => {
        await storeProbe(`
      const sleep=()=>new Promise(resolve=>setTimeout(resolve,20));
      const until=async(check,label)=>{const end=Date.now()+15000;while(!check()){assert.ok(Date.now()<end,typeof label==='function'?label():label);await sleep();}};
      const worker=path.join(root,'worker.cjs'),parent=path.join(c.workspace,'parent.cjs');
      fs.writeFileSync(worker,
        'const fs=require("node:fs");fs.writeFileSync('+JSON.stringify(path.join(root,'worker-ready'))+',String(process.pid));'+
        'const end=Date.now()+25000;const timer=setInterval(()=>{if(fs.existsSync('+JSON.stringify(path.join(root,'release-worker'))+')||Date.now()>end)clearInterval(timer);},20);');
      fs.writeFileSync(parent,
        'const fs=require("node:fs"),cp=require("node:child_process");const child=cp.spawn(process.execPath,['+JSON.stringify(worker)+'],{stdio:"pipe"});'+
        'const end=Date.now()+25000;const timer=setInterval(()=>{if(fs.existsSync('+JSON.stringify(path.join(root,'release-parent'))+')||Date.now()>end){fs.writeFileSync('+JSON.stringify(path.join(root,'parent-ended'))+',"yes");process.exit(0);}},20);');
      const pin=path.join(c.runs,'survivor-run');fs.mkdirSync(pin);c.pin(pin);
      const dir=c.dir;
      c.release('passed');
      const driver=path.join(root,'writer.mjs');
      const module=${JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts/checkpoints.mjs')).href)};
      const shell=process.env.ComSpec||'/bin/sh';
      const command='node parent.cjs';
      fs.writeFileSync(driver,'import * as store from '+JSON.stringify(module)+';const c=new store.Candidate('+JSON.stringify(dir)+').take();c.pin('+JSON.stringify(pin)+');await c.run("ordinary shell",'+JSON.stringify(shell)+','+JSON.stringify(process.env.ComSpec?['/d','/s','/c',command]:['-c',command])+');');
      const preload=path.join(root,'observe.cjs');
      fs.writeFileSync(preload,'const fs=require("node:fs"),cp=require("node:child_process");const run=cp.execFileSync;cp.execFileSync=function(command,args,options){const file=process.argv[process.argv.indexOf("--job")+1];if(process.argv.includes("--job")&&fs.existsSync(file+".state.json")&&(command==="powershell.exe"||command==="ps")){const end=Date.now()+10000;while(!fs.existsSync('+JSON.stringify(path.join(root,'worker-ready'))+')){if(Date.now()>end)throw Error("fixture worker readiness deadline");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}return run.apply(this,arguments);};const rename=fs.renameSync;let denied=false;fs.renameSync=function(from,to){if(${JSON.stringify(denied)}&&!denied&&String(to).endsWith(".state.json")&&JSON.parse(fs.readFileSync(from,"utf8")).phase==="running"){denied=true;fs.writeFileSync('+JSON.stringify(path.join(root,'replace-denied'))+',"EPERM");throw Object.assign(Error("fixture running-state replacement denied"),{code:"EPERM"});}return rename.apply(this,arguments);};require("node:module").syncBuiltinESMExports();');
      const writer=cp.spawn(process.execPath,[driver],{env:{...process.env,NODE_OPTIONS:'--require='+JSON.stringify(preload)},stdio:'pipe'});
      writer.stdout.resume();let errors='';writer.stderr.on('data',chunk=>errors+=chunk);
      const closed=new Promise(resolve=>writer.once('close',resolve));
      const exited=new Promise(resolve=>writer.once('exit',resolve));
      let job,workerPid;
      try {
        await until(()=>fs.existsSync(path.join(root,'worker-ready')),()=>'worker ready: '+errors);
        workerPid=Number(fs.readFileSync(path.join(root,'worker-ready'),'utf8'));
        const workerWitness=store.processIdentity(workerPid);
        assert.notEqual(workerWitness.source,'unknown','worker has an independent native witness');
        await until(()=>{
          job=fs.readdirSync(dir).find(file=>/^job-[^.]+\\.json$/.test(file));
          const state=job&&store.read(path.join(dir,job+'.state.json'));
          return state?.phase==='running'&&state.members.some(member=>member.pid===workerPid&&member.source===workerWitness.source&&member.started===workerWitness.started);
        },()=>'owner independently adopts worker: '+errors);
        if(${JSON.stringify(denied)}) assert.equal(fs.readFileSync(path.join(root,'replace-denied'),'utf8'),'EPERM','fixture denied the running-state replacement');
        assert.equal(fs.readdirSync(dir).some(name=>name.endsWith('.tmp')),false,'successful publication leaves no temporary');
        assert.equal(process.kill(workerPid,0),true,'worker lives before writer death');
        writer.kill('SIGKILL');await exited;
        const wrapper=store.read(path.join(dir,job+'.ready.json')).wrapper;
        const current=store.processIdentity(wrapper.pid);
        if(current.source===wrapper.source&&current.started===wrapper.started)process.kill(wrapper.pid,'SIGKILL');
        await until(()=>{try{process.kill(wrapper.pid,0);return false;}catch{return true;}},'wrapper exits');
        fs.rmSync(path.join(dir,'owner.json'));
        assert.equal(fs.existsSync(path.join(process.env.SQUADRON_GATE_DIR,'holder')),false);
        assert.equal(process.kill(workerPid,0),true,'ordinary own-pipe descendant outlives writer and wrapper');
        assert.throws(()=>new store.Candidate(dir).take(),/running|unknown/);
        store.pruneCandidates(path.dirname(dir),c.runs,Date.now()+8*86400000);
        assert.equal(fs.existsSync(c.workspace),true);
        let pins;store.pruneRuns(c.runs,value=>pins=value);assert.equal(pins.has(pin),true);
      } finally {
        fs.writeFileSync(path.join(root,'release-parent'),'yes');fs.writeFileSync(path.join(root,'release-worker'),'yes');
        writer.kill('SIGKILL');await closed;
        if(workerPid) await until(()=>{try{process.kill(workerPid,0);return false;}catch{return true;}},'fixture worker closes');
      }
    `);
      }
    );
  }
  for (const phase of ['publication', 'acknowledgment']) {
    it(`does not dispatch a candidate command after ${phase} failure`, async () => {
      await storeProbe(
        `
        const marker=path.join(root,'command-started');
        await assert.rejects(c.run('boundary',process.execPath,['-e',
          'require("node:fs").writeFileSync('+JSON.stringify(marker)+',"started")']));
        assert.equal(fs.existsSync(marker),false,'command must wait for durable owner acknowledgment');
        const job=fs.readdirSync(c.dir).find(name=>/^job-[^.]+\\.json$/.test(name));
        assert.ok(job,'owner reserves the job before publication');
        assert.ok(fs.existsSync(path.join(c.dir,'publication-denied'))||store.read(path.join(c.dir,job+'.bound.json')),'fixture reaches publication or bound acknowledgment phase');
        c.release('failed');
        assert.throws(()=>new store.Candidate(c.dir).take(),/running|unknown/);
        store.pruneCandidates(path.dirname(c.dir),c.runs,Date.now()+8*86400000);
        assert.equal(fs.existsSync(c.workspace),true,'uncertain launch retains workspace');
      `,
        `
        const fs=require('node:fs'),cp=require('node:child_process');
        const rename=fs.renameSync;
        fs.renameSync=function(from,to){
          if(${JSON.stringify(phase)}==='publication'&&String(to).endsWith('.ready.json'))
            {fs.writeFileSync(require('node:path').join(require('node:path').dirname(to),'publication-denied'),'yes');throw Object.assign(Error('fixture publication denied'),{code:'EACCES'});}
          return rename.apply(this,arguments);
        };
        const spawn=cp.spawn;
        cp.spawn=function(command,args,options){
          const child=spawn.apply(this,arguments);
          if(${JSON.stringify(phase)}==='acknowledgment'&&args?.includes('--job'))
            child.send=()=>{throw Error('fixture acknowledgment disconnected');};
          return child;
        };
      `
      );
    });
  }
  it(
    'never queries or signals a Windows process group through either gate holder route',
    { skip: testPlatform() !== 'win32' && 'posix: gate holders retain process group checks' },
    async () => {
      await storeProbe(
        `
        c.release('interrupted');
        const gate=path.join(root,'gate');fs.mkdirSync(gate);
        process.env.SQUADRON_GATE_DIR=gate;
        const holder={pid:2147483647,pgid:2147483646,worktree:c.workspace};
        store.atomic(path.join(gate,'holder'),holder);
        assert.equal(c.workBusy(),true,'legacy holder identity remains unknown');
        assert.deepEqual(globalThis.negativePids,[],'workspace holder must not use a negative PID');
        holder.worktree=path.join(root,'dependency');
        store.atomic(path.join(gate,'holder'),holder);
        store.atomic(path.join(c.dir,'job-fixture.json'),{owner:{pid:2147483647},cwd:holder.worktree,gate});
        assert.equal(c.workBusy(),true,'legacy job identity remains unknown');
        assert.deepEqual(globalThis.negativePids,[],'job holder must not use a negative PID');
      `,
        `
        const kill=process.kill;
        globalThis.negativePids=[];
        process.kill=function(pid,signal) {
          if(pid<0) globalThis.negativePids.push([pid,signal]);
          if(pid<0 || pid===2147483647) throw Object.assign(Error('fixture absent'),{code:'ESRCH'});
          return kill.call(this,pid,signal);
        };
      `
      );
    }
  );
  for (const failure of ['EPERM', 'interruption']) {
    it(`retries partial workspace pruning after ${failure} without unpinning or admitting reuse`, async () => {
      await storeProbe(`
        c.release('failed');
        const run=path.join(c.runs,'retained-run');fs.mkdirSync(run);c.pin(run);
        fs.writeFileSync(path.join(c.workspace,'removed'),'partial');
        fs.writeFileSync(path.join(c.workspace,'survivor'),'retained');
        const ready=path.join(root,'cleanup-started');
        const preload=path.join(root,'remove-control.cjs');
        fs.writeFileSync(preload,
          "const fs=require('node:fs');const remove=fs.rmSync;fs.rmSync=function(target,...args){"+
          "if(target==="+JSON.stringify(c.workspace)+"){remove("+JSON.stringify(path.join(c.workspace,'removed'))+");"+
          "fs.writeFileSync("+JSON.stringify(ready)+",'ready');"+
          (${JSON.stringify(failure)}==='EPERM'
            ? "throw Object.assign(Error('fixture workspace removal denied'),{code:'EPERM'});"
            : "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);throw Error('fixture interruption deadline');")+
          "}return remove.call(this,target,...args);};require('node:module').syncBuiltinESMExports();");
        const source="import * as store from "+${JSON.stringify(JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts/checkpoints.mjs')).href))}+
          ";store.pruneCandidates("+JSON.stringify(path.dirname(c.dir))+","+JSON.stringify(c.runs)+",Date.now()+8*86400000);";
        const child=cp.spawn(process.execPath,['--require',preload,'--input-type=module','-e',source],{stdio:['ignore','ignore','pipe']});
        let stderr='';child.stderr.on('data',data=>stderr+=data);
        const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code));});
        try {
          const deadline=Date.now()+5000;
          while(!fs.existsSync(ready)) {
            assert.ok(Date.now()<deadline,'owner reaches workspace removal: '+stderr);
            await new Promise(resolve=>setTimeout(resolve,10));
          }
          if(${JSON.stringify(failure)}==='interruption') {
            assert.throws(()=>new store.Candidate(c.dir).take(),/busy|unknown|prun|cleanup/,'reuse waits for acknowledged cleanup');
            assert.throws(()=>store.pruneCandidates(path.dirname(c.dir),c.runs,Date.now()+8*86400000),/busy|unknown/,'competing prune waits for acknowledged cleanup');
            assert.equal(fs.existsSync(path.join(c.workspace,'survivor')),true,'held cleanup has not finished');
            child.kill('SIGKILL');
          }
          assert.notEqual(await closed,0,stderr);
          assert.equal(fs.existsSync(path.join(c.workspace,'removed')),false,'owner attempted partial deletion');
          assert.equal(fs.existsSync(path.join(c.workspace,'survivor')),true);
          const manifest=store.read(path.join(c.dir,'candidate.json'));
          assert.notEqual(manifest.expired,true,'failed cleanup is not successful expiry');
          assert.equal(manifest.pruning,true,'partial workspace stays unavailable and retryable');
          let pins;store.pruneRuns(c.runs,value=>pins=value);
          assert.equal(pins.has(run),true,'owner preserves the run pin');
          const history=()=>fs.readFileSync(path.join(c.dir,'history.jsonl'),'utf8').trim().split('\\n').map(line=>JSON.parse(line));
          assert.equal(history().some(row=>row.outcome==='expired'),false);
          if(${JSON.stringify(failure)}==='EPERM')
            assert.ok(history().some(row=>row.outcome==='cleanup-failed'&&row.code==='EPERM'&&row.error.includes('removal denied')));
          assert.throws(()=>new store.Candidate(c.dir).take(),/prun|cleanup/);
          store.pruneCandidates(path.dirname(c.dir),c.runs,c.manifest.created);
          assert.equal(fs.existsSync(c.workspace),false,'later owner prune completes deletion');
          store.pruneRuns(c.runs,value=>pins=value);
          assert.equal(pins.has(run),false);
          assert.equal(store.read(path.join(c.dir,'candidate.json')).expired,true);
          assert.equal(history().filter(row=>row.outcome==='expired').length,1);
          store.pruneCandidates(path.dirname(c.dir),c.runs,Date.now()+8*86400000);
          assert.equal(history().filter(row=>row.outcome==='expired').length,1);
          assert.throws(()=>new store.Candidate(c.dir).take(),/expired/);
        } finally {
          if(child.exitCode===null) child.kill('SIGKILL');
          await closed;
        }
      `);
    });
  }
  it(
    'refuses resume and expiry while a dead writer’s dependency child still owns the workspace',
    {
      skip: testPlatform() === 'win32' && 'win32: process group cancellation needs W4.2'
    },
    async () => {
      await storeProbe(`
      c.release('interrupted');
      const module=${JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts/checkpoints.mjs')).href)};
      const workerScript="require('node:fs').writeFileSync("+JSON.stringify(path.join(root,'ready'))+",'ready');setTimeout(()=>{},10000);";
      const writer=cp.spawn(process.execPath,['--input-type=module','-e',
        "import {Candidate} from "+JSON.stringify(module)+";const c=new Candidate("+JSON.stringify(c.dir)+").take();await c.run('dependencies',process.execPath,['-e',"+JSON.stringify(workerScript)+"]);"],{stdio:'ignore'});
      const until=async(fn)=>{const end=Date.now()+10000;while(!fn()){assert.ok(Date.now()<end,'child lifecycle completes');await new Promise(r=>setTimeout(r,20));}};
      let owner;
      try {
        await until(()=>fs.existsSync(path.join(root,'ready')));
        const exited=new Promise(r=>writer.once('exit',r));writer.kill('SIGKILL');await exited;
        assert.throws(()=>new store.Candidate(c.dir).take(),/running|unknown/);
        store.pruneCandidates(path.dirname(c.dir),c.runs,Date.now()+8*86400000);
        assert.equal(fs.existsSync(c.workspace),true);
        const file=fs.readdirSync(c.dir).find(f=>/^job-[^.]+\\.json$/.test(f));
        owner=store.read(path.join(c.dir,file+'.ready.json')).wrapper;
      } finally {
        if(owner) process.kill(-owner.pid,'SIGTERM');
        writer.kill('SIGKILL');
      }
      await until(()=>{try{process.kill(owner.pid,0);return false;}catch{return true;}});
      assert.equal(new store.Candidate(c.dir).busy(),true,'writer death has no confirmed closure');
      assert.throws(()=>new store.Candidate(c.dir).take(),/running|unknown/);
    `);
    }
  );
  it('uses the same exclusion for resume, pruning and pin changes', async () => {
    await storeProbe(`
      const run=path.join(c.runs,'run');fs.mkdirSync(run);
      c.pin(run);
      store.pruneRuns(c.runs,()=> {
        assert.throws(()=>store.pruneCandidates(path.dirname(c.dir),c.runs,Date.now()+8*86400000),/busy|unknown|EEXIST/);
        assert.throws(()=>c.pin(path.join(c.runs,'other')),/busy|unknown|EEXIST/);
      });
      let protectedRun=false;
      store.pruneRuns(c.runs,pins=>{protectedRun=pins.has(run);});
      assert.equal(protectedRun,true);
      c.release('failed');
    `);
  });
});

describe('checkpoint corruption controls', () => {
  it('never turns malformed, unknown or incomplete receipts into passing work', async () => {
    await storeProbe(`
      const file=path.join(c.dir,'receipts',store.digest('check:format')+'.json');
      for(const broken of ['{',JSON.stringify({schema:999}),JSON.stringify({schema:1,outcome:'started'})]) {
        c.checkpoint('check:format',{},10);
        fs.writeFileSync(file,broken);
        assert.equal(c.reuse('check:format',{}),undefined);
      }
      c.release('failed');
      const metadata=path.join(c.dir,'candidate.json');
      const value=store.read(metadata);value.schema=999;store.atomic(metadata,value);
      assert.throws(()=>new store.Candidate(c.dir),/unsupported/);
      store.pruneCandidates(path.dirname(c.dir),c.runs,Date.now()+8*86400000);
      assert.equal(fs.existsSync(c.workspace),true);
      const fresh=store.Candidate.create(path.dirname(c.dir),{runs:c.runs}).take();fresh.release('passed');
    `);
  });
});

describe('phase checkpoint integration', () => {
  it('reuses compile while retaining gate admission, and rebuilds after output damage', async () => {
    await storeProbe(`
      fs.mkdirSync(path.join(c.workspace,'scripts'));
      for(const name of ['checkpoints.mjs', 'verification_processes.mjs','timed.mjs','observation.mjs']) fs.copyFileSync(${JSON.stringify(path.join(ROOT, 'scripts'))}+'/'+name,path.join(c.workspace,'scripts',name));
      fs.writeFileSync(path.join(c.workspace,'build.cjs'),"const fs=require('node:fs');fs.appendFileSync("+JSON.stringify(path.join(root,'builds'))+",'b');fs.mkdirSync('out',{recursive:true});fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('out/main.js','built');fs.writeFileSync('tsconfig.tsbuildinfo','retained');");
      fs.writeFileSync(path.join(c.workspace,'test.cjs'),"const fs=require('node:fs');if(fs.existsSync("+JSON.stringify(path.join(root,'fail'))+"))process.exitCode=1;");
      const gate=path.join(root,'gate');fs.mkdirSync(gate);
      const env={...c.context('check'),npm_lifecycle_event:'check',SQUADRON_GATE_DIR:gate,SQUADRON_GATE_TIMEOUT_MS:'50'};
      const args=[path.join(c.workspace,'scripts/timed.mjs'),'compile=node build.cjs','test=node test.cjs'];
      fs.writeFileSync(path.join(root,'fail'),'yes');
      await assert.rejects(c.run('check',process.execPath,args,env));
      fs.rmSync(path.join(root,'fail'));
      store.atomic(path.join(gate,'holder'),{pid:process.pid,script:'fixture',worktree:root});
      await assert.rejects(c.run('check',process.execPath,args,env),/exit 75/);
      fs.rmSync(path.join(gate,'holder'));
      await c.run('check',process.execPath,args,env);
      assert.equal(fs.readFileSync(path.join(root,'builds'),'utf8'),'b');
      fs.rmSync(path.join(c.workspace,'out/main.js'));
      await c.run('check',process.execPath,args,env);
      assert.equal(fs.readFileSync(path.join(root,'builds'),'utf8'),'bb');
      assert.equal(fs.readFileSync(path.join(c.workspace,'out/main.js'),'utf8'),'built');
      c.release('passed');
    `);
  });
});

describe('retained runner integrity and elapsed timing', () => {
  it(
    'refuses a linked helper even when its target has the expected bytes',
    { skip: needsFileSymlinks() },
    async () => {
      await storeProbe(`
      const helper=path.join(c.dir,'verification_processes.mjs');
      const target=path.join(root,'outside.mjs');fs.copyFileSync(helper,target);
      fs.rmSync(helper);fs.symlinkSync(target,helper);
      await assert.rejects(c.run('linked',process.execPath,['-e','']),/regular files/);
      const ran=cp.spawnSync(process.execPath,[path.join(c.dir,'runner.mjs'),'--job','unused'],{encoding:'utf8',env:process.env});
      assert.notEqual(ran.status,0);assert.match(ran.stderr,/regular files/);
      fs.rmSync(helper);fs.copyFileSync(target,helper);c.release('failed');
    `);
    }
  );
  it('validates both package files before dispatch or loading a candidate helper', async () => {
    await storeProbe(`
      const helper=path.join(c.dir,'verification_processes.mjs');
      assert.equal(fs.existsSync(helper),true,'candidate must retain its bootstrap bytes');
      const original=fs.readFileSync(helper);
      const marker=path.join(root,'should-not-load');
      c.checkpoint('package-control',{},1);
      c.pin(path.join(root,'retained-run'));
      const job=path.join(c.dir,'job-control.json');
      store.atomic(job,{cwd:c.workspace,command:process.execPath,args:['-e',"require('node:fs').writeFileSync("+JSON.stringify(marker)+",'dispatched')"]});
      for(const damage of ['changed','missing','extra','legacy']) {
        const manifest=fs.readFileSync(path.join(c.dir,'candidate.json'));
        if(damage==='changed') fs.writeFileSync(helper,"require('node:fs').writeFileSync("+JSON.stringify(marker)+",'loaded');");
        if(damage==='missing') fs.rmSync(helper);
        if(damage==='extra') {const m=JSON.parse(manifest);m.package.entries.push(['extra.mjs','0'.repeat(64)]);store.atomic(path.join(c.dir,'candidate.json'),m);}
        if(damage==='legacy') {const m=JSON.parse(manifest);delete m.package;store.atomic(path.join(c.dir,'candidate.json'),m);}
        await assert.rejects(c.run('child',process.execPath,['-e','']),/package|snapshot|manifest/);
        assert.throws(()=>c.reuse('package-control',{}),/package|snapshot|manifest/);
        const ran=cp.spawnSync(process.execPath,[path.join(c.dir,'runner.mjs'),'--job',job],{encoding:'utf8',env:process.env});
        assert.notEqual(ran.status,0,damage);
        assert.match(ran.stderr,/package|snapshot|manifest/,damage);
        assert.equal(fs.existsSync(marker),false,damage);
        if(damage==='legacy') {
          store.pruneCandidates(path.dirname(c.dir),c.runs,Date.now()+8*86400000);
          assert.equal(fs.existsSync(c.workspace),true);
          assert.equal(fs.existsSync(path.join(c.runs,'.verification-pins',c.manifest.id+'.json')),true);
        }
        fs.writeFileSync(helper,original);fs.writeFileSync(path.join(c.dir,'candidate.json'),manifest);
      }
      await c.run('intact',process.execPath,['-e','']);
      c.release('passed');
    `);
  });
  it('refuses a changed runner snapshot before it can dispatch a child', async () => {
    await storeProbe(`
      fs.appendFileSync(path.join(c.dir,'runner.mjs'),'changed');
      const marker=path.join(root,'should-not-run');
      await assert.rejects(c.run('child',process.execPath,['-e',"require('node:fs').writeFileSync("+JSON.stringify(marker)+",'bad');"]),/runner snapshot/);
      assert.equal(fs.existsSync(marker),false);
      c.release('failed');
    `);
  });
  it('records positive elapsed time even if the wall clock moves backward', async () => {
    await storeProbe(`
      let wall=Date.now();Date.now=()=>{wall-=1000;return wall;};
      await c.run('clock',process.execPath,['-e','setTimeout(()=>{},30)']);
      c.release('passed');
      const rows=fs.readFileSync(path.join(c.dir,'history.jsonl'),'utf8').trim().split(String.fromCharCode(10)).map(line=>JSON.parse(line));
      assert.ok(rows.filter(row=>row.ms!==undefined).every(row=>row.ms>0));
    `);
  });
});

const smokeOwnershipSkip: false | string =
  testPlatform() === 'win32' &&
  'win32: smoke ownership reads /bin/ps and uses /tmp and a unix socket — W8.7';

const firstScenario = registry.scenarios[0];
const secondScenario = registry.scenarios[1];
const thirdScenario = registry.scenarios[2];
if (!firstScenario || !secondScenario || !thirdScenario)
  throw new Error('smoke registry is shorter than three scenarios');

const helperBoot = [
  "const {describe,it,after}=require('node:test');",
  "const fs=require('node:fs');",
  "function caller(){for(const line of (new Error().stack||'').split('\\n')){const match=/\\((.*):\\d+:\\d+\\)/.exec(line);if(match&&!match[1].endsWith('/boot.js'))return match[1];}}",
  "function remember(name){const record=process.env.SQUADRON_SMOKE_REGISTRATION;if(!record)return;let rows=[];try{rows=JSON.parse(fs.readFileSync(record,'utf8'));}catch(e){rows=[];}if(!Array.isArray(rows))rows=[];rows.push({file:caller(),name});fs.writeFileSync(record,JSON.stringify(rows));}",
  'exports.section=(name,body)=>{remember(name);describe(name,body);};',
  'exports.step=(name,fn)=>it(name,fn);',
  "exports.failRoot=()=>after(()=>{throw new Error('root');});",
  ''
].join('\n');
const passStub = `const boot=require('./boot.js');boot.section('pass one',()=>boot.step('green',()=>{}));boot.section('pass two',()=>boot.step('green too',()=>{}));`;
const failStub = `const boot=require('./boot.js');const fs=require('node:fs');boot.section('fail one',()=>boot.step('green',()=>{}));boot.section('fail two',()=>boot.step('later',()=>{if(fs.existsSync(process.env.FAIL))throw new Error('red');}));`;
const rootStub = `const boot=require('./boot.js');boot.section('hook one',()=>boot.step('green',()=>{}));boot.section('hook two',()=>boot.step('green too',()=>{}));boot.failRoot();`;
const remoteStub = [
  "const fs=require('node:fs');",
  "const {before,after}=require('node:test');",
  'const ownership=require(process.env.OWNERSHIP);',
  "const boot=require('./boot.js');",
  'let connection;',
  'before(async()=>{connection=await ownership.connectWorker();fs.mkdirSync(connection.paths.home,{recursive:true});});',
  'after(async()=>{if(connection)await connection.release();});',
  "boot.section('first',()=>boot.step('green',()=>{fs.appendFileSync(process.env.CALLS,'remote-first\\n');}));",
  "boot.section('second',()=>boot.step('later',()=>{fs.appendFileSync(process.env.CALLS,'remote-second\\n');if(fs.existsSync(process.env.FAIL))throw new Error('red');}));",
  ''
].join('\n');
const loader = [
  "const fs=require('node:fs');",
  "const {before,after}=require('node:test');",
  'const registry=require(process.env.REGISTRY);',
  'const ownership=require(process.env.OWNERSHIP);',
  'const selection=registry.scenarioSelection(process.env.SQUADRON_SMOKE_ENTRIES?JSON.parse(process.env.SQUADRON_SMOKE_ENTRIES):undefined);',
  "fs.appendFileSync(process.env.CALLS,JSON.stringify({pid:process.pid,selection,socket:process.env.SQUADRON_SMOKE_SOCKET})+'\\n');",
  'let connection;',
  'before(async()=>{connection=await ownership.connectWorker();fs.mkdirSync(connection.paths.home,{recursive:true});});',
  'after(async()=>{',
  '  if(!connection)return;',
  '  if(process.env.LOCK_ROOT){',
  "    fs.appendFileSync(process.env.CALLS,'root '+connection.paths.root+'\\n');",
  "    require('node:child_process').execFileSync('chflags',['uchg',connection.paths.root]);",
  '  }',
  '  await connection.release();',
  '});',
  "for(const name of selection)require('./'+name);",
  ''
].join('\n');

type SmokeLoad = { pid: number; selection: string[]; socket: string };

function smokeLoads(text: string): SmokeLoad[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as SmokeLoad);
}

function barrelInputs(): { files: string[]; flags: string[] } {
  return { files: registry.scenarios.map((name) => `${name}.js`), flags: [] };
}

async function receiptMap(dir: string): Promise<Map<string, { key?: string; outcome?: string }>> {
  const folder = path.join(dir, 'receipts');
  const map = new Map<string, { key?: string; outcome?: string }>();
  const names = await fs.readdir(folder).catch(() => [] as string[]);
  for (const name of names) {
    const row = JSON.parse(await fs.readFile(path.join(folder, name), 'utf8')) as {
      key?: string;
      outcome?: string;
    };
    if (row.key) map.set(row.key, row);
  }
  return map;
}

async function historyRows(dir: string): Promise<Array<Record<string, unknown>>> {
  const text = await fs.readFile(path.join(dir, 'history.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function ownedCandidate(): Promise<{ root: string; candidate: store.Candidate }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sq-smoke-ckpt-')));
  process.env.SQUADRON_GATE_DIR = path.join(root, 'gate');
  const candidate = store.Candidate.create(path.join(root, 'candidates'), {
    runs: path.join(root, 'runs')
  }).take();
  await fs.mkdir(path.join(candidate.workspace, 'scripts'), { recursive: true });
  await fs.copyFile(
    path.join(ROOT, 'scripts/checkpoint-reporter.mjs'),
    path.join(candidate.workspace, 'scripts/checkpoint-reporter.mjs')
  );
  await fs.mkdir(path.join(candidate.dir, 'smoke-run'), { recursive: true });
  return { root, candidate };
}

function smokeEnv(calls: string, fail: string, lock = false): NodeJS.ProcessEnv {
  return {
    CALLS: calls,
    FAIL: fail,
    REGISTRY: path.join(ROOT, 'out/test/smoke/scenarios.js'),
    OWNERSHIP: path.join(ROOT, 'out/test/smoke/ownership.js'),
    ...(lock ? { LOCK_ROOT: '1' } : {})
  };
}

async function runSmokeChild(
  candidate: store.Candidate,
  entry: string,
  stage: string,
  extra: NodeJS.ProcessEnv
): Promise<{ status: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const child = cp.spawn(process.execPath, [path.join(ROOT, 'out/test/smoke/runner.js'), entry], {
    cwd: candidate.workspace,
    env: {
      ...clean,
      ...candidate.context(stage),
      npm_lifecycle_event: stage,
      SQUADRON_RUN: path.join(candidate.dir, 'smoke-run'),
      ...extra
    }
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const status = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`smoke runner exceeded 45s\n${stderr}\n${stdout}`));
    }, 45_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
  return { status, stdout, stderr };
}

describe('smoke runner checkpoint lifecycle', { skip: smokeOwnershipSkip, concurrency: 1 }, () => {
  it(
    'resumes only outstanding scenario files on one fresh supervisor and reruns Remote alone',
    { timeout: 120_000 },
    async () => {
      const { root, candidate } = await ownedCandidate();
      const calls = path.join(root, 'calls');
      const remoteCalls = path.join(root, 'remote-calls');
      const fail = path.join(root, 'fail');
      const entry = path.join(candidate.workspace, 'e2e.js');
      try {
        await fs.writeFile(calls, '');
        await fs.writeFile(fail, 'yes');
        await fs.writeFile(path.join(candidate.workspace, 'boot.js'), helperBoot);
        await fs.writeFile(entry, loader);
        await fs.writeFile(path.join(candidate.workspace, `${firstScenario}.js`), passStub);
        await fs.writeFile(path.join(candidate.workspace, `${secondScenario}.js`), failStub);
        const inputs = barrelInputs();
        for (const name of registry.scenarios)
          if (name !== firstScenario && name !== secondScenario)
            candidate.checkpoint(`smoke:${name}.js`, inputs, 5);

        const red = await runSmokeChild(candidate, entry, 'test:smoke', smokeEnv(calls, fail));
        assert.notEqual(red.status, 0, red.stderr);
        const opened = smokeLoads(await fs.readFile(calls, 'utf8'));
        assert.equal(opened.length, 1, `${red.stderr}\n${red.stdout}`);
        const firstLoad = opened[0];
        assert.ok(firstLoad);
        assert.deepEqual(firstLoad.selection, [firstScenario, secondScenario]);
        const scope = JSON.parse(
          await fs.readFile(path.join(candidate.dir, 'smoke-run/smoke-scope.json'), 'utf8')
        ) as { executed: string[]; reused: string[] };
        assert.deepEqual(scope.executed, [firstScenario + '.js', secondScenario + '.js']);
        assert.ok(scope.reused.every((file) => !path.isAbsolute(file)));

        let receipts = await receiptMap(candidate.dir);
        assert.equal(receipts.size, registry.scenarios.length - 1);
        assert.equal(receipts.get(`smoke:${firstScenario}.js`)?.outcome, 'passed');
        assert.equal(receipts.has(`smoke:${secondScenario}.js`), false);
        const failed = (await historyRows(candidate.dir)).filter(
          (row) => row.key === `smoke:${secondScenario}.js` && row.outcome === 'failed'
        );
        assert.equal(failed.length, 1);
        assert.equal(failed[0]?.cleanup, 'confirmed');

        await fs.rm(fail);
        const again = await runSmokeChild(candidate, entry, 'test:smoke', smokeEnv(calls, fail));
        assert.equal(again.status, 0, `${again.stderr}\n${again.stdout}`);
        const resumed = smokeLoads(await fs.readFile(calls, 'utf8'));
        assert.equal(resumed.length, 2, `${again.stderr}\n${again.stdout}`);
        const secondLoad = resumed[1];
        assert.ok(secondLoad);
        assert.deepEqual(secondLoad.selection, [secondScenario]);
        assert.notEqual(secondLoad.pid, firstLoad.pid);
        assert.notEqual(secondLoad.socket, firstLoad.socket);
        receipts = await receiptMap(candidate.dir);
        assert.equal(receipts.get(`smoke:${secondScenario}.js`)?.outcome, 'passed');
        assert.equal(receipts.size, registry.scenarios.length);

        const settled = await fs.readFile(calls, 'utf8');
        const done = await runSmokeChild(candidate, entry, 'test:smoke', smokeEnv(calls, fail));
        assert.equal(done.status, 0, `${done.stderr}\n${done.stdout}`);
        assert.equal(await fs.readFile(calls, 'utf8'), settled);

        const remote = path.join(candidate.workspace, 'remote_panel.smoke.js');
        await fs.writeFile(remote, remoteStub);
        await fs.writeFile(fail, 'yes');
        await fs.writeFile(remoteCalls, '');
        const remoteRed = await runSmokeChild(
          candidate,
          remote,
          'test:smoke:one',
          smokeEnv(remoteCalls, fail)
        );
        assert.notEqual(remoteRed.status, 0, `${remoteRed.stderr}\n${remoteRed.stdout}`);
        assert.equal(await fs.readFile(calls, 'utf8'), settled);
        assert.equal(await fs.readFile(remoteCalls, 'utf8'), 'remote-first\nremote-second\n');
        assert.equal((await receiptMap(candidate.dir)).has('smoke:remote_panel.smoke.js'), false);
        const remoteFailed = (await historyRows(candidate.dir)).filter(
          (row) => row.key === 'smoke:remote_panel.smoke.js' && row.outcome === 'failed'
        );
        assert.equal(remoteFailed.length, 1);
        assert.equal(remoteFailed[0]?.cleanup, 'confirmed');

        await fs.rm(fail);
        const remoteGreen = await runSmokeChild(
          candidate,
          remote,
          'test:smoke:one',
          smokeEnv(remoteCalls, fail)
        );
        assert.equal(remoteGreen.status, 0, `${remoteGreen.stderr}\n${remoteGreen.stdout}`);
        assert.equal(
          await fs.readFile(remoteCalls, 'utf8'),
          'remote-first\nremote-second\nremote-first\nremote-second\n'
        );
        assert.equal(await fs.readFile(calls, 'utf8'), settled);
        assert.equal(
          (await receiptMap(candidate.dir)).get('smoke:remote_panel.smoke.js')?.outcome,
          'passed'
        );
      } finally {
        candidate.release('passed');
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  );

  it('promotes no scenario when a loaded file root hook fails', { timeout: 60_000 }, async () => {
    const { root, candidate } = await ownedCandidate();
    const calls = path.join(root, 'calls');
    const entry = path.join(candidate.workspace, 'e2e.js');
    try {
      await fs.writeFile(calls, '');
      await fs.writeFile(path.join(candidate.workspace, 'boot.js'), helperBoot);
      await fs.writeFile(entry, loader);
      await fs.writeFile(path.join(candidate.workspace, `${firstScenario}.js`), passStub);
      await fs.writeFile(path.join(candidate.workspace, `${secondScenario}.js`), rootStub);
      const inputs = barrelInputs();
      for (const name of registry.scenarios)
        if (name !== firstScenario && name !== secondScenario)
          candidate.checkpoint(`smoke:${name}.js`, inputs, 5);
      const ran = await runSmokeChild(
        candidate,
        entry,
        'test:smoke',
        smokeEnv(calls, path.join(root, 'none'))
      );
      assert.notEqual(ran.status, 0, `${ran.stderr}\n${ran.stdout}`);
      const receipts = await receiptMap(candidate.dir);
      assert.equal(receipts.size, registry.scenarios.length - 2);
      assert.equal(receipts.has(`smoke:${firstScenario}.js`), false);
      assert.equal(receipts.has(`smoke:${secondScenario}.js`), false);
      assert.equal(receipts.get(`smoke:${thirdScenario}.js`)?.outcome, 'passed');
      const kept = (await historyRows(candidate.dir)).filter(
        (row) => row.key === `smoke:${firstScenario}.js` && row.outcome !== 'reused'
      );
      assert.equal(kept.length, 1);
      assert.notEqual(kept[0]?.outcome, 'passed');
      assert.equal(kept[0]?.cleanup, 'confirmed');
    } finally {
      candidate.release('failed');
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it(
    'keeps a passing body when supervisor cleanup fails',
    {
      timeout: 60_000,
      skip:
        testPlatform() !== 'darwin' &&
        'win32, linux: macOS uchg is what makes the supervisor rm fail'
    },
    async () => {
      const { root, candidate } = await ownedCandidate();
      const calls = path.join(root, 'calls');
      const entry = path.join(candidate.workspace, 'e2e.js');
      try {
        await fs.writeFile(calls, '');
        await fs.writeFile(path.join(candidate.workspace, 'boot.js'), helperBoot);
        await fs.writeFile(entry, loader);
        await fs.writeFile(path.join(candidate.workspace, `${firstScenario}.js`), passStub);
        const inputs = barrelInputs();
        for (const name of registry.scenarios)
          if (name !== firstScenario) candidate.checkpoint(`smoke:${name}.js`, inputs, 5);
        const ran = await runSmokeChild(
          candidate,
          entry,
          'test:smoke',
          smokeEnv(calls, path.join(root, 'none'), true)
        );
        assert.notEqual(ran.status, 0, `${ran.stderr}\n${ran.stdout}`);
        const receipts = await receiptMap(candidate.dir);
        assert.equal(receipts.has(`smoke:${firstScenario}.js`), false);
        assert.equal(receipts.get(`smoke:${secondScenario}.js`)?.outcome, 'passed');
        const kept = (await historyRows(candidate.dir)).filter(
          (row) => row.key === `smoke:${firstScenario}.js` && row.outcome !== 'reused'
        );
        assert.equal(kept.length, 1);
        assert.equal(kept[0]?.outcome, 'passed');
        assert.equal(kept[0]?.cleanup, 'unconfirmed');
      } finally {
        const text = await fs.readFile(calls, 'utf8').catch(() => '');
        for (const line of text.split('\n')) {
          if (!line.startsWith('root ')) continue;
          const smokeRoot = line.slice('root '.length);
          try {
            cp.execFileSync('chflags', ['-R', 'nouchg', smokeRoot]);
          } catch {
            /* already clear, or the root was never locked */
          }
          await fs.rm(smokeRoot, { recursive: true, force: true });
        }
        candidate.release('failed');
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  );
});
