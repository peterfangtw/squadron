import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { WARM_PROMPT, wrapWarm } from '../../core/coordination/send';
import { tempHome } from '../helpers';

type Checklist = typeof import('../../core/claude/checklist');

type Acks = typeof import('../../core/acks');

let home: string;

let checklist: Checklist;

let acks: Acks;

before(async () => {
  // Imported after the home moves: `core/paths.ts` resolves the CLI's
  // directories once, at load.
  home = await tempHome();
  checklist = await import('../../core/claude/checklist');
  acks = await import('../../core/acks');
});

/** A session's step list, as the CLI lays it out: one `N.json` per step. */
const list = async (id: string, steps: unknown[]): Promise<string> => {
  const dir = path.join(home, '.claude', 'tasks', id);
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(
    steps.map((step, at) => fs.writeFile(path.join(dir, `${at + 1}.json`), JSON.stringify(step)))
  );
  return dir;
};

const step = (status: string, id = '1') => ({
  id,
  subject: `step ${id}`,
  description: 'something to do',
  activeForm: 'doing something',
  status,
  blocks: [],
  blockedBy: []
});

/** A transcript stating one prompt, at a given moment. */
const promptedAt = async (name: string, when: number): Promise<string> => {
  const file = path.join(home, `${name}.jsonl`);
  await fs.writeFile(
    file,
    JSON.stringify({
      type: 'user',
      timestamp: new Date(when).toISOString(),
      message: { content: [{ type: 'text', text: 'do the thing' }] }
    })
  );
  return file;
};

describe('readChecklist', () => {
  it('counts the steps and the finished ones', async () => {
    await list('counts', [step('completed'), step('in_progress', '2'), step('pending', '3')]);
    const read = await checklist.readChecklist('counts');
    assert.equal(read?.total, 3);
    assert.equal(read?.completed, 1);
  });

  it('counts an in-progress step as unfinished', async () => {
    await list('running', [step('in_progress')]);
    assert.equal((await checklist.readChecklist('running'))?.completed, 0);
  });

  it('counts a status it has never seen as unfinished', async () => {
    // A word we do not know is not a promise that the work is done.
    await list('novel', [step('abandoned')]);
    assert.equal((await checklist.readChecklist('novel'))?.completed, 0);
  });

  it('ignores the CLI’s own bookkeeping files', async () => {
    const dir = await list('bookkeeping', [step('completed')]);
    await fs.writeFile(path.join(dir, '.lock'), '');
    await fs.writeFile(path.join(dir, '.highwatermark'), '1');
    assert.equal((await checklist.readChecklist('bookkeeping'))?.total, 1);
  });

  it('drops a step it cannot parse rather than the whole list', async () => {
    const dir = await list('half-written', [step('completed')]);
    await fs.writeFile(path.join(dir, '2.json'), '{"id":"2","stat');
    const read = await checklist.readChecklist('half-written');
    assert.equal(read?.total, 1);
    assert.equal(read?.completed, 1);
  });

  it('yields nothing for a directory the CLI made but never filled', async () => {
    await fs.mkdir(path.join(home, '.claude', 'tasks', 'empty'), { recursive: true });
    assert.equal(await checklist.readChecklist('empty'), undefined);
  });

  it('yields nothing for a session with no directory at all', async () => {
    assert.equal(await checklist.readChecklist('absent'), undefined);
  });

  it('dates the list by its newest step', async () => {
    await list('dated', [step('completed'), step('pending', '2')]);
    const read = await checklist.readChecklist('dated');
    assert.ok((read?.newestAt ?? 0) > 0);
  });

  it('dates the list by its newest step every time, whatever order the steps read in', async () => {
    // Steps are stat-ed concurrently, and which call resolves last is the
    // machine's business rather than ours — so the newest is neither the
    // first name nor the last, and one reading proves nothing. A fold across
    // the await returned whichever step landed last; this asks the same
    // question enough times that that answer cannot pass.
    const dir = await list(
      'staggered',
      Array.from({ length: 7 }, (_, at) => step('completed', `${at + 1}`))
    );
    const base = Date.now() - 60 * 60 * 1000;
    const minutes = [0, 12, 4, 31, 9, 22, 17]; // newest is 4.json, in the middle
    await Promise.all(
      minutes.map((mins, at) => {
        const when = new Date(base + mins * 60 * 1000);
        return fs.utimes(path.join(dir, `${at + 1}.json`), when, when);
      })
    );
    const newest = (await fs.stat(path.join(dir, '4.json'))).mtimeMs;
    for (let read = 0; read < 30; read++) {
      assert.equal((await checklist.readChecklist('staggered'))?.newestAt, newest);
    }
  });
});

