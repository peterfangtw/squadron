import * as assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { cardView, groupView, openThread, stateMessage, threadView, Panel } from '../harness';
import { outboxBody, openQueued, sessionRef, sonnetPick } from './chat_helpers';

describe('a name in a turn', () => {
  describe('a reference to another session', () => {
    const ref = '@squadron[6085][/t/d6913539.jsonl]';
    const named = (t: TestContext, text: string): Panel => {
      const thread = threadView({
        exchanges: [{ role: 'user', text: '', blocks: [{ prose: text }] }]
      });
      const p = openThread(t, thread);
      const sessions = [
        cardView({ pid: thread.pid, startedAt: thread.startedAt }),
        cardView({ pid: 6085, name: 'Lane rules' })
      ];
      p.push(stateMessage([groupView({ sessions })], { thread }));
      return p;
    };

    it('is drawn as a pill named after its card', (t) => {
      const body = named(t, `read ${ref} first`).window.document.querySelector(
        '#thread .turn .body'
      );
      const pill = body?.querySelector('.sref');
      assert.equal(pill?.textContent, '@Lane rules');
      assert.equal((pill as HTMLElement | null)?.dataset.tip, '/t/d6913539.jsonl');
      assert.equal(body?.textContent, 'read @Lane rules first');
    });

    it('says its pid once the card is gone', (t) => {
      const thread = threadView({
        exchanges: [{ role: 'user', text: '', blocks: [{ prose: ref }] }]
      });
      const pill = openThread(t, thread).window.document.querySelector('#thread .sref');
      assert.equal(pill?.textContent, '@session 6085');
    });

    it('is a pill while it waits in the queue', (t) => {
      const thread = threadView({ status: 'busy', queued: [{ id: 'q1', text: `ask ${ref}` }] });
      const p = openThread(t, thread);
      const sessions = [
        cardView({ pid: thread.pid, startedAt: thread.startedAt }),
        cardView({ pid: 6085, name: 'Lane rules' })
      ];
      p.push(stateMessage([groupView({ sessions })], { thread }));
      const raw = p.window.document.querySelector('#thread .outbox .body');
      assert.equal(raw?.querySelector('.sref')?.textContent, '@Lane rules');
    });

    it('follows a rename while the turn is still being written', (t) => {
      const thread = threadView({
        status: 'busy',
        exchanges: [
          { role: 'assistant', text: ref, blocks: [{ html: `<p>${ref}</p>` }], streaming: true }
        ]
      });
      const p = openThread(t, thread);
      const board = (name: string) =>
        stateMessage(
          [
            groupView({
              sessions: [
                cardView({ pid: thread.pid, startedAt: thread.startedAt }),
                cardView({ pid: 6085, name })
              ]
            })
          ],
          { thread }
        );
      p.push(board('Before'));
      p.push(board('After'));
      assert.equal(p.window.document.querySelector('#thread .live .sref')?.textContent, '@After');
    });

    it('redraws when names trade a comma between them', (t) => {
      const two = `${ref} @squadron[6086][/t/b.jsonl]`;
      const thread = threadView({
        exchanges: [{ role: 'user', text: '', blocks: [{ prose: two }] }]
      });
      const p = openThread(t, thread);
      const board = (a: string, b: string) =>
        stateMessage(
          [
            groupView({
              sessions: [
                cardView({ pid: thread.pid, startedAt: thread.startedAt }),
                cardView({ pid: 6085, name: a }),
                cardView({ pid: 6086, name: b })
              ]
            })
          ],
          { thread }
        );
      p.push(board('A,B', 'C'));
      p.push(board('A', 'B,C'));
      const pills = [...p.window.document.querySelectorAll('#thread .sref')].map(
        (s) => s.textContent
      );
      assert.deepEqual(pills, ['@A', '@B,C']);
    });

    it('stays as written inside code', (t) => {
      const body = named(t, `\`${ref}\``).window.document.querySelector('#thread .turn .body');
      assert.equal(body?.querySelector('.sref'), null);
      assert.equal(body?.textContent, ref);
    });
  });

  describe('a skill named in a turn', () => {
    const said = (
      t: TestContext,
      role: 'user' | 'assistant',
      source: string,
      skills = ['dataviz']
    ): Panel =>
      openThread(
        t,
        threadView({
          skills,
          exchanges: [
            {
              role,
              text: '',
              blocks: [role === 'user' ? { prose: source } : { html: source }]
            }
          ]
        })
      );

    it('is drawn as an @ pill in the reader’s own turn', (t) => {
      const body = said(t, 'user', 'use the dataviz skill now').window.document.querySelector(
        '#thread .turn .body'
      );
      const pill = body?.querySelector('.sref.skill');
      assert.equal(pill?.textContent, '@dataviz');
      assert.equal((pill as HTMLElement | null)?.dataset.tip, 'the dataviz skill');
      assert.equal(body?.textContent, 'use @dataviz now');
    });

    it('stays prose in the assistant’s turn', (t) => {
      const doc = said(t, 'assistant', '<p>I used the dataviz skill</p>').window.document;
      assert.equal(doc.querySelector('#thread .sref.skill'), null);
    });

    it('stays prose when the session has no such skill', (t) => {
      const doc = said(t, 'user', 'fix the stupid dataviz skill', ['stupid']).window.document;
      assert.equal(doc.querySelector('#thread .sref.skill'), null);
    });

    it('stays as written inside code', (t) => {
      const doc = said(t, 'user', '`the dataviz skill`').window.document;
      assert.equal(doc.querySelector('#thread .sref.skill'), null);
    });

    it('is drawn once the session’s skills arrive', (t) => {
      const exchanges = [
        { role: 'user' as const, text: '', blocks: [{ prose: 'the dataviz skill' }] }
      ];
      // The fixture's default list already holds `dataviz`.
      const before = threadView({ exchanges, skills: [] });
      const p = openThread(t, before);
      assert.equal(p.window.document.querySelector('#thread .sref.skill'), null);
      const after = { ...before, skills: ['dataviz'] };
      const sessions = [cardView({ pid: before.pid, startedAt: before.startedAt })];
      p.push(stateMessage([groupView({ sessions })], { thread: after }));
      assert.equal(p.window.document.querySelector('#thread .sref.skill')?.textContent, '@dataviz');
    });

    it('is a pill while it waits in the queue', (t) => {
      const thread = threadView({
        skills: ['dataviz'],
        status: 'busy',
        queued: [{ id: 'q1', text: 'then the dataviz skill' }]
      });
      const raw = openThread(t, thread).window.document.querySelector('#thread .outbox .body');
      assert.equal(raw?.querySelector('.sref.skill')?.textContent, '@dataviz');
    });
  });

  describe('a model named in a turn', () => {
    const plain =
      'a peer on Sonnet 5.5 200k (squadron-spawn --brand claude --model-id claude-sonnet-5-5 --context 200000)';
    const high =
      'a peer on Sonnet 5.5 200k at high effort (squadron-spawn --brand claude --model-id claude-sonnet-5-5 --context 200000 --effort high)';
    const said = (
      t: TestContext,
      source: string,
      role: 'user' | 'assistant' = 'user',
      from?: string
    ): Panel =>
      openThread(
        t,
        threadView({
          exchanges: [
            {
              role,
              text: '',
              blocks: [role === 'user' ? { prose: source } : { html: source }],
              ...(from ? { from } : {})
            }
          ]
        })
      );
    const body = (p: Panel) => p.window.document.querySelector('#thread .turn .body');

    it('is drawn as a pill named after the model in the reader’s own turn', (t) => {
      const turn = body(said(t, `ask ${plain} to check`));
      const pill = turn?.querySelector('.sref.model');
      assert.equal(pill?.textContent, '@Sonnet 5.5 200k');
      assert.equal((pill as HTMLElement | null)?.dataset.tip, plain);
      assert.equal(turn?.textContent, 'ask @Sonnet 5.5 200k to check');
    });

    it('names the effort when the pick carried one', (t) => {
      const pill = body(said(t, high))?.querySelector('.sref.model');
      assert.equal(pill?.textContent, '@Sonnet 5.5 200k · high');
      assert.equal((pill as HTMLElement | null)?.dataset.tip, high);
    });

    it('is a pill in the assistant’s turn and in a peer’s', (t) => {
      const assistant = body(said(t, `<p>${plain}</p>`, 'assistant'));
      assert.equal(assistant?.querySelector('.sref.model')?.textContent, '@Sonnet 5.5 200k');
      const peer = body(said(t, plain, 'user', 'sess-a1b2c3d4'));
      assert.equal(peer?.querySelector('.sref.model')?.textContent, '@Sonnet 5.5 200k');
    });

    it('stays as written inside code', (t) => {
      const turn = body(said(t, `\`${plain}\``));
      assert.equal(turn?.querySelector('.sref.model'), null);
      assert.equal(turn?.textContent, plain);
    });

    it('is a pill while it waits in the queue', (t) => {
      const thread = threadView({ status: 'busy', queued: [{ id: 'q1', text: `then ${plain}` }] });
      const raw = openThread(t, thread).window.document.querySelector('#thread .outbox .body');
      assert.equal(raw?.querySelector('.sref.model')?.textContent, '@Sonnet 5.5 200k');
    });

    it('wears the model control’s grey, never a session’s gold', (t) => {
      // jsdom resolves the cascade but not var(): the declaration that won is
      // what is checked.
      const p = said(t, plain);
      const pill = body(p)?.querySelector('.sref.model');
      assert.ok(pill, 'no model pill painted');
      const style = p.window.getComputedStyle(pill);
      for (const value of [style.getPropertyValue('background'), style.boxShadow]) {
        assert.match(value, /var\(--av-fg-3\)/);
        assert.doesNotMatch(value, /--av-(orange|yellow|green|purple|link)/);
      }
    });
  });
});

describe('a name in a turn someone sent', () => {
  describe('an in-flight row', () => {
    it('does not pill a model expansion or a session reference inside code', (t) => {
      const body = outboxBody(openQueued(t, `see \`${sonnetPick}\` and \`${sessionRef}\``));
      assert.ok(body?.querySelector('code'), 'the span was not code');
      assert.equal(body?.querySelector('code .sref'), null);
      assert.equal(body?.querySelector('.sref'), null);
      assert.match(body?.querySelector('code')?.textContent ?? '', /squadron-spawn/);
      assert.match(body?.textContent ?? '', /@squadron\[6085\]/);
    });
  });
});
