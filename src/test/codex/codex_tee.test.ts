import * as assert from 'node:assert/strict';

import * as fs from 'node:fs/promises';

import * as path from 'node:path';

import { before, describe, it } from 'node:test';

import type { RecordLine } from '../../core/record';

import type { Exchange } from '../../core/transcript';

import { wrapMessage, wrapWait } from '../../core/coordination/send';

import { repoRoot, tempHome } from '../helpers';

type RecordModule = typeof import('../../core/record');

let record: RecordModule;

let CodexTee: typeof import('../../core/codex/tee').CodexTee;

let transcriptFromPages: typeof import('../../core/codex/transcript').transcriptFromPages;

const FIXTURES = path.join(repoRoot(), 'src', 'test', 'fixtures', 'codex-app-server-0.151.0');

function transcriptLines(content: unknown[]): (RecordLine & { m?: string })[] {
  return new CodexTee('/repo').take(
    'item/completed',
    { completedAtMs: 12, item: { type: 'userMessage', id: 'user-9', content } },
    99
  );
}

function exchange(line: RecordLine): Exchange | undefined {
  if (!('role' in line) && !('mark' in line)) return undefined;
  const { m: _witness, ...drawn } = line as RecordLine & { m?: string };
  void _witness;
  return drawn as Exchange;
}

before(async () => {
  await tempHome();
  record = await import('../../core/record');
  ({ CodexTee } = await import('../../core/codex/tee'));
  ({ transcriptFromPages } = await import('../../core/codex/transcript'));
});

describe('the Codex record tee', () => {
  it('draws the same completed C0 thread as the fallback without delta duplication', async () => {
    const tee = new CodexTee('<cwd>');
    const lines: RecordLine[] = [];
    for (const name of ['text', 'image', 'file', 'patch', 'denied', 'question', 'interrupt']) {
      const fixture = JSON.parse(
        await fs.readFile(path.join(FIXTURES, `${name}.json`), 'utf8')
      ) as {
        messages: unknown[];
      };
      for (const raw of fixture.messages) {
        const message = raw as { method?: string; params?: unknown; emittedAtMs?: number };
        if (message.method) {
          lines.push(...tee.take(message.method, message.params, message.emittedAtMs ?? 0));
        }
      }
    }

    const resumed = JSON.parse(await fs.readFile(path.join(FIXTURES, 'resume.json'), 'utf8')) as {
      read: { thread: { turns: Array<Record<string, unknown>> } };
    };
    const turns = resumed.read.thread.turns;
    const entries = turns.flatMap((turn) =>
      (Array.isArray(turn.items) ? turn.items : []).map((item) => ({
        turnId: String(turn.id),
        item
      }))
    );
    const fallback = transcriptFromPages(turns as never[], entries, '<cwd>');
    const live = lines.flatMap((line) => {
      const one = exchange(line);
      return one ? [one] : [];
    });

    assert.deepEqual(live, fallback.recent.exchanges);
    const witnessed = new Set(
      lines.flatMap((line) => {
        const id = (line as RecordLine & { m?: unknown }).m;
        return typeof id === 'string' ? [id] : [];
      })
    );
    assert.deepEqual(witnessed, fallback.witnessed);
    assert.equal(
      live.filter((one) => 'role' in one && one.role === 'assistant' && one.text === 'C0_READY')
        .length,
      1,
      'streaming deltas did not become record rows'
    );
    const patch = live.find((one) => 'role' in one && one.files?.includes('<cwd>/c0-patched.txt'));
    assert.ok(patch && 'role' in patch);
    assert.deepEqual(patch.sizes?.['<cwd>/c0-patched.txt'], { add: 1, del: 0 });
    assert.ok(live.some((one) => 'mark' in one && one.mark === 'break'));
  });

  it('draws no write pill for a declined patch, and still one for an applied patch', async () => {
    // Seen live on 0.153.2 (2026-09-05): a person denied
    // `item/fileChange/requestApproval`, and the dock drew `+1 −0` for a file
    // never written. The completed item carries the full `changes` list either
    // way, so the outcome, not the patch, decides the pill. Both items are the
    // CLI's own frames — `denied.json` and `patch.json` — not a hand-typed twin.
    const completedPatch = async (name: string) => {
      const fixture = JSON.parse(
        await fs.readFile(path.join(FIXTURES, `${name}.json`), 'utf8')
      ) as { messages: { method?: string; params?: { item?: { type?: string } } }[] };
      const frame = fixture.messages.find(
        (m) => m.method === 'item/completed' && m.params?.item?.type === 'fileChange'
      );
      assert.ok(frame);
      const [line] = new CodexTee('<cwd>').take('item/completed', frame.params, 0);
      assert.ok(line && 'role' in line);
      const block = line.blocks?.[0];
      return { line, call: block && 'call' in block ? block.call : undefined };
    };
    const denied = await completedPatch('denied');
    assert.equal(denied.call?.failed, true);
    assert.equal(denied.line.files, undefined);
    assert.equal(denied.line.sizes, undefined);
    assert.equal(
      (denied.call?.input as { file_path?: unknown } | undefined)?.file_path,
      '<cwd>/c0-denied.txt'
    );

    const applied = await completedPatch('patch');
    assert.equal(applied.call?.failed, undefined);
    assert.deepEqual(applied.line.files, ['<cwd>/c0-patched.txt']);
    assert.deepEqual(applied.line.sizes, { '<cwd>/c0-patched.txt': { add: 1, del: 0 } });
  });

  it('uses a supplied durable image ref for an echoed user image', () => {
    const tee = new CodexTee('/repo');
    let heard: RecordLine[] = [];
    tee.attach(
      'client-1',
      [{ id: 'r|kept.png', mediaType: 'image/png', sizeBytes: 3 }],
      { text: 'look', images: [{ mediaType: 'image/png', data: 'AAA' }] },
      (lines) => (heard = lines)
    );
    const taken = tee.take(
      'item/completed',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 12,
        item: {
          type: 'userMessage',
          id: 'user-1',
          clientId: 'client-1',
          content: [
            { type: 'text', text: 'look', text_elements: [] },
            { type: 'localImage', path: '/temporary/input.png' }
          ]
        }
      },
      99
    );
    assert.deepEqual(taken, [], 'the send’s own slot holds it');
    const [line] = heard;
    assert.ok(line && 'role' in line);
    assert.deepEqual(line.images, [{ id: 'r|kept.png', mediaType: 'image/png', sizeBytes: 3 }]);
  });

  it('records what we sent for the matched item, one turn per message, witnessed once', () => {
    const tee = new CodexTee('/repo');
    const shot = { mediaType: 'image/png', data: 'AAA' };
    let lines: RecordLine[] = [];
    tee.attach(
      'client-2',
      [undefined, { id: 'r|b.png' }],
      {
        text: 'joined',
        images: [shot, shot],
        parts: [
          { id: 'p', text: wrapMessage('from a peer', 'peer-session'), images: [shot] },
          { id: 'w', text: wrapWait('All 1 finished.') },
          { id: 'b', text: '', images: [shot] },
          { id: 'a', text: 'and mine' }
        ]
      },
      (heard) => (lines = heard)
    );
    tee.take(
      'item/completed',
      {
        completedAtMs: 12,
        item: {
          type: 'userMessage',
          id: 'user-2',
          clientId: 'client-2',
          content: [{ type: 'text', text: 'whatever the echo says', text_elements: [] }]
        }
      },
      99
    );
    assert.deepEqual(
      lines.map((line) =>
        'role' in line
          ? [line.role, line.text, line.from, line.images, 'm' in line ? line.m : undefined]
          : line
      ),
      [
        ['user', 'from a peer', 'peer-session', undefined, 'user-2'],
        ['wait', 'All 1 finished.', undefined, undefined, undefined],
        ['user', '', undefined, [{ id: 'r|b.png' }], undefined],
        ['user', 'and mine', undefined, undefined, undefined]
      ]
    );
    assert.deepEqual(
      tee
        .take(
          'item/completed',
          { item: { type: 'userMessage', id: 'user-3', clientId: 'client-2', content: [] } },
          99
        )
        .map((line) => 'role' in line && line.text),
      [''],
      'the row is taken, not read'
    );
  });
});

