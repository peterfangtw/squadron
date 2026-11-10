import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertedMessageBody,
  Panel,
  answerOpen,
  cardView,
  groupView,
  lastOpen,
  newDraft,
  openPanel,
  sendDraft,
  stateMessage,
  threadView,
  typeIn,
  composerValue
} from '../harness';
import { COPY } from './board_helpers';
import { css as boardCss } from '../../ui/css/board';
import * as tickets from '../../ui/css/tickets';
import * as workflowsMode from '../../ui/css/workflows_mode';
import { buildGroups } from '../../ui/views';

/** The specs row without the idle time that now shares it. */
const specBits = (p: Panel): string =>
  [...p.window.document.querySelectorAll('.specs > :not(.since)')]
    .map((n) => n.textContent)
    .join('');

describe('the card list', () => {
  it('paints native host group components and opens a draft with the raw cwd', (t) => {
    const cwd = 'C:\\work\\App';
    const p = openPanel(t);
    p.push(stateMessage(buildGroups([], cwd)));
    const head = p.window.document.querySelector('h2');
    assert.equal(head?.querySelector('.app')?.textContent, 'C:\\work');
    assert.ok(head?.textContent?.includes('App'));
    sendDraft(p, 'Check paths');
    assert.equal(lastOpen(p).cwd, cwd);
  });
  it('renders a card for a session', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ name: 'alpha', status: 'busy' })] })]));
    const card = p.window.document.querySelector('.card.busy');
    assert.ok(card, 'no card rendered');
    assert.equal(card.querySelector('.name')?.textContent, 'alpha');
    assert.equal(card.querySelector('.pill')?.textContent, 'busy');
    // The status dot: card markup like the name and the pill, coloured by CSS.
    assert.ok(card.querySelector('.head .dot'), 'no status dot');
  });

  it('gives the title a row of its own, under the status strip', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ name: 'alpha' })] })]));
    const card = p.window.document.querySelector('.card');
    // Out of the head row, where the state word and the buttons were taking the
    // width a long title needs: the card's second child, after that row.
    assert.equal(card?.children[1]?.className, 'name');
  });

  // The height rule, as the only claim about it jsdom can make: jsdom lays
  // nothing out, so what is testable here is that the *rows* do not vary. The
  // pixels are measured by hand — the numbers and where they were taken are on
  // the `.card .name` rule in `ui/css/board.ts`.
  //
  // Three fields are the whole risk, so three fields is the fixture: a title
  // long enough for a second line, a context reading, and the command chip —
  // which sits in the head row rather than adding one of its own.
  it('draws the same four rows on every card, whatever the session reports', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({ pid: 1, name: 'a' }),
            cardView({
              pid: 2,
              name: 'a session whose title runs long enough to take both of the lines it is given',
              status: 'busy',
              hasCommand: true,
              contextPct: 62
            })
          ]
        })
      ])
    );
    // Not the add slot, which is a `.card` for the grid's sake and two halves
    // inside — it stretches to the row like anything else in it.
    const rows = [...p.window.document.querySelectorAll('.card:not(.add)')].map((c) =>
      [...c.children].map((n) => n.className.split(' ')[0])
    );
    assert.deepEqual(rows, [
      ['head', 'name', 'specs', 'foot'],
      ['head', 'name', 'specs', 'foot']
    ]);
  });

  it('carries the whole title in the name tooltip, cut or not', (t) => {
    const p = openPanel(t);
    const name = 'Investigate why the panel drops sessions after a window reload';
    p.push(stateMessage([groupView({ sessions: [cardView({ name })] })]));
    // The card's own tooltip is the cwd, so without this a clipped title is
    // readable nowhere at all.
    assert.equal(p.window.document.querySelector<HTMLElement>('.card .name')?.dataset.tip, name);
  });

  it('renders a group heading with its app, and names no window', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({ label: '~/proj', app: 'VS Code' }),
        groupView({ label: '~/other', app: '', cwd: '/Users/someone/other' })
      ])
    );
    const heads = p.window.document.querySelectorAll('h2');
    assert.equal(heads.length, 2);
    assert.equal(heads[0]?.querySelector('.app')?.textContent, 'VS Code');
    // Row 71: a section is a directory, and the board has no other window's.
    assert.equal(heads[0]?.querySelector('.here'), null);
    assert.equal(heads[1]?.querySelector('.app'), null);
    assert.equal(heads[1]?.querySelector('.here'), null);
  });

  it('prefers waitingFor over status on the pill', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({ sessions: [cardView({ status: 'waiting', waitingFor: 'permission' })] })
      ])
    );
    assert.equal(p.window.document.querySelector('.card .pill')?.textContent, 'permission');
  });

  it('says a session finished what it set out to do', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [cardView({ status: 'idle', completion: { total: 5, completed: 5 } })]
        })
      ])
    );
    assert.equal(p.window.document.querySelector('.card .pill')?.textContent, 'done');
  });

  it('labels unfinished work stalled without step counts', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [cardView({ status: 'idle', completion: { total: 7, completed: 3 } })]
        })
      ])
    );
    assert.equal(p.window.document.querySelector('.card .pill')?.textContent, 'stalled');
  });

  it('leaves a card with nothing to say about its progress reading idle', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ status: 'idle' })] })]));
    assert.equal(p.window.document.querySelector('.card .pill')?.textContent, 'idle');
  });

  it('gives each progress word its own hue, on top of idle', (t) => {
    // A facet class, not a replacement: the card is still an idle card, and
    // every rule keyed on `.idle` still has to find it.
    const p = openPanel(t);
    for (const [completion, facet] of [
      [{ total: 5, completed: 5 }, 'done'],
      [{ total: 7, completed: 3 }, 'stalled']
    ] as const) {
      p.push(stateMessage([groupView({ sessions: [cardView({ status: 'idle', completion })] })]));
      const card = p.window.document.querySelector('.card');
      assert.ok(card?.classList.contains('idle'), 'the card left the idle hue');
      assert.ok(card?.classList.contains(facet), `no ${facet} hue on the card`);
    }
  });

  it('leaves a card with nothing to say about its progress unhued', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ status: 'idle' })] })]));
    const card = p.window.document.querySelector('.card');
    assert.ok(card?.classList.contains('idle'));
    assert.equal(card?.classList.contains('done'), false);
    assert.equal(card?.classList.contains('stalled'), false);
  });

  it('reads done when a session replied after the reader last opened it', (t) => {
    // The generic rule, which needs no step list — the common turn, a question
    // asked and answered, is exactly the one that writes none.
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ status: 'idle', unseen: true })] })]));
    const card = p.window.document.querySelector('.card');
    assert.equal(card?.querySelector('.pill')?.textContent, 'done');
    assert.ok(card?.classList.contains('done'), 'no done hue on an unseen card');
    assert.ok(card?.classList.contains('idle'), 'the card left the idle hue');
  });

  it('keeps done on the open card until a deliberate acknowledgement', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: 5, status: 'idle' })] })]));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(
      stateMessage(
        [groupView({ sessions: [cardView({ pid: 5, status: 'idle', unseen: true })] })],
        {
          thread: threadView({ pid: 5 })
        }
      )
    );
    const card = p.window.document.querySelector('.card');
    assert.ok(card?.classList.contains('selected'), 'the card under test is not the open one');
    assert.equal(card?.querySelector('.pill')?.textContent, 'done');
    assert.equal(card?.classList.contains('done'), true);
  });

  it('still says done on the cards the reader does not have open', (t) => {
    // The one per-window rule in the derivation, and only the open card gets
    // it: another session finishing is still worth looking at.
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [cardView({ pid: 5, status: 'idle' }), cardView({ pid: 6, status: 'idle' })]
        })
      ])
    );
    p.window.document.querySelector<HTMLElement>('.card[data-pid="5"]')?.click();
    p.push(
      stateMessage(
        [
          groupView({
            sessions: [
              cardView({ pid: 5, status: 'idle', unseen: true }),
              cardView({ pid: 6, status: 'idle', unseen: true })
            ]
          })
        ],
        { thread: threadView({ pid: 5 }) }
      )
    );
    const open = p.window.document.querySelector('.card[data-pid="5"]');
    const other = p.window.document.querySelector('.card[data-pid="6"]');
    assert.equal(open?.querySelector('.pill')?.textContent, 'done');
    assert.equal(other?.querySelector('.pill')?.textContent, 'done');
    assert.ok(other?.classList.contains('done'));
  });

  it('ranks what a session is blocked on above what it delivered', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [cardView({ status: 'waiting', waitingFor: 'permission', unseen: true })]
        })
      ])
    );
    const card = p.window.document.querySelector('.card');
    assert.equal(card?.querySelector('.pill')?.textContent, 'permission');
    assert.equal(card?.classList.contains('done'), false, 'a word it never drew hued it');
  });

  it('keeps stalled on a card that has also gone unseen', (t) => {
    // `stalled` is the reading the step list was built for and it outranks the
    // generic word: steps left is more worth finding than output unread.
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({ status: 'idle', completion: { total: 7, completed: 3 }, unseen: true })
          ]
        })
      ])
    );
    const card = p.window.document.querySelector('.card');
    assert.equal(card?.querySelector('.pill')?.textContent, 'stalled');
    assert.ok(card?.classList.contains('stalled'));
    assert.equal(card?.classList.contains('done'), false);
  });

  it('hues the card for the word it actually drew, not the one it had', (t) => {
    // The pill ranks `waitingFor` above progress, and the hue has to rank the
    // same way: a card saying `permission` in orange must not also be wearing
    // the stalled hue for a word it never showed.
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({
              status: 'waiting',
              waitingFor: 'permission',
              completion: { total: 7, completed: 3 }
            })
          ]
        })
      ])
    );
    const card = p.window.document.querySelector('.card');
    assert.equal(card?.querySelector('.pill')?.textContent, 'permission');
    assert.ok(card?.classList.contains('waiting'), 'the card left the waiting hue');
    assert.equal(card?.classList.contains('stalled'), false, 'a word it never drew hued it');
  });

  it('reads failed in red when its last turn could not run, on top of idle', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ status: 'idle', turnOutcome: 'error' })] })])
    );
    const card = p.window.document.querySelector('.card');
    assert.equal(card?.querySelector('.pill')?.textContent, 'failed');
    assert.ok(card?.classList.contains('failed'), 'no failed hue on the card');
    assert.ok(card?.classList.contains('idle'), 'the card left the idle hue');
  });

  it('ranks failed over stalled, done and unread', (t) => {
    const p = openPanel(t);
    for (const completion of [{ total: 7, completed: 3 }, { total: 5, completed: 5 }, undefined]) {
      p.push(
        stateMessage([
          groupView({
            sessions: [cardView({ status: 'idle', turnOutcome: 'error', completion, unseen: true })]
          })
        ])
      );
      const card = p.window.document.querySelector('.card');
      assert.equal(card?.querySelector('.pill')?.textContent, 'failed');
      assert.ok(card?.classList.contains('failed'));
      assert.equal(card?.classList.contains('stalled'), false);
      assert.equal(card?.classList.contains('done'), false);
    }
  });

  it('keeps failed on the card the reader has open', (t) => {
    // Unlike `done`, which says only that nobody looked: opening the dock on a
    // turn that could not run does not make it run.
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: 5, status: 'idle' })] })]));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(
      stateMessage(
        [groupView({ sessions: [cardView({ pid: 5, status: 'idle', turnOutcome: 'error' })] })],
        { thread: threadView({ pid: 5 }) }
      )
    );
    const card = p.window.document.querySelector('.card');
    assert.ok(card?.classList.contains('selected'), 'the card under test is not the open one');
    assert.equal(card?.querySelector('.pill')?.textContent, 'failed');
    assert.ok(card?.classList.contains('failed'));
  });

  it('leaves the waiting word over a failed turn', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({ status: 'waiting', waitingFor: 'permission', turnOutcome: 'error' })
          ]
        })
      ])
    );
    const card = p.window.document.querySelector('.card');
    assert.equal(card?.querySelector('.pill')?.textContent, 'permission');
    assert.equal(card?.classList.contains('failed'), false);
  });

  it('reads busy while a new turn runs after a failed one', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ status: 'busy', turnOutcome: 'error' })] })])
    );
    const card = p.window.document.querySelector('.card');
    assert.equal(card?.querySelector('.pill')?.textContent, 'busy');
    assert.equal(card?.classList.contains('failed'), false);
  });

  it('reads a finished or interrupted turn as it always has', (t) => {
    const p = openPanel(t);
    for (const turnOutcome of ['done', 'interrupted'] as const) {
      p.push(stateMessage([groupView({ sessions: [cardView({ status: 'idle', turnOutcome })] })]));
      const card = p.window.document.querySelector('.card');
      assert.equal(card?.querySelector('.pill')?.textContent, 'idle');
      assert.equal(card?.classList.contains('failed'), false);
    }
  });

  it('uses lifecycle tokens, with no status dim and one attention pulse', () => {
    const clean = boardCss.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(clean, /\.card\.idle[^{}]*\{/);
    assert.doesNotMatch(clean, /\.card\.idle\.failed/);
    assert.match(clean, /\.card\.failed, #status-menu \.dot\.failed \{ --st: var\(--av-red\); \}/);
    assert.doesNotMatch(clean, /\.card \.pill[^}]*opacity/);
    for (const selector of ['.card.add', '.card.starting', '.card.closing', '.fam-head .g']) {
      const rule = clean.slice(clean.indexOf('\n  ' + selector + ' {')).split('}')[0] ?? '';
      assert.match(rule, /opacity: var\(--av-dim\)/, selector);
    }
    assert.match(clean, /\.card\.add\.busy[^}]*opacity: var\(--av-ghost\)/);
    assert.match(
      clean,
      /@media \(prefers-reduced-motion: no-preference\) \{\s*\.card\.attention \.dot \{ animation: pulse var\(--pulse-period\) ease-in-out infinite; \}/
    );
    assert.doesNotMatch(clean, /\.card\.(busy|waiting) \.dot \{ animation/);
  });

  it('uses the shared tokens for lifted sources and receded drag surfaces', () => {
    assert.match(tickets.css, /#cards \.lifted \{ opacity: var\(--av-ghost\)/);
    assert.match(tickets.css, /#cards \[data-inert\] \{ opacity: var\(--av-dim\)/);
    assert.match(workflowsMode.css, /\.wsrow\.lifted \{ opacity: var\(--av-ghost\)/);
  });

  it('chips a session that is running a command, in any state', (t) => {
    const p = openPanel(t);
    for (const status of ['idle', 'busy', 'waiting'] as const) {
      p.push(stateMessage([groupView({ sessions: [cardView({ status, hasCommand: true })] })]));
      const head = p.window.document.querySelector('.card .head');
      const command = head?.querySelector('.cmd');
      assert.ok(command, `no command indicator on a ${status} card`);
      assert.ok(command.querySelector('svg'), `no command icon on a ${status} card`);
      assert.equal(command.textContent, '');
      assert.equal(command.getAttribute('aria-label'), 'Running a command');
      // Beside the state word, not under it: the chip is a second fact about
      // the same session, not a second row of card.
      assert.ok(head?.querySelector('.pill'), `the ${status} card lost its pill`);
      assert.equal(p.window.document.querySelectorAll('.card > .cmd').length, 0);
    }
  });

  it('leaves a card that is running nothing unchipped', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ status: 'idle' })] })]));
    assert.equal(p.window.document.querySelector('.card .cmd'), null);
  });

  it('groups permission mode with model and effort, away from branch and context', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({
              model: 'opus',
              effort: 'high',
              branch: 'staging',
              contextPct: 43,
              contextSize: 1_000_000,
              mode: { label: 'bypass', bypass: true, holds: false }
            })
          ]
        })
      ])
    );
    assert.equal(specBits(p), 'opus·high·⏵⏵bypass');
    const foot = p.window.document.querySelector('.card .foot');
    assert.equal(foot?.querySelector('.br .n')?.textContent, 'staging');
    assert.equal(foot?.querySelector('.strip-reading')?.textContent, '43% / 1M');
    assert.equal(foot?.querySelector('.mode'), null);
    assert.match(p.window.document.querySelector('.specs .mode')?.textContent ?? '', /bypass/);
  });

  describe('context readings in the branch strip', () => {
    const cases = [
      { over: { contextSize: 200_000 }, expected: '— / 200k' },
      { over: {}, expected: '—' },
      { over: { contextTokens: 12_000, contextSize: 200_000 }, expected: '12k used / 200k' },
      {
        over: { contextPct: 20, contextSize: 200_000, contextAsked: 1_000_000 },
        expected: '20% / 200k↓'
      },
      { over: { contextPct: 20, contextSize: 1_000_000 }, expected: '20% / 1M' },
      { over: { contextSize: 200_000, contextAsked: 1_000_000 }, expected: '— / 200k↓' }
    ];
    for (const { over, expected } of cases) {
      it(`states ${expected}`, (t) => {
        const p = openPanel(t);
        p.push(stateMessage([groupView({ sessions: [cardView({ model: 'opus', ...over })] })]));
        assert.equal(specBits(p), 'opus');
        const reading = p.window.document.querySelector<HTMLElement>('.foot .strip-reading');
        assert.equal(reading?.textContent, expected);
        if ('contextAsked' in over) {
          assert.ok(reading?.querySelector('.ctx-held'));
          assert.match(reading?.dataset.tip ?? '', /asked for 1M, running in 200k/);
          assert.doesNotMatch(reading?.dataset.tip ?? '', /account/);
        } else {
          assert.equal(reading?.querySelector('.ctx-held'), null);
        }
      });
    }
  });

  /**
   * The model bit is a reading, and the whole of what this block is for is that
   * it stays one. It was a button on a piped card (taskhub H4(2),
   * `docs/mockups/spawn-model-on-card.html` §2) until the pick was found to buy
   * nothing on its own: `set_model` lands on the next turn, and a board is
   * where nobody is writing one. The menu moved to the composer's pill, whose
   * behaviour `chat_composer.test.ts` holds — the list, the tick, the pick, the cost
   * line and the empty case, all against `modelMenuBody`, which is still shared
   * and still exported.
   */
  describe('the model bit', () => {
    const MODELS: ModelView[] = [
      { value: 'opus', name: 'Opus', id: 'claude-opus-5[1m]', brand: 'claude' },
      { value: 'haiku', name: 'Haiku', id: 'claude-haiku-4-5-20251001', brand: 'claude' }
    ];

    /** The card's model bit, whatever it turned out to be drawn as. */
    const modelBit = (p: Panel): HTMLElement | null =>
      p.window.document.querySelector<HTMLElement>('.card .s-model');

    const piped = (over: Partial<CardView> = {}) =>
      stateMessage(
        [
          groupView({
            sessions: [cardView({ owned: true, model: 'opus', ...over })]
          })
        ],
        { models: MODELS }
      );

    it('is a reading on a session that runs on a pipe', (t) => {
      const p = openPanel(t);
      p.push(piped());
      const bit = modelBit(p);
      assert.ok(bit, 'no model bit');
      // A span, not a button: nothing on the specs line takes a press any more,
      // and a tag that announces itself as a control offers one that is gone.
      assert.equal(bit.tagName, 'SPAN');
      assert.equal(bit.getAttribute('aria-haspopup'), null);
      // The reading, said in the catalog's words — the row this spelling names.
      assert.equal(bit.textContent, 'Opus');
    });

    it('leads with the brand mark, and puts the name in the bit that hides', (t) => {
      const p = openPanel(t);
      p.push(piped({ brand: 'claude' }));
      const bit = modelBit(p);
      const mark = bit?.querySelector('.bmwrap');
      assert.ok(mark, 'no brand mark in the model bit');
      assert.equal(bit?.firstElementChild, mark, 'mark does not lead the name');
      assert.ok(mark.querySelector('svg'), 'mark drew no svg');
      // The 180px tier hides `.s-name`, so which CLI this is outlives the id it
      // ran: the mark has to sit outside that span and the name inside it.
      const name = bit?.querySelector('.s-name');
      assert.ok(name, 'the model id is not in a .s-name of its own');
      assert.equal(name.textContent, 'Opus');
      assert.equal(name.querySelector('.bmwrap'), null, 'the mark hides with the name');
      // The name itself is untouched — the mark carries no text.
      assert.equal(bit?.textContent, 'Opus');
    });

    it('draws no mark for a session whose brand nothing stated', (t) => {
      const p = openPanel(t);
      // Explicitly undefined: the fixture defaults to `claude`, as the wire
      // does today, so the degraded case has to be asked for.
      p.push(piped({ brand: undefined }));
      assert.equal(modelBit(p)?.querySelector('.bmwrap'), null);
    });

    it('is the same reading on a session another window drives', (t) => {
      const p = openPanel(t);
      p.push(
        stateMessage([groupView({ sessions: [cardView({ model: 'opus' })] })], {
          models: MODELS
        })
      );
      const bit = modelBit(p);
      assert.ok(bit, 'the model bit went missing on a card this window cannot reach');
      assert.equal(bit.tagName, 'SPAN');
      assert.equal(bit.textContent, 'Opus');
    });

    it('opens nothing and posts nothing when it is clicked', (t) => {
      const p = openPanel(t);
      p.push(piped({ pid: 404 }));
      const bit = modelBit(p);
      assert.ok(bit, 'no model bit');
      bit.click();
      assert.equal(
        p.window.document.querySelector('.card .fmenu:not([hidden])'),
        null,
        'the model bit still opens a menu'
      );
      assert.equal(p.posted.filter((m) => m.type === 'send').length, 0);
    });

    /** A card with no model of its own still names something, since the specs
     *  line reads as a row of facts and a gap in it reads as a missing one.
     *  The name is the brand the seam stated, never a hardcoded `claude` —
     *  a Grok start paints before the CLI names the model, and inventing
     *  Claude there is the flash this suite is for. */
    it('falls back to the brand when the session stated no model', (t) => {
      const p = openPanel(t);
      p.push(piped({ model: undefined }));
      assert.equal(modelBit(p)?.textContent, 'claude');
    });

    it('falls back to grok, not claude, on a Grok card that has named no model', (t) => {
      const p = openPanel(t);
      p.push(piped({ brand: 'grok', model: undefined }));
      assert.equal(modelBit(p)?.querySelector('.s-name')?.textContent, 'grok');
      assert.equal(modelBit(p)?.querySelector('.bm.cl'), null, 'drew Claude’s mark');
    });

    it('prints the launch pick before the CLI has named a model', (t) => {
      const p = openPanel(t);
      p.push(piped({ brand: 'grok', model: undefined, modelPick: 'grok-4.6' }));
      assert.equal(modelBit(p)?.querySelector('.s-name')?.textContent, 'grok-4.6');
    });

    it('keeps the reading over the launch pick once the CLI has named one', (t) => {
      const p = openPanel(t);
      p.push(piped({ brand: 'grok', model: 'grok-4.5', modelPick: 'grok-4.6' }));
      assert.equal(modelBit(p)?.querySelector('.s-name')?.textContent, 'grok-4.5');
    });

    it('draws no name when neither the session nor its brand has one', (t) => {
      const p = openPanel(t);
      p.push(piped({ brand: undefined, model: undefined, modelPick: undefined }));
      assert.equal(modelBit(p)?.querySelector('.s-name'), null);
      assert.equal(modelBit(p)?.textContent, '');
    });

    /**
     * The catalog's words, and the window with them.
     *
     * The bug these are for: a card read `claude-opus-4-5-20251101` for a
     * session the flyout draws as `Opus 4.5` (observed 2026-08-29). Three
     * models report a dated `message.model` that appears in no `value` and no
     * `id` (`cli_state/models.md`), so `readings` is the only join, and the
     * specs line was not making it.
     */
    describe('the name it spells', () => {
      const ROWS: ModelView[] = [
        {
          value: 'claude-opus-4-5',
          name: 'Opus 4.5',
          id: 'claude-opus-4-5',
          brand: 'claude',
          readings: ['claude-opus-4-5', 'claude-opus-4-5-20251101'],
          window: 200_000
        },
        {
          value: 'claude-opus-5',
          name: 'Opus 5',
          id: 'claude-opus-5',
          brand: 'claude',
          readings: ['claude-opus-5[1m]'],
          window: 1_000_000
        },
        {
          value: 'claude-opus-5',
          name: 'Opus 5',
          id: 'claude-opus-5',
          brand: 'claude',
          readings: ['claude-opus-5'],
          window: 200_000
        }
      ];

      const named = (t: Parameters<typeof openPanel>[0], over: Partial<CardView>) => {
        const p = openPanel(t);
        p.push(
          stateMessage([groupView({ sessions: [cardView({ owned: true, ...over })] })], {
            models: ROWS
          })
        );
        return p;
      };

      it('names the row a dated reading belongs to, window and all', (t) => {
        const p = named(t, { model: 'claude-opus-4-5-20251101' });
        assert.equal(modelBit(p)?.textContent, 'Opus 4.5 (200k)');
      });

      it('takes the window this session is in over the row it resolved', (t) => {
        // A start pinned to 200k reads `claude-opus-5` exactly as a 1M one
        // does. `contextSize` is what it is actually in, so it wins.
        const p = named(t, { model: 'claude-opus-5', contextSize: 1_000_000 });
        assert.equal(modelBit(p)?.textContent, 'Opus 5 (1M)');
      });

      it('names no window for a model that runs in two and stated neither', (t) => {
        // The guess worth refusing: half the sessions on this spelling are in
        // the other window, and the name would be stated with the same
        // confidence either way.
        const p = named(t, { model: 'claude-opus-5' });
        assert.equal(modelBit(p)?.textContent, 'Opus 5');
      });

      it('says an unknown id verbatim rather than naming a model of ours', (t) => {
        // What "Enter an id…" depends on: a row nobody wrote down is still a
        // session, and the card says what the CLI said.
        const p = named(t, { model: 'claude-sonnet-9' });
        assert.equal(modelBit(p)?.textContent, 'claude-sonnet-9');
      });

      it('does not join across brands', (t) => {
        // One CLI's spelling must never answer for another's — the list
        // carries every signed-in brand's rows.
        const p = named(t, { brand: 'grok', model: 'claude-opus-4-5' });
        assert.equal(modelBit(p)?.querySelector('.s-name')?.textContent, 'claude-opus-4-5');
      });

      it('keeps the footer window visible when the model names it too', (t) => {
        const p = named(t, {
          model: 'claude-opus-4-5-20251101',
          contextPct: 16,
          contextSize: 200_000
        });
        assert.equal(specBits(p), 'Opus 4.5 (200k)');
        assert.equal(p.window.document.querySelector('.strip-reading')?.textContent, '16% / 200k');
      });

      it('leaves the window on the context bit when the name could not say it', (t) => {
        const p = named(t, { model: 'claude-sonnet-9', contextPct: 16, contextSize: 200_000 });
        assert.equal(specBits(p), 'claude-sonnet-9');
        assert.equal(p.window.document.querySelector('.strip-reading')?.textContent, '16% / 200k');
      });

      it('drops the bare window bit the name has already covered', (t) => {
        const p = named(t, { model: 'claude-opus-4-5-20251101', contextSize: 200_000 });
        assert.equal(specBits(p), 'Opus 4.5 (200k)');
      });

      /** The one repetition worth keeping: the `↓` and its tooltip live inside
       *  the context bit, and a session held below what it asked for before
       *  running a turn would otherwise carry no mark at all. */
      it('keeps the window bit for a held session with nothing spent yet', (t) => {
        const p = named(t, {
          model: 'claude-opus-4-5-20251101',
          contextSize: 200_000,
          contextAsked: 1_000_000
        });
        assert.equal(specBits(p), 'Opus 4.5 (200k)');
        assert.equal(p.window.document.querySelector('.strip-reading')?.textContent, '— / 200k↓');
      });
    });
  });

  it('labels the add slot New, short enough for a narrow column', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [] })]));
    const open = p.window.document.querySelector('.card.add [data-act="open"]');
    assert.equal(
      open?.textContent
        ?.replace(/\s+/g, ' ')
        .trim()
        .replace(/^\+?\s*/, ''),
      'New'
    );
  });

  it('labels a 1M context window as such', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ contextPct: 10, contextSize: 900_000 })] })])
    );
    assert.equal(p.window.document.querySelector('.strip-reading')?.textContent, '10% / 1M');
  });

  it('states context as tokens when no window size was reported', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({ sessions: [cardView({ model: 'Opus 5', contextTokens: 109_989 })] })
      ])
    );
    assert.equal(specBits(p), 'Opus 5');
    assert.equal(p.window.document.querySelector('.strip-reading')?.textContent, '110k used');
    assert.equal(p.window.document.querySelector('.strip-fill'), null);
  });

  it('updates exact footer progress and distinguishes unknown usage from zero', (t) => {
    const p = openPanel(t);
    for (const pct of [undefined, 0, 30, 43, 70, 95, 100]) {
      p.push(stateMessage([groupView({ sessions: [cardView({ contextPct: pct })] })]));
      const foot = p.window.document.querySelector('.card .foot');
      const fill = foot?.querySelector<HTMLElement>('.strip-fill');
      const reading = foot?.querySelector('.strip-reading');
      if (pct === undefined) {
        assert.equal(fill, null);
        assert.equal(reading?.textContent, '—');
        assert.equal(reading?.getAttribute('role'), null);
        assert.match((reading as HTMLElement)?.dataset.tip ?? '', /unavailable/);
      } else {
        assert.equal(fill?.style.width, pct + '%');
        assert.equal(reading?.textContent, pct + '%');
        assert.equal(reading?.getAttribute('role'), 'meter');
        assert.equal(reading?.getAttribute('aria-valuenow'), String(pct));
        assert.equal(foot?.classList.contains('mid'), pct > 30 && pct <= 70);
        assert.equal(foot?.classList.contains('full'), pct > 70);
      }
    }
  });

  it('carries the idle time in the specs row rather than a row of its own', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({
              startedAt: Date.now() - 90 * 60_000,
              updatedAt: Date.now() - 12 * 60_000,
              model: 'opus'
            })
          ]
        })
      ])
    );
    const doc = p.window.document;
    // Since the last reply, not since the start: 12m, not the 1h30 it has run.
    // "ago" and all — a bare duration here reads as the age it replaced.
    assert.equal(doc.querySelector('.specs .since')?.textContent, '12m ago');
    // Exactly one, so the specs row is where it lives and not a second place.
    assert.equal(doc.querySelectorAll('.card .since').length, 1);
  });

  /**
   * The beat, and what it is allowed to touch.
   *
   * `main.ts` used to advance this one span by calling `renderBoard()` — the
   * whole card tree rebuilt and morphed once a second, measured at 60 of an idle
   * board's 64 paints a minute (`TASK_done_panel_repaint_cost.md`). It
   * calls `tickStamps()` now, and both halves of that trade need holding: the
   * stamp still has to move, and everything around it has to stop being rebuilt.
   *
   * Real timers exercise the entry-point interval; a controlled reading clock
   * makes rollover independent of when startup rendering finishes.
   */
  it('advances the stamp on its own beat, with no push behind it', async (t) => {
    const p = openPanel(t);
    let now = Date.now();
    p.window.Date.now = () => now;
    p.push(
      stateMessage([groupView({ sessions: [cardView({ updatedAt: now - (2 * 60_000 - 500) })] })])
    );
    const doc = p.window.document;
    assert.equal(doc.querySelector('.specs .since')?.textContent, '1m ago');
    now += 1000;
    await new Promise((done) => setTimeout(done, 1200));
    assert.equal(
      doc.querySelector('.specs .since')?.textContent,
      '2m ago',
      'the stamp sat still through a beat that was supposed to advance it'
    );
  });

  it('leaves the rest of the card alone while it does', async (t) => {
    // The point of the narrow path: identity. If the beat still went through the
    // reconciler these would be the same nodes anyway — morphdom keeps them — so
    // this asserts the card element and a sibling of the stamp are untouched,
    // which is what says no tree was rebuilt to move a clock.
    const p = openPanel(t);
    let now = Date.now();
    p.window.Date.now = () => now;
    p.push(stateMessage([groupView({ sessions: [cardView({ model: 'opus' })] })]));
    const doc = p.window.document;
    const card = doc.querySelector('.card');
    const model = doc.querySelector('.specs .s-model');
    const stamp = doc.querySelector('.specs .since');
    // Or the three comparisons below are null against null, and pass over a
    // board that drew nothing at all.
    assert.ok(card && model && stamp, 'the fixture drew no card, model or stamp');
    now += 1000;
    await new Promise((done) => setTimeout(done, 1200));
    assert.equal(doc.querySelector('.card'), card, 'the card was rebuilt by the beat');
    assert.equal(doc.querySelector('.specs .s-model'), model, 'the specs row was rebuilt');
    assert.notEqual(doc.querySelector('.specs .since'), stamp, 'the stamp was never replaced');
  });

  /**
   * The other half of the same trade. The beat above must replace a stamp whose
   * reading moved; this one must leave alone a stamp whose reading did not.
   *
   * `ago()` is seconds only under a minute — past that a card's words change
   * once a minute and its beat has 59 nothings to do. Replacing anyway is 20
   * nodes a second on a 20-card board to write the same string back, and it
   * takes the tip's anchor with it every time: `refreshTip` hides a tip whose
   * anchor left the document, and what has been quietly saving that tip is the
   * browser re-firing `mouseover` when the node under a still pointer changes,
   * inside `WARM_MS` so it reopens with no delay. A comfort feature holding a
   * tooltip up is not a thing to keep depending on.
   *
   * Every reading here is minutes old and none of them roll over inside a beat
   * — the stamp, and both rows of its tip.
   */
  it('holds the stamp it would have rewritten with the same words', async (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({ startedAt: Date.now() - 5 * 60_000, updatedAt: Date.now() - 5 * 60_000 })
          ]
        })
      ])
    );
    const doc = p.window.document;
    const stamp = doc.querySelector('.specs .since');
    assert.equal(stamp?.textContent, '5m ago', 'the fixture drew the wrong reading');
    await new Promise((done) => setTimeout(done, 1200));
    assert.equal(
      doc.querySelector('.specs .since'),
      stamp,
      'a beat with nothing to say replaced the stamp anyway'
    );
  });

  /**
   * The beat, and who it runs for.
   *
   * The host knows the panel is behind another tab and the document does not —
   * `retainContextWhenHidden` keeps it alive and a tab switch never touches
   * `visibilityState`, which reports the window. Measured: 101s backgrounded,
   * the host drew nothing at all and the beat ran 60 times a minute through a
   * gate that never fired (`TASK_done_panel_repaint_cost.md`).
   *
   * Nothing is lost by stopping: every one of these advances a clock, and a
   * clock read on the way back in is as current as one kept warm — the host
   * drops `lastState` on becoming visible and pushes at once, which repaints
   * all of it.
   */
  it('stops the beat when the host says nobody is looking', async (t) => {
    const p = openPanel(t);
    // Half a second past the reading, for the reason above: this pair turns on
    // whether one beat crosses 31s, and the beat lands within a few ms of the
    // second. Both halves take the same fixture so they stay each other's
    // control — here a beat that ran anyway would be seen, below one is needed.
    p.push(stateMessage([groupView({ sessions: [cardView({ updatedAt: Date.now() - 30_500 })] })]));
    const doc = p.window.document;
    const was = doc.querySelector('.specs .since')?.textContent;
    assert.equal(was, '30s ago', 'the fixture drew the wrong reading');
    p.push({ type: 'visible', visible: false });
    await new Promise((done) => setTimeout(done, 1200));
    assert.equal(
      doc.querySelector('.specs .since')?.textContent,
      was,
      'the beat advanced a stamp nobody was looking at'
    );
  });

  it('takes the beat back up when the panel is looked at again', async (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ updatedAt: Date.now() - 30_500 })] })]));
    const doc = p.window.document;
    p.push({ type: 'visible', visible: false });
    p.push({ type: 'visible', visible: true });
    await new Promise((done) => setTimeout(done, 1200));
    assert.notEqual(
      doc.querySelector('.specs .since')?.textContent,
      '30s ago',
      'the beat never came back'
    );
  });

  it('keeps the age in the tooltip the idle time replaced', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({ startedAt: Date.now() - 3 * 3600_000, updatedAt: Date.now() - 12 * 60_000 })
          ]
        })
      ])
    );
    const since = p.window.document.querySelector<HTMLElement>('.since');
    assert.equal(since?.dataset.tipHead, 'this session');
    assert.equal(
      since?.dataset.tipRows,
      JSON.stringify([
        ['started', '3h ago', ''],
        ['idle for', '12m', '']
      ])
    );
  });

  it('uses the resolved lifetime for heat', (t) => {
    const p = openPanel(t);
    const now = Date.now();
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({
              updatedAt: now - 25 * 60_000,
              cacheFrom: now - 25 * 60_000,
              cacheUntil: now + 5 * 60_000
            })
          ]
        })
      ])
    );
    const stamp = p.window.document.querySelector('.since');
    assert.ok(stamp?.classList.contains('cold'));
    assert.equal(stamp?.textContent, '25m ago');
  });

  it('counts a refreshed cache from its last traffic, keeping real idle in the tip', (t) => {
    const p = openPanel(t);
    const now = Date.now();
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({
              updatedAt: now - 70 * 60_000,
              cacheFrom: now - 10 * 60_000,
              cacheUntil: now + 50 * 60_000
            })
          ]
        })
      ])
    );
    const stamp = p.window.document.querySelector<HTMLElement>('.since');
    assert.equal(stamp?.classList.contains('cold'), false);
    assert.equal(stamp?.classList.contains('warm'), false);
    assert.equal(stamp?.textContent, '10m ago');
    assert.match(stamp?.dataset.tipRows ?? '', /idle for.*1h/);
  });

  it('counts from real activity when it is later than the last traffic', (t) => {
    const p = openPanel(t);
    const now = Date.now();
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({
              updatedAt: now - 5 * 60_000,
              cacheFrom: now - 30 * 60_000,
              cacheUntil: now + 30 * 60_000
            })
          ]
        })
      ])
    );
    assert.equal(p.window.document.querySelector('.since')?.textContent, '5m ago');
  });

  it("goes cold on the card's own lifetime when no turn has stamped it", (t) => {
    const p = openPanel(t);
    const now = Date.now();
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({
              updatedAt: now - 11 * 60_000,
              cacheTtlMs: 10 * 60_000,
              cacheFrom: undefined,
              cacheUntil: undefined
            })
          ]
        })
      ])
    );
    const since = p.window.document.querySelector('.since');
    assert.ok(since?.classList.contains('cold'));
    assert.equal(since?.textContent, '11m ago ❄︎');
  });

  it('warms at the half hour, on the way to the cache cliff', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ updatedAt: Date.now() - 35 * 60_000 })] })])
    );
    const since = p.window.document.querySelector('.since');
    assert.ok(since?.classList.contains('warm'), 'no warning on a 35m-idle card');
    assert.equal(since?.classList.contains('cold'), false);
  });

  it('goes cold before the hour, and only glyphs once the cache is gone', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ updatedAt: Date.now() - 52 * 60_000 })] })])
    );
    const since = p.window.document.querySelector('.since');
    assert.ok(since?.classList.contains('cold'), 'no cold tint on a 52m-idle card');
    assert.equal(since?.textContent, '52m ago');
  });

  it('marks a session whose prompt cache has gone', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ updatedAt: Date.now() - 70 * 60_000 })] })])
    );
    const since = p.window.document.querySelector('.since');
    assert.ok(since?.classList.contains('cold'), 'no cold mark past the hour');
    // The glyph carries the same news as the colour, for anyone the colour
    // does not reach.
    assert.equal(since?.textContent, '1h ago ❄︎');
  });

  it('never calls a busy session cold', (t) => {
    const p = openPanel(t);
    // A busy card's `updatedAt` is when the turn began, not a last reply — the
    // session is talking to the API right now, so its cache is warm by
    // definition however long the turn has run.
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({
              status: 'busy',
              startedAt: Date.now() - 60_000,
              updatedAt: Date.now() - 70 * 60_000
            })
          ]
        })
      ])
    );
    const since = p.window.document.querySelector<HTMLElement>('.since');
    assert.equal(since?.classList.contains('cold'), false);
    assert.equal(since?.classList.contains('warm'), false);
    assert.equal(
      since?.dataset.tipRows,
      JSON.stringify([
        ['started', '1m ago', ''],
        ['in turn', '1h', '']
      ])
    );
  });

  it('names the branch in the card footer', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ branch: 'feat/paste-images' })] })]));
    const foot = p.window.document.querySelector('.card .foot');
    assert.ok(foot, 'no footer on the card');
    // The name is its own element, so a long branch can ellipsis without
    // taking the glyph beside it with it.
    assert.equal(foot.querySelector('.br .n')?.textContent, 'feat/paste-images');
  });

  it('marks a worktree, and leaves an ordinary checkout unmarked', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({ pid: 1, branch: 'ui-refine', worktree: true }),
            cardView({ pid: 2, branch: 'main' })
          ]
        })
      ])
    );
    const cards = p.window.document.querySelectorAll('.card');
    // The group heading no longer says which of its cards are worktrees, so the
    // mark is the only thing that does.
    assert.ok(cards[0]?.querySelector('.foot .br.wt'), 'worktree not marked');
    assert.equal(cards[0]?.querySelector('.foot .br .g')?.textContent, '⑂');
    assert.equal(cards[1]?.querySelector('.foot .br.wt'), null);
    assert.equal(cards[1]?.querySelector('.foot .br .g')?.textContent, '⎇');
  });

  it('shows a detached head as what it is', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ branch: 'e056f24', detached: true })] })])
    );
    const br = p.window.document.querySelector('.card .foot .br');
    assert.equal(br?.querySelector('.g')?.textContent, '@');
    assert.equal(br?.querySelector('.n')?.textContent, 'e056f24');
  });

  it('keeps the footer on a card with no branch at all', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ branch: undefined })] })]));
    const card = p.window.document.querySelector('.card');
    // Rendered and empty, not absent: the strip is the card's bottom edge, and
    // a row of cards keeps its strips level whatever each one has to say.
    const foot = card?.querySelector('.foot');
    assert.ok(foot, 'footer dropped when there was no branch');
    assert.equal(foot.querySelector('.br'), null);
    // Last child, always — nothing may render below it.
    assert.equal(card?.lastElementChild, foot);
  });

  it('states the permission mode with the model specifications', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({
              pid: 1,
              branch: 'main',
              mode: { label: 'accept edits', holds: false, bypass: false }
            }),
            cardView({
              pid: 2,
              branch: 'main',
              mode: { label: 'plan', holds: true, bypass: false }
            })
          ]
        })
      ])
    );
    const cards = p.window.document.querySelectorAll('.card');
    // ⏵⏵ for a mode that lets work through, ⏸ for the one that holds it — the
    // marks the CLI itself prints under a session.
    assert.equal(cards[0]?.querySelector('.specs .mode .g')?.textContent, '⏵⏵');
    assert.match(cards[0]?.querySelector('.specs .mode')?.textContent ?? '', /accept edits/);
    assert.equal(cards[1]?.querySelector('.specs .mode .g')?.textContent, '⏸');
  });

  it('spends colour on bypass alone', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({ pid: 1, mode: { label: 'bypass', holds: false, bypass: true } }),
            cardView({ pid: 2, mode: { label: 'auto', holds: false, bypass: false } })
          ]
        })
      ])
    );
    const cards = p.window.document.querySelectorAll('.card');
    assert.ok(cards[0]?.querySelector('.specs .mode.bypass'), 'bypass not marked');
    assert.equal(cards[1]?.querySelector('.specs .mode.bypass'), null);
  });

  it('says nothing about the mode when there is nothing to say', (t) => {
    const p = openPanel(t);
    // What most cards are: `default`, or a session too new to have a transcript.
    p.push(
      stateMessage([groupView({ sessions: [cardView({ branch: 'main', mode: undefined })] })])
    );
    assert.equal(p.window.document.querySelector('.card .specs .mode'), null);
  });

  it('states the mode beside the model even without a branch', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({ branch: undefined, mode: { label: 'bypass', holds: false, bypass: true } })
          ]
        })
      ])
    );
    const card = p.window.document.querySelector('.card');
    assert.equal(card?.querySelector('.foot .br'), null);
    assert.equal(card?.querySelector('.specs .mode')?.className, 'mode bypass');
  });

  it('offers the End button only on interactive sessions', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({ pid: 1, canControl: true }),
            cardView({ pid: 2, canControl: false })
          ]
        })
      ])
    );
    const cards = p.window.document.querySelectorAll('.card');
    const titles = (at: number): (string | undefined)[] =>
      [...(cards[at]?.querySelectorAll<HTMLElement>('button.icon') ?? [])].map(
        (b) => b.dataset.tip
      );
    assert.deepEqual(titles(0), [COPY, 'End session']);
    // The copy is the one that stays: a transcript is worth quoting whatever
    // ran it.
    assert.deepEqual(titles(1), [COPY]);
  });

  it('copies a reference from any card, interactive or not', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({ sessions: [cardView({ pid: 7 }), cardView({ pid: 8, canControl: false })] })
      ])
    );
    const cards = p.window.document.querySelectorAll('.card');
    cards[0]?.querySelector<HTMLElement>(`button.icon[data-tip="${COPY}"]`)?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'copyRef', pid: 7 });
    cards[1]?.querySelector<HTMLElement>(`button.icon[data-tip="${COPY}"]`)?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'copyRef', pid: 8 });
  });

  it('copies without selecting the card the button sits on', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: 7 })] })]));
    p.window.document.querySelector<HTMLElement>(`button.icon[data-tip="${COPY}"]`)?.click();
    assert.deepEqual(p.posted, [{ type: 'copyRef', pid: 7 }]);
  });

  it('says nothing about where a session runs, because every card is a pipe', (t) => {
    // The badge that used to sit here named the odd one out — a session someone
    // typed `claude` for. There is no such card now (row 53), so there is no odd
    // one out and nothing to caption.
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({ pid: 1, owned: true }),
            cardView({ pid: 2 }),
            cardView({ pid: 3, canControl: false })
          ]
        })
      ])
    );
    assert.equal(p.window.document.querySelector('.card .where'), null);
  });

  /**
   * An end is signalled, not instant: the pipe closes, the CLI takes seconds to
   * notice, and in between the card is its discovered twin — `unknown`, because
   * a print-mode session writes no status word. The card says what is happening
   * to it instead, and keeps saying it until the process is gone.
   */
  it('spins a card an end has been signalled for', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({ sessions: [cardView({ pid: 9, status: 'unknown', closing: true })] })
      ])
    );
    const card = p.window.document.querySelector('.card.closing');
    assert.ok(card, 'no closing card');
    assert.ok(card.querySelector('.head .spinner'), 'no spinner');
    assert.equal(card.querySelector('.pill')?.textContent, 'Ending…');
    // The dot is the state word's twin, and there is no state word here.
    assert.equal(card.querySelector('.head .dot'), null, 'a status dot beside the spinner');
  });

  it('offers no interrupt until the CLI has opened the turn', (t) => {
    const p = openPanel(t);
    const sent = cardView({ pid: 9, status: 'busy', owned: true, turnPending: true });
    p.push(stateMessage([groupView({ sessions: [sent] })]));
    const titles = (): (string | undefined)[] =>
      [...p.window.document.querySelectorAll<HTMLElement>('.card button.icon')].map(
        (b) => b.dataset.tip
      );
    assert.deepEqual(titles(), [COPY, 'End session']);
    // Rebuilt rather than spread: the push ships the host's answer afresh.
    const opened = cardView({ pid: 9, status: 'busy', owned: true });
    p.push(stateMessage([groupView({ sessions: [opened] })]));
    assert.deepEqual(titles(), ['Interrupt turn', COPY, 'End session']);
  });

  /**
   * The interrupt is the one control an end takes away, and it has to be a card
   * that would have drawn one — so this one is busy.
   */
  it('takes only the interrupt off a card that is already ending', (t) => {
    const p = openPanel(t);
    const running = cardView({ pid: 9, status: 'busy', owned: true });
    p.push(stateMessage([groupView({ sessions: [running] })]));
    const titles = (): (string | undefined)[] =>
      [...p.window.document.querySelectorAll<HTMLElement>('.card button.icon')].map(
        (b) => b.dataset.tip
      );
    assert.deepEqual(titles(), ['Interrupt turn', COPY, 'End session'], 'not the resting card');

    const ending = cardView({ pid: 9, status: 'busy', owned: true, closing: true });
    p.push(stateMessage([groupView({ sessions: [ending] })]));
    // End stays: an end that was not honoured is exactly when a second one is
    // wanted, and the dock's own End is on screen for this session either way.
    assert.deepEqual(titles(), [COPY, 'End session']);
  });

  /**
   * An unsuccessful shutdown attempt retains the card with failure feedback.
   * The closed pipe cannot accept another End, so retry uses native signalling.
   */
  it('says an end did not take, and offers End again', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({
              pid: 9,
              status: 'busy',
              owned: true,
              endStuck: true,
              endFailure: 'The session is still running after shutdown.'
            })
          ]
        })
      ])
    );
    const card = p.window.document.querySelector('.card.endstuck');
    assert.ok(card, 'no stuck card');
    assert.equal(card.querySelector('.pill')?.textContent, "Didn't end");
    assert.equal(
      card.querySelector('.header-state')?.getAttribute('data-tip'),
      'The session is still running after shutdown.'
    );
    assert.equal(card.querySelector('.head .spinner'), null, 'still spinning');
    assert.deepEqual(
      [...card.querySelectorAll<HTMLElement>('button.icon')].map((b) => b.dataset.tip),
      [COPY, 'End session']
    );
  });

  it('offers a resting card its End and nothing more', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: 1, owned: true })] })]));
    const buttons = p.window.document.querySelectorAll<HTMLElement>('.card button.icon');
    // No *Open terminal* beside it: every card holds a pipe, and a pipe has no
    // terminal to open — the button resolved nothing and answered "that session
    // just closed" about a session sitting on the board (row 53).
    assert.deepEqual(
      [...buttons].map((b) => b.dataset.tip),
      [COPY, 'End session']
    );
  });

  it('offers the same two on a card this window does not drive', (t) => {
    // A session another window holds the pipe to, whose record did not land. It
    // used to be told apart from a hand-typed one here; there is no hand-typed
    // card left, so the only question is whether the buttons key off `owned`,
    // and they must not.
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: 1 })] })]));
    assert.deepEqual(
      [...p.window.document.querySelectorAll<HTMLElement>('.card button.icon')].map(
        (b) => b.dataset.tip
      ),
      [COPY, 'End session']
    );
  });

  it('keeps the interrupt on a busy card the panel drives', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 9, status: 'busy', owned: true })] })])
    );
    const buttons = p.window.document.querySelectorAll<HTMLElement>('.card button.icon');
    assert.deepEqual(
      [...buttons].map((b) => b.dataset.tip),
      ['Interrupt turn', COPY, 'End session']
    );
  });

  it('posts close from the icon button, without selecting', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: 7 })] })]));
    p.window.document
      .querySelector<HTMLElement>('.card button.icon[data-tip="End session"]')
      ?.click();
    assert.deepEqual(p.posted.map(assertedMessageBody), [{ type: 'close', pid: 7 }]);
  });

  it('posts interrupt from a busy card', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [cardView({ pid: 7, status: 'busy', owned: true })]
        })
      ])
    );
    const button = p.window.document.querySelector<HTMLElement>(
      '.card button.icon[data-tip^="Interrupt"]'
    );
    assert.ok(button, 'no interrupt button on a busy card');
    button.click();
    assert.deepEqual(p.posted.map(assertedMessageBody), [{ type: 'interrupt', pid: 7 }]);
  });

  // `waiting` is in here with `idle` on purpose: ESC at a session holding a
  // dialog cancels the dialog, which is a different act wearing the same key.
  // Without this the gate could quietly widen to `!== 'idle'` and still pass.
  for (const status of ['idle', 'waiting'] as const) {
    it(`offers no interrupt on a ${status} card`, (t) => {
      const p = openPanel(t);
      p.push(stateMessage([groupView({ sessions: [cardView({ status })] })]));
      assert.equal(
        p.window.document.querySelector('.card button.icon[data-tip^="Interrupt"]'),
        null,
        `a ${status} session has no turn to end`
      );
    });
  }

  it('offers no interrupt on a background session', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ status: 'busy', canControl: false })] })])
    );
    assert.equal(p.window.document.querySelector('.card button.icon[data-tip^="Interrupt"]'), null);
  });

  it('says so when no sessions are running', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([]));
    const list = p.window.document.getElementById('cards');
    assert.equal(list?.className, 'empty');
    assert.equal(list?.textContent, 'No sessions running.');
  });

  it('starts nothing on New — the press opens a draft and posts nothing', (t) => {
    const p = openPanel(t);
    const group = groupView({ sessions: [cardView({ pid: 1 })] });
    p.push(stateMessage([group]));
    // The starting half of the slot: it grew a second one, for resuming a
    // conversation that already exists (`resume.test.ts`).
    newDraft(p);
    assert.deepEqual(p.posted, [], 'New spawned before there was anything to say');
    assert.equal(p.window.document.querySelector('.card.starting'), null, 'a spinner, no start');
    // The slot is the only trace of an unsent draft on the board, so it says so.
    assert.ok(
      p.window.document.querySelector('.card.add.drafting'),
      'the slot does not say a draft is open'
    );
  });

  it('starts a session on the first send, and clears the spinner on arrival', (t) => {
    const p = openPanel(t);
    const group = groupView({ sessions: [cardView({ pid: 1 })] });
    p.push(stateMessage([group]));
    sendDraft(p, 'look at the parser');
    const open = lastOpen(p);
    assert.equal(open.cwd, group.cwd);
    // The prompt never rides the open — only its first line, and as a
    // placeholder rather than a name: `--name` would stop the CLI titling it.
    assert.equal(open.placeholder, 'look at the parser');
    assert.equal('name' in open, false, 'the crop must not reach --name');
    assert.equal('prompt' in open, false, 'the prompt went on the launch line');
    assert.equal(typeof open.draftId, 'string');
    assert.ok(p.window.document.querySelector('.card.starting'), 'no starting card');

    // Only the reveal correlated to this draft establishes which start completed.
    answerOpen(p, 2);
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: 1 }), cardView({ pid: 2 })] })]));
    assert.equal(p.window.document.querySelector('.card.starting'), null);
  });

  it('will not start a second session while the first is still coming up', (t) => {
    const p = openPanel(t);
    const group = groupView({ sessions: [cardView({ pid: 1 })] });
    p.push(stateMessage([group]));
    const add = () => p.window.document.querySelector<HTMLElement>('.card.add');
    const opens = () => p.posted.filter((m) => m.type === 'open').length;
    sendDraft(p, 'one');
    assert.equal(opens(), 1);

    // The card stays put — dimmed, so the wait is visible where the click was.
    assert.ok(add()?.classList.contains('busy'), 'add card not marked busy');
    sendDraft(p, 'two');
    sendDraft(p, 'three');
    assert.equal(opens(), 1);

    // Clickable again once the session it was waiting for shows up — which is
    // the reveal naming this draft, not merely a pid appearing. That reveal is
    // what promotes the draft, so what New opens after it is a fresh one.
    answerOpen(p, 2);
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: 1 }), cardView({ pid: 2 })] })]));
    assert.equal(add()?.classList.contains('busy'), false);
    sendDraft(p, 'four');
    assert.equal(opens(), 2);
  });

  it('leaves the other groups clickable while one is starting', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({ cwd: '/a', sessions: [cardView({ pid: 1 })] }),
        groupView({ cwd: '/b', sessions: [cardView({ pid: 2 })] })
      ])
    );
    const adds = () => [...p.window.document.querySelectorAll<HTMLElement>('.card.add')];
    sendDraft(p, 'in a', '/a');
    assert.equal(adds()[0]?.classList.contains('busy'), true);
    assert.equal(adds()[1]?.classList.contains('busy'), false);
    sendDraft(p, 'in b', '/b');
    assert.deepEqual(
      p.posted.filter((m) => m.type === 'open').map((m) => m.cwd),
      ['/a', '/b']
    );
  });

  /**
   * Two groups, two drafts. The dock shows the last one opened and neither is
   * discarded — a draft is keyed by the folder it will start in, so pressing
   * New somewhere else is a second draft rather than a replacement.
   */
  it('keeps a second group’s draft beside the first', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ cwd: '/a', sessions: [] }), groupView({ cwd: '/b', sessions: [] })])
    );

    newDraft(p, '/a');
    typeIn(p, 'about a');
    newDraft(p, '/b');
    assert.equal(composerValue(p), '', 'the second draft opened holding the first one’s text');
    assert.equal(
      p.window.document.querySelectorAll('.card.add.drafting').length,
      2,
      'only one slot says it has a draft'
    );

    // Back to the first, which kept what was typed into it.
    newDraft(p, '/a');
    assert.equal(composerValue(p), 'about a', 'refocusing a draft lost what was typed');
  });
});

