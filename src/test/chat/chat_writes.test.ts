import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as claudeTee from '../../core/claude/tee';
import * as grokTee from '../../core/grok/tee';
import * as activity from '../../ui/activity';
import type { RecordLine } from '../../core/record';
import { describe, it } from 'node:test';
import { cardView, groupView, openThread, stateMessage, threadView } from '../harness';

describe('the files a turn wrote', () => {
  it('names the files a turn wrote, by basename, under its tools', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: 'written',
            blocks: [{ html: '<p>written</p>' }, { summary: 'Changed file' }],
            files: ['/proj/docs/PRD_file_pills.md', '/proj/docs/mockups/file-pills.html']
          }
        ]
      })
    );
    const pills = p.window.document.querySelectorAll('#thread .wpill');
    assert.deepEqual(
      [...pills].map((x) => x.textContent),
      ['PRD_file_pills.md', 'file-pills.html']
    );
    // The whole path is what the reader needs when the basename is ambiguous,
    // and a tooltip costs no room in a 400px column.
    assert.equal(pills[0]?.getAttribute('data-tip'), '/proj/docs/PRD_file_pills.md');
    // And nothing says the row is short, because nothing was taken out of it.
    // A pill is a pill here whether a frame or a checkpoint produced it — this
    // half of the wire has no way to tell, and no reason to.
    assert.equal(p.window.document.querySelector('#thread .wshort'), null);
  });

  /**
   * The marker, and what it is *not*: it says a path was taken out of this row,
   * never that a neighbour was awake. It names no surface of ours, and it opens
   * nothing — the contested path is omitted rather than badged, so there is no
   * pill for it to hang off.
   */
  it('says the list is short when a neighbour took a path out of it', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: 'done',
            blocks: [{ html: '<p>done</p>' }],
            files: ['/proj/src/mine.ts'],
            sizes: { '/proj/src/mine.ts': { add: 2, del: 0 } },
            concurrent: true
          }
        ]
      })
    );
    const doc = p.window.document;
    assert.deepEqual(
      [...doc.querySelectorAll('#thread .wpill')].map((x) => x.textContent),
      ['mine.ts+2−0'],
      'the contested path is not drawn at all'
    );
    const short = doc.querySelector('#thread .wshort');
    assert.equal(short?.textContent, 'list may be short');
    assert.match(short?.getAttribute('data-tip') ?? '', /Another session/);
  });

  it('says it even when everything the turn wrote was contested', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: 'done',
            blocks: [{ html: '<p>done</p>' }],
            concurrent: true
          }
        ]
      })
    );
    assert.equal(p.window.document.querySelectorAll('#thread .wpill').length, 0);
    assert.ok(p.window.document.querySelector('#thread .wshort'), 'a row with only the marker');
  });

  it('states how much of each file the turn wrote', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: '',
            blocks: [{ summary: 'Changed file' }],
            files: ['/proj/src/runs.ts', '/proj/src/panel.ts'],
            sizes: {
              '/proj/src/runs.ts': { add: 42, del: 7 },
              '/proj/src/panel.ts': { add: 9, del: 2 }
            }
          }
        ]
      })
    );
    assert.deepEqual(
      [...p.window.document.querySelectorAll('#thread .wpill .wnum')].map((x) => x.textContent),
      ['+42−7', '+9−2']
    );
  });

  it('marks a write it could not measure, and only where measuring happened', (t) => {
    // `sizes` present says the turn was measured; a path missing from it is a
    // write whose input arrived in a shape `core/` could not read. A turn with
    // no `sizes` at all was never measured — an older transcript, a turn from
    // before this shipped — and gets no marks rather than a row of them.
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: '',
            blocks: [{ summary: 'Changed file' }],
            files: ['/proj/a.ts', '/proj/odd.ts'],
            sizes: { '/proj/a.ts': { add: 3, del: 0 } }
          },
          {
            role: 'assistant',
            text: '',
            blocks: [{ summary: 'Changed file' }],
            files: ['/proj/old.ts']
          }
        ]
      })
    );
    assert.deepEqual(
      [...p.window.document.querySelectorAll('#thread .wpill')].map(
        (x) => x.querySelector('.wnum')?.textContent ?? null
      ),
      ['+3−0', '±?', null]
    );
  });

  it('asks the host to diff the file whose counts were clicked', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: '',
            blocks: [{ summary: 'Changed file' }],
            files: ['/proj/notes.md'],
            sizes: { '/proj/notes.md': { add: 5, del: 1 } }
          }
        ]
      })
    );
    p.window.document.querySelector<HTMLElement>('#thread .wpill .wnum')?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'openDiff', path: '/proj/notes.md' });
  });

  it("opens each copy of one file against that turn's baseline", (t) => {
    const file = '/proj/notes.md';
    const first = 'a'.repeat(40);
    const second = 'b'.repeat(40);
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: '',
            blocks: [{ summary: 'Changed file' }],
            files: [file],
            sizes: { [file]: { add: 1, del: 0 } },
            base: first
          },
          {
            role: 'assistant',
            text: '',
            blocks: [{ summary: 'Changed file' }],
            files: [file],
            sizes: { [file]: { add: 2, del: 1 } },
            base: second
          }
        ]
      })
    );
    const nums = [...p.window.document.querySelectorAll<HTMLElement>('#thread .wpill .wnum')];
    assert.equal(nums.length, 2);
    nums[0]?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'openDiff', path: file, base: first });
    nums[1]?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'openDiff', path: file, base: second });
  });

  it('posts a baseline that arrives after the pill is drawn', (t) => {
    const file = '/proj/late.ts';
    const base = 'd'.repeat(40);
    const exchange = {
      role: 'assistant' as const,
      text: '',
      blocks: [{ summary: 'Changed file' }],
      files: [file],
      sizes: { [file]: { add: 4, del: 1 } }
    };
    const before = threadView({ exchanges: [exchange] });
    const p = openThread(t, before);
    p.push(
      stateMessage(
        [groupView({ sessions: [cardView({ pid: before.pid, startedAt: before.startedAt })] })],
        { thread: threadView({ exchanges: [{ ...exchange, base }] }) }
      )
    );
    p.window.document.querySelector<HTMLElement>('#thread .wnum')?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'openDiff', path: file, base });
  });

  it('omits the baseline when the clicked turn has none', (t) => {
    // The neighbour has a tree. This click must not borrow it, and must not
    // send an empty key.
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: '',
            blocks: [{ summary: 'Changed file' }],
            files: ['/proj/notes.md'],
            sizes: { '/proj/notes.md': { add: 5, del: 1 } }
          },
          {
            role: 'assistant',
            text: '',
            blocks: [{ summary: 'Changed file' }],
            files: ['/proj/other.ts'],
            sizes: { '/proj/other.ts': { add: 1, del: 0 } },
            base: 'c'.repeat(40)
          }
        ]
      })
    );
    const nums = [...p.window.document.querySelectorAll<HTMLElement>('#thread .wpill .wnum')];
    assert.equal(nums.length, 2);
    nums[0]?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'openDiff', path: '/proj/notes.md' });
  });

  for (const brand of ['claude', 'grok'] as const) {
    it(`draws a ${brand} streamed write pill and opens its file and diff without a checkpoint`, (t) => {
      const proj = path.resolve('/proj');
      const input = { file_path: 'notes.md', old_string: 'old\n', new_string: 'new\nextra\n' };
      let lines: RecordLine[];
      if (brand === 'claude') {
        lines = claudeTee.lineForFrame(
          {
            type: 'assistant',
            message: {
              id: 'write-pill',
              content: [{ type: 'tool_use', id: 'edit', name: 'Edit', input }]
            }
          },
          Date.now(),
          proj
        );
      } else {
        const tee = new grokTee.GrokTee(proj);
        tee.teed(
          'session/update',
          {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call-aaa-0',
              title: 'search_replace',
              rawInput: input
            }
          },
          Date.now()
        );
        lines = grokTee.linesOf(tee.closeTurn({ stop: 'end_turn' }, Date.now()));
      }
      const turn = lines.find((line) => 'role' in line && line.role === 'assistant');
      assert.ok(turn && 'role' in turn);
      const p = openThread(
        t,
        threadView({
          brand,
          exchanges: [
            {
              ...turn,
              blocks: (turn.blocks ?? []).map((block): BlockView =>
                'call' in block ? activity.toolView(block.call) : { html: '<p>done</p>' }
              )
            }
          ]
        })
      );
      const pill = p.window.document.querySelector<HTMLElement>('#thread .wpill');
      assert.ok(pill);
      assert.equal(pill.textContent, 'notes.md+2−1');
      pill.click();
      assert.deepEqual(p.posted.at(-1), { type: 'openFile', path: path.join(proj, 'notes.md') });
      pill.querySelector<HTMLElement>('.wnum')?.click();
      assert.deepEqual(p.posted.at(-1), { type: 'openDiff', path: path.join(proj, 'notes.md') });
    });
  }

  it('draws counts too large to diff, and offers no click on them', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: '',
            blocks: [{ summary: 'Changed file' }],
            files: ['/proj/huge.html'],
            sizes: { '/proj/huge.html': { add: 90000, del: 2 } }
          }
        ]
      })
    );
    const num = p.window.document.querySelector<HTMLElement>('#thread .wpill .wnum');
    assert.equal(num?.textContent, '+90000−2');
    const before = p.posted.length;
    num?.click();
    // The pill's own handler still fires — the click was withheld from the
    // counts, not from the file — so this asserts no `openDiff`, not silence.
    assert.equal(
      p.posted.slice(before).some((m) => m.type === 'openDiff'),
      false
    );
  });

  it('still opens the file when the pill body is clicked beside its counts', (t) => {
    // The counts are a second target inside the pill, not a replacement for the
    // first: the click stays on `.wpill`, so the glyph and the padding keep
    // opening the file instead of becoming dead space.
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: '',
            blocks: [{ summary: 'Changed file' }],
            files: ['/proj/notes.md'],
            sizes: { '/proj/notes.md': { add: 5, del: 1 } }
          }
        ]
      })
    );
    p.window.document.querySelector<HTMLElement>('#thread .wpill')?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'openFile', path: '/proj/notes.md' });
  });

  it('asks the host to open the file a pill names', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: '',
            blocks: [{ summary: 'Changed file' }],
            files: ['/proj/notes.md']
          }
        ]
      })
    );
    p.window.document.querySelector<HTMLElement>('#thread .wpill')?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'openFile', path: '/proj/notes.md' });
  });
});