describe('a Codex send that kept nothing to draw', () => {
  it('is still the prompt its id names, never a bare witness', () => {
    const tee = new CodexTee('/repo');
    let lines: RecordLine[] = [];
    tee.attach(
      'client-4',
      [undefined],
      { text: '', images: [{ mediaType: 'image/png', data: 'AAA' }] },
      (heard) => (lines = heard)
    );
    tee.take(
      'item/completed',
      {
        completedAtMs: 12,
        item: { type: 'userMessage', id: 'user-4', clientId: 'client-4', content: [] }
      },
      99
    );
    assert.deepEqual(lines, [{ role: 'user', text: '', at: 12, m: 'user-4' }]);
  });
});

describe('a Codex send recorded without its echo', () => {
  it('takes nothing from an echo arriving after it settled', () => {
    const tee = new CodexTee('/repo');
    const heard: RecordLine[][] = [];
    tee.attach('client-5', [], { text: 'asked' }, (lines) => heard.push(lines));
    tee.settle('client-5');
    const echo = {
      item: {
        type: 'userMessage',
        id: 'user-5',
        clientId: 'client-5',
        content: [{ type: 'text', text: 'asked', text_elements: [] }]
      }
    };
    assert.deepEqual(tee.take('item/completed', echo, 99), []);
    assert.deepEqual(heard, []);
  });
});

