import * as fs from 'node:fs';
import * as path from 'node:path';

/** Node 23 summaries can say success after a root hook failed, including one in a helper. */
export function fileResults(file, entries, barrel = null, registration = null) {
  const unknown = (reason) =>
    entries.map((file) => ({ file, outcome: 'incomplete', ms: 0, reason }));
  let events;
  try {
    events = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .slice(0, -1)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return unknown('missing or malformed lifecycle evidence');
  }
  const paths = new Map();
  const canon = (file) => {
    if (paths.has(file)) return paths.get(file);
    let result;
    try {
      result = fs.realpathSync(file);
    } catch {
      result = path.resolve(file);
    }
    paths.set(file, result);
    return result;
  };
  const rows = new Map(
    entries.map((file) => [
      canon(file),
      {
        file,
        roots: 0,
        failed: false,
        worker: false,
        summary: false,
        seen: false,
        ms: 0,
        workerMs: undefined
      }
    ])
  );
  let infrastructure = false;
  let barrelWorker = false;
  let barrelSummary = false;
  // describe/it in boot.js are reported on boot.js. The registration names the scenario that called them.
  const tracked = new Map();
  const byName = new Map();
  if (Array.isArray(registration)) {
    for (const item of registration) {
      if (!item || typeof item.file !== 'string' || typeof item.name !== 'string')
        return unknown('unsupported registration record');
      const at = canon(item.file);
      const row = rows.get(at);
      if (!row) continue;
      if (byName.has(item.name)) return unknown('duplicate smoke section name');
      const slot = { seen: false, passed: false };
      const list = tracked.get(at) ?? [];
      list.push(slot);
      tracked.set(at, list);
      byName.set(item.name, { at, slot });
      row.seen = true;
    }
  }
  for (const event of events) {
    if (!event || typeof event.type !== 'string' || !event.data)
      return unknown('unsupported lifecycle record');
    const { type, data } = event;
    if (!data.file) {
      if (type === 'test:fail') infrastructure = true;
      continue;
    }
    const at = canon(data.file);
    const row = rows.get(at);
    if (row) row.seen = true;
    const wrapper =
      data.line === 1 &&
      data.column === 1 &&
      typeof data.name === 'string' &&
      canon(data.name) === at;
    if (type === 'test:complete') {
      if (wrapper) {
        if (row) {
          row.worker = data.details?.passed === true;
          row.workerMs = data.details?.duration_ms;
        }
        if (barrel && at === canon(barrel))
          barrelWorker =
            data.details?.passed === true ||
            (data.details?.error?.failureType === 'subtestsFailed' &&
              data.details.error.exitCode === 1 &&
              !data.details.error.signal);
      } else if (
        byName.get(data.name) &&
        data.nesting === 0 &&
        data.details?.type === 'suite' &&
        path.basename(at) === 'boot.js'
      ) {
        const section = byName.get(data.name);
        section.slot.seen = true;
        section.slot.passed = data.details.passed === true;
        const owner = rows.get(section.at);
        if (owner) {
          owner.roots++;
          owner.ms += data.details.duration_ms ?? 0;
          if (!section.slot.passed) owner.failed = true;
        }
      } else if (row && data.nesting === 0) {
        row.roots++;
        row.ms += data.details?.duration_ms ?? 0;
        if (data.details?.passed !== true) row.failed = true;
      }
    }
    if (type === 'test:fail') {
      if (row) row.failed = true;
      const rootHook = data.details?.error?.failureType === 'hookFailed' && !data.details?.type;
      const helper = Array.isArray(registration) && path.basename(at) === 'boot.js';
      if (!data.file || rootHook || (!row && !helper)) infrastructure = true;
    }
    if (type === 'test:summary') {
      if (row) row.summary = true;
      if (barrel && at === canon(barrel)) barrelSummary = true;
    }
  }
  return [...rows.values()].map((row) => {
    const slots = tracked.get(canon(row.file));
    const sectionsComplete =
      !Array.isArray(registration) ||
      (slots !== undefined && slots.length > 0 && slots.every((slot) => slot.seen && slot.passed));
    const complete =
      (barrel ? row.roots > 0 && barrelWorker && barrelSummary : row.worker && row.summary) &&
      sectionsComplete;
    const outcome = row.failed
      ? 'failed'
      : !row.seen
        ? 'not-run'
        : complete && !infrastructure
          ? 'passed'
          : 'incomplete';
    return {
      file: row.file,
      outcome,
      ms: row.workerMs ?? row.ms,
      ...(infrastructure ? { reason: 'root hook or infrastructure failure' } : {})
    };
  });
}