describe('ending a card that has children', () => {
  it('posts the same close message a childless card posts', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: 7, children: [8, 9] })] })]));
    p.window.document
      .querySelector<HTMLElement>('.card button.icon[data-tip="End session"]')
      ?.click();
    assert.deepEqual(p.posted.map(assertedMessageBody), [{ type: 'close', pid: 7 }]);
  });
});

/**
 * The footer strip: branch and context; lineage belongs to the family header.
 *
 * A card used to carry a `N spawned` count here. What a fan-out is belongs to
 * the container header that names it, and a strip stating the same number a
 * second time was the same fact twice.
 */

describe('the footer strip', () => {
  const boss = (over: Partial<CardView> = {}) =>
    cardView({ pid: 3, name: 'orchestrator-split', fullCwd: '/Users/someone/proj', ...over });
  const peer = (over: Partial<CardView> = {}) => cardView({ pid: 7, name: 'peer', ...over });
  it('says nothing about what a card spawned', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [boss({ children: [7, 8] }), peer({ parent: 3 })] })])
    );
    assert.equal(p.window.document.querySelector('.foot .lin'), null);
    assert.equal(p.window.document.body.textContent?.includes('2 spawned'), false);
  });

  it('holds the branch and context reading', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            boss({
              children: [7],
              branch: 'main',
              mode: { label: 'plan', holds: true, bypass: false }
            })
          ]
        })
      ])
    );
    const foot = p.window.document.querySelector('.card .foot');
    assert.deepEqual(
      [...(foot?.children ?? [])].map((n) => n.className),
      ['br', 'strip-reading']
    );
  });

  it('keeps context on a card with no branch', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            boss({
              children: [7],
              branch: undefined,
              mode: { label: 'plan', holds: true, bypass: false }
            })
          ]
        })
      ])
    );
    const foot = p.window.document.querySelector('.card .foot');
    assert.deepEqual(
      [...(foot?.children ?? [])].map((n) => n.className),
      ['strip-reading']
    );
  });

  /**
   * jsdom has no flex layout; the browser preview verifies the rendered geometry.
   */
  it('keeps the context reading at the right and lets the branch shrink', () => {
    const clean = boardCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const body = (selector: string): string => {
      const at = clean.indexOf('\n  ' + selector + ' {');
      assert.ok(at !== -1, `no rule ${selector}`);
      return clean.slice(at).split('}')[0] ?? '';
    };
    const branch = body('.foot .br');
    const name = body('.br .n');
    const reading = body('.strip-reading');
    assert.match(reading, /margin-left:\s*auto/);
    // flex: 1 eats the free space, so the word lands on the percentage again.
    assert.match(branch, /flex:\s*0\s+1\s+auto/);
    assert.doesNotMatch(branch, /max-width:/);
    assert.match(name, /min-width:\s*0/);
    assert.match(name, /text-overflow:\s*ellipsis/);
  });
});

