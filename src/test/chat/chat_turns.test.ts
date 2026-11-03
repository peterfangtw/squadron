import * as streaming from '../../ui/streaming';
import { proseBlockView } from '../../ui/turn_blocks';
import type { Authored } from '../../core/transcript';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cardView, groupView, openPanel, openThread, stateMessage, threadView } from '../harness';

describe('a turn in the thread', () => {
  it('holds unfinished blocks through the first raw-to-boundary transition', async (t) => {
    const p = openThread(t, threadView({ status: 'busy' }));
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const show = async (text: string): Promise<void> => {
      const original: Authored = {
        role: 'assistant',
        at: 1000,
        text,
        blocks: [{ text }]
      };
      const drawn = streaming.heldDraft(original);
      const blocks = await Promise.all(
        (drawn.blocks ?? []).map((block) => {
          assert.ok('text' in block);
          return proseBlockView(drawn.role, false, block, (raw) =>
            Promise.resolve(`<p class="raw">${raw}</p>`)
          );
        })
      );
      p.push(
        stateMessage(groups, {
          thread: threadView({
            status: 'busy',
            exchanges: [{ ...drawn, blocks, streaming: true }]
          })
        })
      );
    };
    for (const [raw, visible] of [
      ['Intro:\n-', 'Intro:\n-'],
      ['Intro:\n- a', 'Intro:\n'],
      ['Intro:\n- a\n- b', 'Intro:\n- a\n'],
      ['Intro:\n- a\n- b\n\n```ts\nx()', 'Intro:\n- a\n- b\n\n'],
      ['Intro:\n- a\n- b\n\n```ts\nx()\n```\nEnd', 'Intro:\n- a\n- b\n\n```ts\nx()\n```\n']
    ]) {
      assert.ok(raw !== undefined && visible !== undefined);
      await show(raw);
      assert.equal(
        p.window.document.querySelector('#thread .turn.live .body')?.textContent,
        visible
      );
    }
  });

  it('grows a streaming exchange across repaints without rebuilding its settled prefix', (t) => {
    const asked: AuthoredView = { role: 'user', text: 'go', blocks: [{ prose: 'go' }] };
    const reply: AuthoredView = {
      role: 'assistant',
      at: 1000,
      streaming: true,
      text: 'Read',
      blocks: [{ html: '<p>Read</p>' }]
    };
    const p = openThread(t, threadView({ status: 'busy', exchanges: [asked, reply] }));
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const [prefix, first] = p.window.document.querySelectorAll('#thread .turn');
    assert.ok(first?.classList.contains('live'));
    assert.equal(p.window.document.querySelector('#thread .working'), null);

    p.push(
      stateMessage(groups, { thread: threadView({ status: 'busy', exchanges: [asked, reply] }) })
    );
    assert.equal(p.window.document.querySelectorAll('#thread .turn')[1], first);
    for (const text of ['Reading the', 'Reading the file']) {
      p.push(
        stateMessage(groups, {
          thread: threadView({
            status: 'busy',
            exchanges: [asked, { ...reply, text, blocks: [{ html: `<p>${text}</p>` }] }]
          })
        })
      );
      const turns = p.window.document.querySelectorAll('#thread .turn');
      assert.equal(turns.length, 2);
      assert.equal(turns[0], prefix);
      assert.equal(turns[1]?.querySelector('.body')?.textContent, text);
      assert.ok(turns[1]?.classList.contains('live'));
    }
  });

  it('completes a streaming exchange with identical content through the ordinary renderer', (t) => {
    const reply: AuthoredView = {
      role: 'assistant',
      at: 1000,
      streaming: true,
      text: 'All done',
      blocks: [{ html: '<p>All <strong>done</strong></p>' }]
    };
    const p = openThread(t, threadView({ status: 'busy', exchanges: [reply] }));
    const before = p.window.document.querySelector('#thread .turn.live');
    assert.ok(before);
    const markup = before.innerHTML;
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 101 })] })], {
        thread: threadView({ exchanges: [{ ...reply, streaming: undefined }] })
      })
    );
    const turns = p.window.document.querySelectorAll('#thread .turn');
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.classList.contains('live'), false);
    assert.equal(turns[0]?.innerHTML, markup);
    assert.equal(p.window.document.querySelector('#thread .working'), null);
  });

  it('keeps a streaming message around its tool call and paints the result on repaint', (t) => {
    const reply: AuthoredView = {
      role: 'assistant',
      at: 1000,
      streaming: true,
      text: 'Checking',
      blocks: [{ html: '<p>Checking</p>' }]
    };
    const p = openThread(t, threadView({ status: 'busy', exchanges: [reply] }));
    assert.ok(p.window.document.querySelector('#thread .turn.live'));
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    for (const output of [undefined, 'ok']) {
      p.push(
        stateMessage(groups, {
          thread: threadView({
            status: 'busy',
            exchanges: [
              {
                ...reply,
                text: 'Checking. Done.',
                blocks: [
                  { html: '<p>Checking</p>' },
                  { summary: 'Ran command', detail: 'npm run check', output },
                  { html: '<p>Done.</p>' }
                ]
              }
            ]
          })
        })
      );
      const turn = p.window.document.querySelector('#thread .turn.live');
      assert.deepEqual(
        [...(turn?.children ?? [])]
          .filter((node) => node.matches('.body, .tool'))
          .map((node) => node.className),
        ['body', 'tool', 'body']
      );
      assert.equal(turn?.querySelector('.tool .what')?.textContent, 'Ran command');
      assert.deepEqual(
        [...(turn?.querySelectorAll('.body') ?? [])].map((node) => node.textContent),
        ['Checking', 'Done.']
      );
      assert.equal(p.window.document.querySelectorAll('#thread .turn').length, 1);
      assert.equal(p.window.document.querySelector('#thread .working'), null);
      if (output) {
        turn?.querySelector<HTMLElement>('.tool .thead')?.click();
        assert.ok(p.window.document.querySelector('#thread .tool.open'));
        assert.equal(p.window.document.querySelector('#thread .tool .out')?.textContent, output);
      }
    }
  });

  it('keeps two assistant messages separate as the second streams and completes', (t) => {
    const first: AuthoredView = {
      role: 'assistant',
      at: 1000,
      text: 'Checking',
      blocks: [{ html: '<p>Checking</p>' }]
    };
    const second: AuthoredView = {
      role: 'assistant',
      at: 2000,
      streaming: true,
      text: 'Done',
      blocks: [{ html: '<p>Done</p>' }]
    };
    const p = openThread(t, threadView({ status: 'busy', exchanges: [first, second] }));
    const kept = p.window.document.querySelector('#thread .turn');
    assert.equal(p.window.document.querySelector('#thread .turn.live .body')?.textContent, 'Done');
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 101 })] })], {
        thread: threadView({ exchanges: [first, { ...second, streaming: undefined }] })
      })
    );
    const turns = p.window.document.querySelectorAll('#thread .turn');
    assert.equal(turns.length, 2);
    assert.equal(turns[0], kept);
    assert.deepEqual(
      [...turns].map((node) => node.querySelector('.body')?.textContent),
      ['Checking', 'Done']
    );
    assert.equal(p.window.document.querySelector('#thread .turn.live'), null);
  });

  it('keeps a cut-off tail with a marker after streaming stops', (t) => {
    const reply: AuthoredView = {
      role: 'assistant',
      at: 1000,
      streaming: true,
      text: 'Partial reply',
      blocks: [{ html: '<p>Partial reply</p>' }]
    };
    const p = openThread(t, threadView({ status: 'busy', exchanges: [reply] }));
    assert.ok(p.window.document.querySelector('#thread .turn.live'));
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    p.push(
      stateMessage(groups, {
        thread: threadView({ exchanges: [{ ...reply, streaming: undefined }] })
      })
    );
    assert.equal(p.window.document.querySelector('#thread .cut'), null);
    p.push(
      stateMessage(groups, {
        thread: threadView({ exchanges: [{ ...reply, streaming: undefined, cut: true }] })
      })
    );
    const turns = p.window.document.querySelectorAll('#thread .turn');
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.querySelector('.body')?.textContent, 'Partial reply');
    assert.equal(turns[0]?.querySelector('.cut')?.textContent, 'cut off');
    assert.equal(turns[0]?.classList.contains('live'), false);
    assert.equal(p.window.document.querySelector('#thread .working'), null);
  });

  it('renders exchanges as turns, with a row per call', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          { role: 'user', text: 'do it', blocks: [{ prose: 'do it' }] },
          {
            role: 'assistant',
            text: 'done',
            blocks: [
              { summary: 'Ran command', detail: 'npm run check' },
              { summary: 'Changed file', detail: '~/proj/a.ts' },
              { html: '<p>done</p>' }
            ]
          }
        ]
      })
    );
    const turns = p.window.document.querySelectorAll('#thread .turn');
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.querySelector('.who')?.textContent, 'you');
    assert.equal(turns[1]?.querySelector('.who')?.textContent, 'claude');
    assert.deepEqual(
      [...(turns[1]?.querySelectorAll('.tool .what') ?? [])].map((x) => x.textContent),
      ['Ran command', 'Changed file']
    );
    assert.equal(turns[1]?.querySelector('.tool .detail')?.textContent, 'npm run check');
  });

  it('says so under prose the server summarised, and only there', (t) => {
    // Claude's narration: the words a question points at, rewritten server-side.
    // The CLI's own terminal marks it "· summarized"; the dock says the same.
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: 'drafted it',
            blocks: [
              { html: '<p>drafted it</p>', summarized: true },
              { summary: 'Asked a question' },
              { html: '<p>own words</p>' }
            ]
          }
        ]
      })
    );
    const marks = p.window.document.querySelectorAll('#thread .turn .summarized');
    assert.equal(marks.length, 1);
    assert.equal(marks[0]?.textContent, 'summarized');
    assert.equal(marks[0]?.previousElementSibling?.textContent, 'drafted it');
  });

  it('keeps the breaks of an engine-rendered paragraph', (t) => {
    // The engine treats a lone newline as a soft break and emits it as a bare
    // newline inside `p`, so only CSS keeps that paragraph's shape. The
    // reader's own turns are a hard break (`proseHtml`) and never reach it.
    const p = openThread(
      t,
      threadView({
        exchanges: [{ role: 'assistant', text: 'one\ntwo', blocks: [{ html: '<p>one\ntwo</p>' }] }]
      })
    );
    const para = p.window.document.querySelector('#thread .turn .body p') as HTMLElement;
    assert.equal(para.textContent, 'one\ntwo');
    assert.equal(p.window.getComputedStyle(para).whiteSpace, 'pre-wrap');
  });

  it('keeps the indentation of a turn drawn as typed', (t) => {
    // What a host with no markdown engine sends for a turn it would render:
    // the spaces are still there, and `.raw` is what stops CSS collapsing
    // them. A `user` turn is source text and never takes this path.
    const typed = '123\n            89';
    const p = openThread(
      t,
      threadView({
        exchanges: [
          { role: 'assistant', text: typed, blocks: [{ html: `<p class="raw">${typed}</p>` }] }
        ]
      })
    );
    const para = p.window.document.querySelector('#thread .turn .body .raw') as HTMLElement;
    assert.equal(para.textContent, typed);
    assert.equal(p.window.getComputedStyle(para).whiteSpace, 'pre-wrap');
  });

  it('copies a fenced block from a button that is not part of the code', async (t) => {
    // The control sits beside the block, not in it: a button inside `pre`
    // would scroll away on a long line and would be copied with the code.
    const code = '{\n  "id": "pr-ci"\n}';
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: code,
            blocks: [{ html: `<pre><code>${code}</code></pre>` }]
          }
        ]
      })
    );
    const pre = p.window.document.querySelector('#thread .body pre');
    const button = p.window.document.querySelector<HTMLButtonElement>(
      '#thread .body .fence > .copy'
    );
    assert.ok(button, 'a fenced block had no copy button');
    assert.equal(button.textContent, 'Copy');
    assert.equal(pre?.textContent, code);
    assert.equal(pre?.contains(button), false);
    assert.equal(p.window.getComputedStyle(button).position, 'absolute');
    const block = p.window.getComputedStyle(pre);
    assert.ok(
      parseFloat(block.paddingTop) > parseFloat(block.paddingBottom),
      'the first line sits under the button'
    );

    let copied = '';
    Object.defineProperty(p.window.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copied = text;
          return Promise.resolve();
        }
      }
    });
    button.click();
    await Promise.resolve();
    assert.equal(copied, code);
    assert.equal(button.textContent, 'Copied');
  });

  it('copies the block that was clicked when a turn has two', async (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: '',
            blocks: [{ html: '<pre><code>one</code></pre><pre><code>two</code></pre>' }]
          }
        ]
      })
    );
    const buttons = [
      ...p.window.document.querySelectorAll<HTMLButtonElement>('#thread .body .fence > .copy')
    ];
    assert.equal(buttons.length, 2);
    let copied = '';
    Object.defineProperty(p.window.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copied = text;
          return Promise.resolve();
        }
      }
    });
    buttons[1]?.click();
    await Promise.resolve();
    assert.equal(copied, 'two');
  });

  it('leaves an inline span without a copy button', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: 'see id',
            blocks: [{ html: '<p>see <code>id</code></p>' }]
          }
        ]
      })
    );
    assert.equal(p.window.document.querySelector('#thread .body .copy'), null);
  });

  it('replaces the cut-off footer with an interrupt rule without adding a prompt', (t) => {
    const reply: AuthoredView = {
      role: 'assistant',
      text: 'reading',
      blocks: [{ html: '<p>reading</p>' }],
      cut: true
    };
    const p = openThread(t, threadView({ exchanges: [reply] }));
    assert.equal(p.window.document.querySelector('#thread .cut')?.textContent, 'cut off');
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 101 })] })], {
        thread: threadView({
          exchanges: [
            reply,
            { mark: 'break' },
            { role: 'user', text: 'wrong dir', blocks: [{ prose: 'wrong dir' }] }
          ]
        })
      })
    );
    const rule = p.window.document.querySelector('#thread .break');
    assert.equal(rule?.textContent, 'interrupted');
    assert.equal(rule?.classList.contains('turn'), false, 'a break counted as a turn');
    // `cut()` reads the first child's `elided` class to decide whether history
    // went unread. A break wearing it would claim turns were lost.
    assert.equal(rule?.classList.contains('elided'), false);
    assert.equal(p.window.document.querySelector('#thread .cut'), null);
    assert.equal(p.window.document.querySelectorAll('#thread .turn.user').length, 1);
    assert.equal(p.window.document.querySelector('#thread .body')?.textContent, 'reading');
  });

  it('says why a turn nobody prompted began, in one row that is not a turn', (t) => {
    const words: [ExchangeView, string][] = [
      [
        { mark: 'trigger', trigger: 'task', status: 'completed', at: 1 },
        'background command finished'
      ],
      [{ mark: 'trigger', trigger: 'task', status: 'failed', at: 1 }, 'background command failed'],
      [
        { mark: 'trigger', trigger: 'task', status: 'stopped', at: 1 },
        'background command stopped'
      ],
      [{ mark: 'trigger', trigger: 'task', at: 1 }, 'background command ended']
    ];
    for (const [marker, said] of words) {
      const p = openThread(
        t,
        threadView({
          exchanges: [
            { role: 'assistant', text: 'started', blocks: [{ html: '<p>started</p>' }] },
            marker,
            { role: 'assistant', text: 'finished', blocks: [{ html: '<p>finished</p>' }] }
          ]
        })
      );
      const rows = p.window.document.querySelectorAll('#thread .trigger');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.textContent, said);
      // The prompt bar walks `.turn.user`; a trigger is nobody's prompt.
      assert.equal(rows[0]?.classList.contains('turn'), false);
      assert.equal(p.window.document.querySelectorAll('#thread .turn.user').length, 0);
    }
  });

  it('says an agent, not a command, when a background agent began the turn', (t) => {
    const words: [ExchangeView, string][] = [
      [
        { mark: 'trigger', trigger: 'agent', status: 'completed', at: 1 },
        'background agent finished'
      ],
      [{ mark: 'trigger', trigger: 'agent', status: 'failed', at: 1 }, 'background agent failed'],
      [{ mark: 'trigger', trigger: 'agent', status: 'stopped', at: 1 }, 'background agent stopped'],
      [{ mark: 'trigger', trigger: 'agent', at: 1 }, 'background agent ended']
    ];
    for (const [marker, said] of words) {
      const p = openThread(
        t,
        threadView({
          exchanges: [
            { role: 'assistant', text: 'started', blocks: [{ html: '<p>started</p>' }] },
            marker,
            { role: 'assistant', text: 'finished', blocks: [{ html: '<p>finished</p>' }] }
          ]
        })
      );
      const rows = p.window.document.querySelectorAll('#thread .trigger');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.textContent, said);
    }
  });

  it('names the CLI as the author of a turn it wrote in the model’s place', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          { role: 'assistant', text: 'running', blocks: [{ html: '<p>running</p>' }] },
          {
            role: 'cli',
            text: 'API Error: Connection closed',
            blocks: [{ html: '<p>API Error</p>' }]
          }
        ]
      })
    );
    const turns = p.window.document.querySelectorAll('#thread .turn');
    assert.equal(turns[1]?.querySelector('.who')?.textContent, 'cli');
    assert.equal(turns[1]?.classList.contains('cli'), true);
  });

  it('tells a slash command’s own output apart from the CLI speaking in alarm', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'cli',
            text: 'API Error: Connection closed',
            blocks: [{ html: '<p>API Error</p>' }]
          },
          {
            role: 'cli',
            local: true,
            text: 'Current model: Haiku 4.5 (effort: high)',
            blocks: [{ html: '<p>Current model: Haiku 4.5</p>' }]
          }
        ]
      })
    );
    const turns = p.window.document.querySelectorAll('#thread .turn');
    // Same author, because it is the same author: the CLI wrote both.
    assert.equal(turns[0]?.classList.contains('cli'), true);
    assert.equal(turns[1]?.classList.contains('cli'), true);
    assert.equal(turns[1]?.querySelector('.who')?.textContent, 'cli');
    // What differs is only what it is: an alarm wears the red rule, a readout
    // the reader asked for does not. The two must stay tellable apart, or a
    // routine `/context` reads as something having gone wrong.
    assert.equal(turns[0]?.classList.contains('local'), false, 'an error drawn as a readout');
    assert.equal(turns[1]?.classList.contains('local'), true, 'a readout drawn as an error');
  });

  it('draws a cache-warming ping as the CLI’s readout, never the reader’s prompt', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          { role: 'user', text: 'go', blocks: [{ prose: 'go' }] },
          {
            role: 'warm',
            text: '✓ Kept the prompt cache warm',
            at: Date.now() - 60_000,
            blocks: [{ prose: '✓ Kept the prompt cache warm' }]
          }
        ]
      })
    );
    const doc = p.window.document;
    const row = doc.querySelectorAll('#thread .turn')[1];
    assert.equal(row?.querySelector('.who')?.firstChild?.textContent, 'cli');
    assert.ok(row?.querySelector('.who .at'), 'drawn at its time');
    assert.equal(row?.querySelector('.body')?.textContent?.trim(), '✓ Kept the prompt cache warm');
    assert.equal(row?.classList.contains('user'), false, 'a ping drawn as the reader’s bubble');
    // The prompt bar walks `.turn.user`: a ping is nobody asking for anything.
    assert.equal(doc.querySelectorAll('#thread .turn.user').length, 1);
    // A readout, not an alarm: the surface `.turn.cli.local` wears, without the red rule.
    const body = row?.querySelector<HTMLElement>('.body');
    assert.ok(body);
    const style = p.window.getComputedStyle(body);
    assert.equal(style.paddingTop, '8px');
    assert.notEqual(style.borderLeftWidth, '2px');
  });

  it('tags a skill run where it changes, not on every turn of it', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          { role: 'assistant', text: 'a', blocks: [{ html: '<p>a</p>' }], skill: 'ponytail' },
          { role: 'assistant', text: 'b', blocks: [{ html: '<p>b</p>' }], skill: 'ponytail' },
          { role: 'assistant', text: 'c', blocks: [{ html: '<p>c</p>' }], skill: 'drawio' },
          { role: 'assistant', text: 'd', blocks: [{ html: '<p>d</p>' }] }
        ]
      })
    );
    const tags = [...p.window.document.querySelectorAll('#thread .turn')].map(
      (turn) => turn.querySelector('.attr')?.textContent ?? null
    );
    assert.deepEqual(tags, ['ponytail', null, 'drawio', null]);
  });

  it('leaves an unchanged turn where it is when the thread grows', (t) => {
    // The poll repaints every 3s. A turn that did not change
    // must keep its node, or every repaint throws away a selection and pays
    // to parse markup it already parsed.
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const p = openPanel(t);
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card')?.click();

    const asked: ExchangeView = { role: 'user', text: 'do it', blocks: [{ prose: 'do it' }] };
    p.push(stateMessage(groups, { thread: threadView({ exchanges: [asked] }) }));
    const before = p.window.document.querySelector('#thread .turn');

    const answered: ExchangeView = {
      role: 'assistant',
      text: 'done',
      blocks: [{ html: '<p>done</p>' }]
    };
    p.push(stateMessage(groups, { thread: threadView({ exchanges: [asked, answered] }) }));
    const turns = p.window.document.querySelectorAll('#thread .turn');
    assert.equal(turns.length, 2);
    assert.equal(turns[0], before, 'the unchanged turn was rebuilt');
    assert.equal(turns[1]?.querySelector('.body')?.textContent, 'done');
  });

  it('rebuilds from the first turn that changed', (t) => {
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const p = openPanel(t);
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card')?.click();

    const kept: ExchangeView = { role: 'user', text: 'do it', blocks: [{ prose: 'do it' }] };
    const partial: ExchangeView = {
      role: 'assistant',
      text: 'wo',
      blocks: [{ html: '<p>wo</p>' }]
    };
    p.push(stateMessage(groups, { thread: threadView({ exchanges: [kept, partial] }) }));
    const [first, second] = p.window.document.querySelectorAll('#thread .turn');

    // A streaming turn grows in place: its node is stale and must be replaced,
    // while the settled turn ahead of it is not.
    const grown: ExchangeView = {
      role: 'assistant',
      text: 'working',
      blocks: [{ html: '<p>working</p>' }]
    };
    p.push(stateMessage(groups, { thread: threadView({ exchanges: [kept, grown] }) }));
    const turns = p.window.document.querySelectorAll('#thread .turn');
    assert.equal(turns[0], first, 'the settled turn was rebuilt');
    assert.notEqual(turns[1], second, 'the changed turn was not rebuilt');
    assert.equal(turns[1]?.querySelector('.body')?.textContent, 'working');
  });

  it('shows working dots while the session is busy', (t) => {
    const p = openThread(t, threadView({ status: 'busy' }));
    assert.ok(p.window.document.querySelector('#thread .turn .working'));
  });

  it('shows the reply being written, under the last turn', (t) => {
    const p = openThread(
      t,
      threadView({
        status: 'busy',
        exchanges: [
          { role: 'user', text: 'go', blocks: [{ prose: 'go' }] },
          {
            role: 'assistant',
            text: 'Reading the file',
            blocks: [{ html: '<p>Reading the file</p>' }],
            streaming: true
          }
        ]
      })
    );
    const turns = [...p.window.document.querySelectorAll('#thread .turn')];
    const last = turns[turns.length - 1];
    assert.ok(last?.classList.contains('assistant'), 'the live reply is Claude speaking');
    assert.equal(last?.querySelector('.body')?.textContent, 'Reading the file');
  });

  it('renders the live reply as markdown, like any turn that outlives a moment', (t) => {
    // It is not only the tail of a sentence being typed: a question's preamble
    // stands here until the reader answers, and it stood there showing its own
    // asterisks. Same engine as the transcript's turns, so the words do not
    // change appearance when the poll catches up with them.
    const p = openThread(
      t,
      threadView({
        status: 'busy',
        exchanges: [
          {
            role: 'assistant',
            text: '<p>Bundled: <strong>Sea otters</strong></p>',
            blocks: [{ html: '<p>Bundled: <strong>Sea otters</strong></p>' }],
            streaming: true
          }
        ]
      })
    );
    const live = p.window.document.querySelector('#thread .turn.live');
    assert.equal(live?.querySelector('strong')?.textContent, 'Sea otters');
    assert.equal(live?.querySelector('.raw'), null, 'nothing left showing its own markup');
  });

  it('shows the live reply in place of the dots, never both', (t) => {
    // Dots mean "something is owed and nothing has arrived". Once words are
    // arriving, they are the answer to that.
    const p = openThread(
      t,
      threadView({
        status: 'busy',
        exchanges: [
          {
            role: 'assistant',
            text: 'half a sen',
            blocks: [{ html: 'half a sen' }],
            streaming: true
          }
        ]
      })
    );
    assert.equal(p.window.document.querySelector('#thread .working'), null);
  });

  it('lets the finished turn replace the live one', (t) => {
    const groups = [groupView({ sessions: [cardView({ pid: 1 })] })];
    const p = openThread(
      t,
      threadView({
        pid: 1,
        status: 'busy',
        exchanges: [
          {
            role: 'assistant',
            text: '<p>Reading the f</p>',
            blocks: [{ html: '<p>Reading the f</p>' }],
            streaming: true
          }
        ]
      })
    );
    p.push(
      stateMessage(groups, {
        thread: threadView({
          pid: 1,
          status: 'idle',
          exchanges: [
            {
              role: 'assistant',
              text: 'Reading the file. Done.',
              blocks: [{ html: '<p>done</p>' }]
            }
          ]
        })
      })
    );
    assert.equal(
      p.window.document.querySelector('#thread .turn.live'),
      null,
      'the live copy is gone once the real turn is here'
    );
  });
});