describe('readCompletion', () => {
  it('reports a list written after the last prompt', async () => {
    await list('fresh', [step('completed'), step('completed', '2')]);
    const file = await promptedAt('fresh', Date.now() - 60_000);
    assert.deepEqual(await checklist.readCompletion('fresh', file), { total: 2, completed: 2 });
  });

  it('drops a list the session has moved past', async () => {
    // Every step predates the prompt, so the list is about older work. Saying
    // `done` off it would send the reader away from a session that may be
    // waiting on them.
    await list('stale', [step('completed')]);
    const file = await promptedAt('stale', Date.now() + 60_000);
    assert.equal(await checklist.readCompletion('stale', file), undefined);
  });

  it('keeps speaking past a cache-warming ping', async () => {
    // A ping is not somebody asking for something, so it dates no list.
    await list('pinged', [step('completed')]);
    const file = await promptedAt('pinged', Date.now() - 60_000);
    await fs.appendFile(
      file,
      '\n' +
        JSON.stringify({
          type: 'user',
          timestamp: new Date(Date.now() + 60_000).toISOString(),
          message: { content: [{ type: 'text', text: wrapWarm(WARM_PROMPT) }] }
        })
    );
    assert.deepEqual(await checklist.readCompletion('pinged', file), { total: 1, completed: 1 });
  });

  it('trusts the list when the transcript states no prompt', async () => {
    // A session one turn in: its list is the newest thing there is.
    await list('unprompted', [step('pending')]);
    const file = path.join(home, 'unprompted-none.jsonl');
    await fs.writeFile(file, JSON.stringify({ type: 'assistant', message: { content: [] } }));
    assert.deepEqual(await checklist.readCompletion('unprompted', file), {
      total: 1,
      completed: 0
    });
  });

  it('trusts the list when there is no transcript to read', async () => {
    await list('no-transcript', [step('completed')]);
    assert.deepEqual(await checklist.readCompletion('no-transcript', ''), {
      total: 1,
      completed: 1
    });
  });

  it('yields nothing when there is no list, whatever the transcript says', async () => {
    const file = await promptedAt('listless', Date.now());
    assert.equal(await checklist.readCompletion('listless', file), undefined);
  });

  it('retires a finished list the reader has opened', async () => {
    // `done` is a message to a person, and opening the card delivers it.
    await list('delivered', [step('completed'), step('completed', '2')]);
    const file = await promptedAt('delivered', Date.now() - 60_000);
    assert.ok(await checklist.readCompletion('delivered', file));
    await acks.writeAck('delivered');
    assert.equal(await checklist.readCompletion('delivered', file), undefined);
  });

  it('keeps an unfinished list however often the reader opens it', async () => {
    // `stalled` is the reading the whole feature exists for. A card that hid it
    // on the first click would hide the one thing worth finding.
    await list('sitting', [step('completed'), step('pending', '2')]);
    const fresh = await promptedAt('sitting', Date.now() - 60_000);
    await acks.writeAck('sitting');
    assert.deepEqual(await checklist.readCompletion('sitting', fresh), { total: 2, completed: 1 });
  });

  it('says done again when the list finishes after the reader opened it', async () => {
    // New work ending, not the message they already read.
    const dir = await list('again', [step('completed')]);
    const file = await promptedAt('again', Date.now() - 60_000);
    await acks.writeAck('again');
    const after = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(dir, '1.json'), after, after);
    assert.deepEqual(await checklist.readCompletion('again', file), { total: 1, completed: 1 });
  });
});

describe('cardCompletion', () => {
  it('reads the list of a session that states no brand', async () => {
    // Every record written before `brand` existed, and Claude's own cards.
    await list('unbranded', [step('completed')]);
    const file = await promptedAt('unbranded', Date.now() - 60_000);
    assert.deepEqual(await checklist.cardCompletion({ sessionId: 'unbranded' }, file), {
      total: 1,
      completed: 1
    });
  });

  it('reads the list of a Claude session', async () => {
    await list('claudes', [step('completed'), step('pending', '2')]);
    const file = await promptedAt('claudes', Date.now() - 60_000);
    assert.deepEqual(
      await checklist.cardCompletion({ brand: 'claude', sessionId: 'claudes' }, file),
      { total: 2, completed: 1 }
    );
  });

  it('says nothing for another brand, whatever is under that id', async () => {
    // `~/.claude/tasks/<id>/` is Claude's directory and no other CLI writes
    // one, so this read has missed on every poll of every Grok and Codex card
    // since those brands boarded — and the day two CLIs issue the same id it
    // stops missing and starts lying.
    await list('borrowed', [step('completed')]);
    const file = await promptedAt('borrowed', Date.now() - 60_000);
    assert.equal(
      await checklist.cardCompletion({ brand: 'grok', sessionId: 'borrowed' }, file),
      undefined
    );
    assert.equal(
      await checklist.cardCompletion({ brand: 'codex', sessionId: 'borrowed' }, file),
      undefined
    );
  });

  it('says nothing for a session with no id yet', async () => {
    assert.equal(await checklist.cardCompletion({ sessionId: '' }, ''), undefined);
  });
});
