#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
function json(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function rows(dir) {
  return fs
    .readdirSync(dir)
    .filter((file) => /^observation-.*\.jsonl$/.test(file))
    .flatMap((file) => {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      requireThat(text.endsWith('\n'), 'truncated process evidence: ' + file);
      return text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    });
}
function knownIdentity(identity) {
  const source = identity?.source;
  const environment = identity?.environment;
  return (
    ['spans', 'resources'].includes(identity?.mode) &&
    ['warm', 'cold'].includes(identity?.cache) &&
    source &&
    ((source.kind === 'checkout' &&
      typeof source.sha === 'string' &&
      source.sha.length > 0 &&
      typeof source.content === 'string' &&
      source.content.length > 0 &&
      typeof source.dirty === 'boolean') ||
      (source.kind === 'archive' &&
        typeof source.tree === 'string' &&
        source.tree.length > 0 &&
        source.expected === source.tree)) &&
    environment &&
    ['node', 'npmVersion', 'platform', 'arch', 'osRelease', 'cpu', 'lock'].every(
      (key) => typeof environment[key] === 'string' && environment[key].length > 0
    ) &&
    Number.isInteger(environment.cores) &&
    environment.cores > 0 &&
    Number.isFinite(environment.memoryBytes) &&
    environment.memoryBytes > 0
  );
}
function read(dir) {
  const run = json(path.join(dir, 'runtime.json'));
  requireThat(run.schema === 1 && ['command', 'timed'].includes(run.kind), 'unsupported run');
  requireThat(
    run.outcome === 'passed' && run.exit === 0 && !run.unadmitted,
    'run did not complete successfully'
  );
  requireThat(
    run.sourceStable === true && knownIdentity(run.identity),
    'missing, malformed or changing source/toolchain identity'
  );
  requireThat(
    ['warm', 'cold'].includes(run.identity.cache),
    'cache condition must be explicitly labelled'
  );
  requireThat(
    ['spans', 'resources'].includes(run.identity.mode),
    'comparison needs recorded instrumentation'
  );
  requireThat(
    Number.isFinite(run.ms) &&
      run.ms >= 0 &&
      Number.isFinite(run.queueMs) &&
      run.queueMs >= 0 &&
      run.queueMs <= run.ms,
    'invalid wall/queue totals'
  );
  const events = rows(dir);
  const processes = new Map();
  for (const event of events) {
    requireThat(
      event.schema === 1 && typeof event.process === 'string',
      'unsupported process evidence'
    );
    const process = processes.get(event.process) ?? { starts: 0, ends: 0, terminal: null };
    if (event.type === 'process-start') {
      requireThat(event.mode === run.identity.mode, 'process instrumentation mode differs');
      process.starts++;
    }
    if (event.type === 'process-end') {
      process.ends++;
      process.terminal = event;
    }
    if (event.type === 'span') {
      requireThat(
        Number.isFinite(event.startMs) &&
          event.startMs >= 0 &&
          Number.isFinite(event.ms) &&
          event.ms >= 0 &&
          event.outcome !== 'incomplete',
        'incomplete or invalid span'
      );
    }
    processes.set(event.process, process);
  }
  requireThat(processes.size > 0, 'missing process evidence');
  for (const process of processes.values()) {
    requireThat(
      process.starts === 1 &&
        process.ends === 1 &&
        process.terminal.complete === true &&
        Number.isFinite(process.terminal.ms) &&
        process.terminal.ms >= 0 &&
        Number.isInteger(process.terminal.exit),
      'missing, duplicate or incomplete process terminal'
    );
  }
  for (const event of events.filter((row) => row.type === 'span'))
    requireThat(
      event.startMs + event.ms <= processes.get(event.process).terminal.ms + 0.1,
      'span exceeds process wall time'
    );
  const hosts = events
    .filter((row) => row.type === 'event' && row.name === 'smoke:host')
    .map((row) => row.details);
  requireThat(
    hosts.every((host) => typeof host.version === 'string' && host.version.length > 0),
    'unknown smoke host version'
  );
  const lifecycle = new Map();
  const selection = new Map();
  for (const event of events.filter((row) => row.type === 'event')) {
    if (event.name === 'run' || event.name === 'run:complete') {
      const key = JSON.stringify([event.process, event.details?.folder]);
      const count = lifecycle.get(key) ?? { start: 0, complete: 0 };
      if (event.name === 'run') count.start++;
      else count.complete++;
      lifecycle.set(key, count);
    }
    if (event.name === 'scope:start' || event.name === 'scope:selection') {
      const key = JSON.stringify([event.process, event.details?.owner]);
      const count = selection.get(key) ?? { start: 0, complete: 0 };
      if (event.name === 'scope:start') count.start++;
      else count.complete++;
      selection.set(key, count);
    }
  }
  requireThat(
    [...lifecycle.values(), ...selection.values()].every(
      (count) => count.start === 1 && count.complete === 1
    ),
    'missing or duplicate run/scope completion'
  );
  const nested = events
    .filter(
      (row) => row.type === 'event' && row.name === 'run:complete' && row.details.folder !== dir
    )
    .map((row) => row.details);
  for (const child of nested)
    requireThat(
      child.outcome === 'passed' &&
        child.sourceStable === true &&
        child.exit === 0 &&
        knownIdentity(child.identity),
      'nested run failed or source changed'
    );
  const scope = (child) => ({
    command: child.command,
    scope: child.scope,
    steps: child.steps?.map((step) => ({ name: step.name, outcome: step.outcome }))
  });
  return {
    dir,
    run,
    scope: {
      hosts,
      own: scope(run),
      nested: nested.map(scope),
      selections: events
        .filter((row) => row.type === 'event' && row.name === 'scope:selection')
        .map((row) => row.details),
      release: events
        .filter((row) => row.type === 'event' && row.name === 'release:stage')
        .map((row) => row.details),
      deploySource: events
        .filter((row) => row.type === 'event' && row.name === 'deploy:source')
        .map((row) => row.details),
      deploy: events
        .filter((row) => row.type === 'event' && row.name === 'deploy:identity')
        .map((row) => row.details)
    },
    identities: [run.identity, ...nested.map((child) => child.identity)],
    resources: [...processes.values()].map((process) => process.terminal.resources).filter(Boolean),
    diagnosticExits: [...processes.values()].filter((process) => process.terminal.exit !== 0).length
  };
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function summarize(a, b) {
  const deltas = b.map((value, i) => value - a[i]);
  return {
    baselineMedian: median(a),
    candidateMedian: median(b),
    pairedDeltaMedian: median(deltas),
    pairedDeltaMin: Math.min(...deltas),
    pairedDeltaMax: Math.max(...deltas)
  };
}
function main() {
  const args = process.argv.slice(2);
  requireThat(
    args.every((arg) => arg === '--allow-source-change' || /^--(baseline|candidate)=.+/.test(arg)),
    'unsupported option'
  );
  const group = (key) =>
    args
      .find((arg) => arg.startsWith('--' + key + '='))
      ?.split('=')
      .slice(1)
      .join('=')
      .split(',')
      .map(read) ?? [];
  const a = group('baseline');
  const b = group('candidate');
  requireThat(
    a.length >= 2 && a.length === b.length,
    'supply equal baseline/candidate groups of at least two runs in paired order'
  );
  const all = [...a, ...b];
  for (const item of all) {
    requireThat(same(item.scope, a[0].scope), 'requested/executed/reused scope differs');
    requireThat(item.identities.length === a[0].identities.length, 'nested run count differs');
    for (let i = 0; i < item.identities.length; i++)
      for (const key of ['environment', 'mode', 'cache'])
        requireThat(
          same(item.identities[i][key], a[0].identities[i][key]),
          'nested or wrapper ' + key + ' differs'
        );
  }
  const sources = (item) => item.identities.map((identity) => identity.source);
  for (const group of [a, b])
    requireThat(
      group.every((item) => same(sources(item), sources(group[0]))),
      'source changed within an experiment group'
    );
  requireThat(
    args.includes('--allow-source-change') || same(sources(a[0]), sources(b[0])),
    'source differs; explicitly allow the baseline/candidate source change'
  );
  const pairs = a.map((item, i) => ({
    baseline: item.dir,
    candidate: b[i].dir,
    baselineMs: item.run.ms,
    candidateMs: b[i].run.ms,
    baselineQueueMs: item.run.queueMs,
    candidateQueueMs: b[i].run.queueMs
  }));
  console.log(
    JSON.stringify(
      {
        pairs,
        wallMs: summarize(
          a.map((item) => item.run.ms),
          b.map((item) => item.run.ms)
        ),
        queueMs: summarize(
          a.map((item) => item.run.queueMs),
          b.map((item) => item.run.queueMs)
        ),
        executionMs: summarize(
          a.map((item) => item.run.ms - item.run.queueMs),
          b.map((item) => item.run.ms - item.run.queueMs)
        ),
        conditions: { baseline: a[0].identities, candidate: b[0].identities },
        resources: all.map((item) => ({
          run: item.dir,
          processes: item.resources,
          diagnosticExits: item.diagnosticExits
        })),
        limitations: [
          'Pair order is supplied by the experimenter; cache labels are declarations, not OS cache measurements.',
          'CPU and peak RSS cover registered Node processes only. Individual peaks are not a process-tree peak.',
          'Failed child exits may be expected diagnostics; command success remains the owning runner outcome.',
          'Load and background work require review. Timing evidence never authorizes checkpoint reuse.'
        ]
      },
      null,
      2
    )
  );
}
try {
  main();
} catch (error) {
  console.error(`compare-runtime: ${error.message}`);
  process.exitCode = 1;
}