describe('a Codex user item read back without our row', () => {
  it('splits per text item, each under its author, pictures on the words before them', () => {
    const [line, ...rest] = transcriptLines([
      {
        type: 'text',
        text: wrapMessage('from a peer', 'peer-session') + '\n\n',
        text_elements: []
      },
      { type: 'text', text: 'and mine', text_elements: [] },
      { type: 'localImage', path: '/tmp/a.png' }
    ]);
    assert.ok(line && 'role' in line);
    assert.deepEqual([line.text, line.from, line.m], ['from a peer', 'peer-session', 'user-9']);
    assert.deepEqual(
      rest.map((turn) => 'role' in turn && [turn.text, turn.images?.length, 'm' in turn]),
      [['and mine', 1, false]]
    );
  });

  it('marks a typed skill input after the prompt, which keeps the witness', () => {
    // 0.164.0 echoes `{ type: 'skill' }` on `item/completed` and `thread/read`
    // alike (`cli_state/codex/protocol.md`, 2026-10-29).
    const skill = (name: unknown) => ({
      type: 'skill',
      name,
      path: '/Users/me/.agents/skills/x/SKILL.md'
    });
    assert.deepEqual(
      transcriptLines([skill('acme:review'), { type: 'text', text: 'Go.', text_elements: [] }]),
      [
        { role: 'user', text: 'Go.', blocks: [{ text: 'Go.' }], at: 12, m: 'user-9' },
        { mark: 'skill', skill: 'acme:review', by: 'you' }
      ]
    );
    assert.deepEqual(transcriptLines([skill('acme:review')]), [
      { role: 'user', text: '', at: 12, m: 'user-9' },
      { mark: 'skill', skill: 'acme:review', by: 'you' }
    ]);
  });

  it('marks nothing for a nameless skill input or a skill named in prose', () => {
    const lines = transcriptLines([
      { type: 'skill', name: '', path: '/Users/me/.agents/skills/x/SKILL.md' },
      { type: 'skill', path: '/Users/me/.agents/skills/x/SKILL.md' },
      // Codex expands `$name` itself, but the item it hands a client is text.
      { type: 'text', text: '$acme-review', text_elements: [] },
      { type: 'text', text: 'Use the acme-review skill.', text_elements: [] }
    ]);
    assert.equal(lines.filter((line) => 'mark' in line).length, 0);
    assert.equal(lines.length, 2);
  });
});

describe('CodexTee, a command that outlives its turn', () => {
  /** The 0.162.1 capture's notifications, through one tee, in order. */
  async function replay(): Promise<{ byMethod: [string, RecordLine[]][]; lines: RecordLine[] }> {
    const file = path.join(
      repoRoot(),
      'src',
      'test',
      'fixtures',
      'cli_state',
      'codex',
      'background_cmd_2026_10_13',
      'log-plain.jsonl'
    );
    const tee = new CodexTee('/tmp/probe_codex/work');
    const byMethod: [string, RecordLine[]][] = [];
    for (const raw of (await fs.readFile(file, 'utf8')).split('\n')) {
      if (!raw) continue;
      const row = JSON.parse(raw) as {
        ts: string;
        dir: string;
        m?: { method?: unknown; id?: unknown; params?: unknown };
      };
      const method = row.m?.method;
      if (row.dir !== 'in' || typeof method !== 'string' || row.m?.id !== undefined) continue;
      byMethod.push([method, tee.take(method, row.m?.params, Date.parse(row.ts))]);
    }
    return { byMethod, lines: byMethod.flatMap(([, lines]) => lines) };
  }

  const call = 'exec-1d92ae0b-0c7c-4bca-ae1e-4a29ba00a3d3';

  it('writes the running call at its turn end, and folds the end onto it', async () => {
    const { byMethod, lines } = await replay();
    const atEnd = byMethod.find(([method]) => method === 'turn/completed')?.[1] ?? [];
    assert.deepEqual(
      atEnd.flatMap((line) => ('blocks' in line ? (line.blocks ?? []) : [])),
      [
        {
          call: {
            id: call,
            name: 'Bash',
            input: {
              command: "/bin/zsh -lc 'sleep 25; echo probe-done'",
              cwd: '/tmp/probe_codex/work'
            }
          }
        }
      ],
      'the call is written, still running, in the turn that started it'
    );
    const late = byMethod.filter(([method]) => method === 'item/completed').at(-1)?.[1];
    assert.deepEqual(late, [{ ret: [{ id: call, output: 'probe-done' }] }]);

    const fold = new record.RecordFold();
    for (const line of lines) fold.push(line);
    const exchanges = fold.snapshot().exchanges;
    const last = exchanges.at(-1);
    assert.ok(last && 'blocks' in last);
    assert.deepEqual(last.blocks?.[0], {
      call: {
        id: call,
        name: 'Bash',
        input: {
          command: "/bin/zsh -lc 'sleep 25; echo probe-done'",
          cwd: '/tmp/probe_codex/work'
        },
        output: 'probe-done'
      }
    });
    assert.equal(
      exchanges.some((x) => 'mark' in x),
      false,
      'Codex starts no turn for it, so nothing explains one'
    );
  });
});