/**
 * The family container: one box per (group, parent), always open, and never a
 * reason for a card to move between groups or to be drawn twice.
 */

/**
 * The rename animation, and what it is allowed to touch.
 *
 * Same trade as the beat above, found the same way and one step later. The
 * scramble's rAF loop called `renderBoard()` per frame, which was free while
 * the 1s beat rebuilt the board anyway; Step 5 took the beat off the board and
 * left this as the only thing still rebuilding the whole card tree at 60fps —
 * measured at 843 paints in 14s against 26 pushes
 * (`TASK_done_panel_repaint_cost.md`).
 *
 * Real timers, for the harness's usual reason: the loop is rAF and there is no
 * clock seam. `SCRAMBLE_MS` is 500, so 800ms clears a whole animation.
 */
describe('a renamed card decodes on its own frames', () => {
  it('settles on the new name without painting the board', async (t) => {
    const p = openPanel(t);
    // First sighting never animates — only a genuine retitle does, so the name
    // has to arrive settled before it can change.
    p.push(stateMessage([groupView({ sessions: [cardView({ name: 'proj' })] })]));
    const doc = p.window.document;
    p.push(stateMessage([groupView({ sessions: [cardView({ name: 'fix the parser' })] })]));
    // **Node identity would not catch this.** The morph is keyed, so a board
    // repainted every frame hands back the same card element and the same spans
    // — the assertion has to be about the board rather than the card. `paint()`
    // opens by clearing `#cards`'s class (`board.ts:246`) and the scramble has
    // no business reaching it, so a mark set after the retitle's own paint
    // survives exactly as long as nothing repaints the board.
    const cards = doc.getElementById('cards');
    assert.ok(cards, 'no card grid');
    cards.className = 'scramble-probe';
    await new Promise((done) => setTimeout(done, 800));
    assert.equal(doc.querySelector('.name')?.textContent, 'fix the parser', 'never settled');
    assert.equal(cards.className, 'scramble-probe', 'the animation repainted the whole board');
  });

  /**
   * The leak this pair was written for, and the reason it is two scenarios
   * rather than one.
   *
   * A scramble was only ever cleared inside `displayName`, which runs while the
   * pid still has a card to paint. A session leaving the board within
   * `SCRAMBLE_MS` of a retitle therefore stranded its entry: the map never
   * emptied, and the loop went on repainting at 60fps until the webview
   * reloaded. Nothing user-visible, which is why it had to be measured to be
   * found.
   *
   * Two samples rather than one reading: the loop's own frames are what says it
   * is running, so the assertion is that the count stops moving, not that it
   * never moved.
   */
  it('stops when the card leaves the board mid-rename', async (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ name: 'proj' })] })]));
    const win = p.window;
    let frames = 0;
    const raf = win.requestAnimationFrame.bind(win);
    win.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames += 1;
      return raf(cb);
    };
    // Retitled, then gone before the 500ms animation could finish.
    p.push(stateMessage([groupView({ sessions: [cardView({ name: 'fix the parser' })] })]));
    p.push(stateMessage([groupView({ sessions: [] })]));
    await new Promise((done) => setTimeout(done, 400));
    const settled = frames;
    await new Promise((done) => setTimeout(done, 400));
    assert.equal(frames, settled, 'the animation went on running for a card that had left');
  });

  it('does not scramble the previous name onto a recycled pid', (t) => {
    // lastNames is keyed by pid alone. tickScrambles drops a scramble whose
    // card node is gone; lastNames has no such path, so a new session under a
    // recycled number would decode from the previous title. startedAt is the
    // identity — same number, different start — and it is pinned so this is
    // not a retitle (cardView defaults the start to Date.now()).
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({ sessions: [cardView({ pid: 101, name: 'proj', startedAt: 5_000 })] })
      ])
    );
    assert.equal(p.window.document.querySelector('.name')?.textContent, 'proj');
    p.push(
      stateMessage([
        groupView({
          sessions: [cardView({ pid: 101, name: 'fix the parser', startedAt: 11_000 })]
        })
      ])
    );
    assert.equal(
      p.window.document.querySelector('.name')?.textContent,
      'fix the parser',
      'a recycled pid animated the previous session’s name'
    );
  });
});

describe('card attention', () => {
  it('paints attention only while the shipped card carries it', (t) => {
    const p = openPanel(t);
    for (const over of [
      { status: 'waiting' as const },
      { completion: { total: 3, completed: 1 } },
      { turnOutcome: 'error' as const }
    ]) {
      p.push(stateMessage([groupView({ sessions: [cardView({ ...over, unseen: true })] })]));
      assert.ok(p.window.document.querySelector('.card.attention'));
      p.push(stateMessage([groupView({ sessions: [cardView(over)] })]));
      assert.equal(p.window.document.querySelector('.card.attention'), null);
    }
    for (const over of [
      {},
      { status: 'busy' as const },
      { completion: { total: 3, completed: 3 } }
    ]) {
      p.push(stateMessage([groupView({ sessions: [cardView({ ...over, unseen: true })] })]));
      assert.equal(p.window.document.querySelector('.card.attention'), null);
    }
  });
});

describe('card warming', () => {
  it('offers interrupt, warm, reference and end in that order, and toggles without selecting', (t) => {
    const p = openPanel(t);
    const one = cardView({
      pid: 7,
      status: 'busy',
      warm: { on: false, ttlMs: 3_600_000, source: 'measured' }
    });
    p.push(stateMessage([groupView({ sessions: [one] })]));
    const card = p.window.document.querySelector('.card');
    assert.ok(card);
    assert.deepEqual(
      [...card.querySelectorAll<HTMLElement>('.head button')].map((button) => button.dataset.act),
      ['interrupt', 'warm', 'copyRef', 'close']
    );
    const toggle = card.querySelector<HTMLButtonElement>('[data-act="warm"]');
    assert.ok(toggle);
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    toggle.click();
    assert.deepEqual(p.posted, [{ type: 'setWarm', pid: 7, startedAt: one.startedAt, on: true }]);
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    assert.ok(card.classList.contains('warm-on'));
    // A push composed before the write must not undo the reader's choice.
    p.push(stateMessage([groupView({ sessions: [one] })]));
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    toggle.click();
    assert.deepEqual(p.posted.at(-1), {
      type: 'setWarm',
      pid: 7,
      startedAt: one.startedAt,
      on: false
    });
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(card.classList.contains('warm-on'), false);
  });

  it('reverts a refused card toggle and ignores replies for a previous incarnation', (t) => {
    const p = openPanel(t);
    const one = cardView({
      pid: 7,
      startedAt: 100,
      warm: { on: false, ttlMs: 3_600_000, source: 'measured' }
    });
    const push = (view: CardView): void => {
      p.push(stateMessage([groupView({ sessions: [view] })]));
    };
    const toggle = (): HTMLButtonElement => {
      const button = p.window.document.querySelector<HTMLButtonElement>('.card [data-act="warm"]');
      assert.ok(button);
      return button;
    };
    push(one);
    toggle().click();
    p.push({ type: 'warmChoice', pid: 7, startedAt: 100 });
    assert.equal(toggle().getAttribute('aria-pressed'), 'false');
    push({ ...one, startedAt: 200 });
    toggle().click();
    p.push({ type: 'warmChoice', pid: 7, startedAt: 100 });
    assert.equal(toggle().getAttribute('aria-pressed'), 'true');
    push({ ...one, startedAt: 200, warm: { ...one.warm!, on: true } });
    push({ ...one, startedAt: 200 });
    assert.equal(toggle().getAttribute('aria-pressed'), 'false', 'accepted hold did not retire');
  });

  it("stamps Warm's time left while it is on, and the last message's age once it is over", (t) => {
    const p = openPanel(t);
    const now = Date.now();
    const warm = { on: true, ttlMs: 3_600_000, source: 'measured' as const };
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({
              pid: 1,
              updatedAt: now - 40 * 60_000,
              warm: { ...warm, endsAt: now + 80 * 60_000 + 30_000 }
            }),
            cardView({
              pid: 2,
              updatedAt: now - 126 * 60_000,
              warm: { ...warm, endsAt: now - 6 * 60_000 }
            })
          ]
        })
      ])
    );
    const [counting, over] = [...p.window.document.querySelectorAll<HTMLElement>('.card .since')];
    assert.equal(counting?.textContent, 'warm for 1h 20m');
    // The age it replaced is still one hover away.
    assert.match(counting?.dataset.tipRows ?? '', /idle for.*40m/);
    assert.equal(over?.textContent, '2h ago ❄︎');
  });

  it('stamps the age once the cache has expired, even while the warm window is open', (t) => {
    const p = openPanel(t);
    const now = Date.now();
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({
              pid: 3,
              updatedAt: now - 90 * 60_000,
              cacheUntil: now - 30 * 60_000,
              warm: {
                on: true,
                ttlMs: 60 * 60_000,
                source: 'measured',
                endsAt: now + 30 * 60_000
              }
            })
          ]
        })
      ])
    );
    assert.equal(p.window.document.querySelector('.card .since')?.textContent, '1h ago ❄︎');
  });

  it('offers no warm toggle when the host has no warm state or cannot keep the session warm', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({ pid: 1 }),
            cardView({
              pid: 2,
              canControl: false,
              warm: { on: false, ttlMs: 3_600_000, source: 'measured', held: 'unsupported' }
            })
          ]
        })
      ])
    );
    assert.equal(p.window.document.querySelector('.card [data-act="warm"]'), null);
  });

  it('lights the existing footer only during a ping and keeps the card idle', (t) => {
    const p = openPanel(t);
    const push = (warming?: true): void => {
      p.push(stateMessage([groupView({ sessions: [cardView({ warming, branch: 'staging' })] })]));
    };
    push();
    const card = p.window.document.querySelector('.card');
    assert.ok(card);
    const footer = card.querySelector('.foot');
    assert.ok(footer);
    const rows = card.children.length;
    push(true);
    assert.ok(card.classList.contains('warming'));
    assert.ok(card.classList.contains('idle'));
    assert.equal(card.querySelector('.pill')?.textContent, 'idle');
    assert.equal(card.querySelector('.foot'), footer);
    assert.equal(footer.querySelector('.br .n')?.textContent, 'staging');
    assert.equal(card.children.length, rows);
    push();
    assert.equal(card.classList.contains('warming'), false);
    assert.equal(card.querySelector('.foot'), footer);
  });

  it('marks a card whose Warm switch is on, ping or no ping', (t) => {
    const p = openPanel(t);
    const push = (warm?: Partial<WarmView>, warming?: true): Element => {
      const view = warm && { on: false, ttlMs: 3_600_000, source: 'measured' as const, ...warm };
      p.push(
        stateMessage([
          groupView({ sessions: [cardView({ warming, ...(view && { warm: view }) })] })
        ])
      );
      const card = p.window.document.querySelector('.card');
      assert.ok(card);
      return card;
    };
    assert.ok(push({ on: true }).classList.contains('warm-on'));
    assert.equal(push({ on: true }).classList.contains('warming'), false, 'no ping, no motion');
    assert.ok(push({ on: true }, true).classList.contains('warm-on'));
    assert.equal(push({ on: false }).classList.contains('warm-on'), false);
    assert.equal(push().classList.contains('warm-on'), false);
    assert.equal(
      push({ on: true, held: 'unsupported' }).classList.contains('warm-on'),
      false,
      'a session nothing here can ping is not kept warm'
    );
  });

  it('holds the animation while the host or document hides the panel', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ warming: true })] })]));
    p.push({ type: 'visible', visible: false });
    assert.ok(p.window.document.body.classList.contains('warm-paused'));
    p.push({ type: 'visible', visible: true });
    assert.equal(p.window.document.body.classList.contains('warm-paused'), false);
    Object.defineProperty(p.window.document, 'visibilityState', {
      value: 'hidden',
      configurable: true
    });
    p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
    assert.ok(p.window.document.body.classList.contains('warm-paused'));
    p.push({ type: 'visible', visible: true });
    assert.ok(p.window.document.body.classList.contains('warm-paused'));
    Object.defineProperty(p.window.document, 'visibilityState', {
      value: 'visible',
      configurable: true
    });
    p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
    assert.equal(p.window.document.body.classList.contains('warm-paused'), false);
  });
});
