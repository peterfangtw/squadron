/**
 * Skill pills in the composer: the `@` menu, what a pick inserts, and what a
 * send puts on the wire.
 *
 * The one claim every scenario here serves is that **text order is load order**.
 * A pill is a chip in the prose, where the reader put it, and the session then
 * calls its `Skill` tool once per pill in that order — measured against CLI
 * 2.1.226, and recorded in `docs/reference/cli_state/claude/commands.md`.
 *
 * The expansion is `the <name> skill` and carries the name **exactly** as
 * the discovered skill declares it. Both tempting shortenings were measured and both load
 * nothing: a path turns `Skill` into `Read`, and a namespaced name reduced to
 * its alias (`caveman` for `caveman:caveman`) makes the model answer as though
 * it had loaded the skill without ever calling the tool.
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  answerOpen,
  answerSend,
  assertedMessageBody,
  answerFilePick,
  cardView,
  composerKey,
  composerPills,
  composerSelection,
  composerTarget,
  composerValue,
  enter,
  escape,
  groupView,
  importComposer,
  newDraft,
  modelView,
  openPanel,
  openThread,
  proseOf,
  selectComposer,
  stateMessage,
  typeIn,
  typeMention,
  unreachableThread,
  threadView,
  Panel
} from '../harness';

/** Type `@` in the box the way a reader does — the trigger is a keydown. */
function at(p: Panel, before = ''): void {
  typeMention(p, before);
}

/** The open skill menu, or null. */
const menu = (p: Panel): HTMLElement | null =>
  p.window.document.querySelector<HTMLElement>('#mentionmenu:not([hidden])');

const rows = (p: Panel): string[] =>
  [...(menu(p)?.querySelectorAll('.mnrow') ?? [])].map((r) => r.textContent?.trim() ?? '');

/**
 * Type into the box and let the edit rebuild the menu, as a reader does. Where
 * `value` only adds to what the box holds, with the caret at its end, only the
 * added keys are typed: retyping the whole box would close the menu between the
 * first key and the last, which no reader's keystroke does.
 */
function type(p: Panel, value: string): void {
  const now = composerValue(p);
  if (now && value.startsWith(now) && composerSelection(p).start === now.length) {
    proseOf(p.window.document.getElementById('input')).type(value.slice(now.length));
    return;
  }
  typeIn(p, value, value.length);
}

/** An arrow press in the box, handed back so a scenario can ask whether the
 *  composer swallowed it or left it to the caret. */
function arrow(p: Panel, key: 'ArrowDown' | 'ArrowUp'): KeyboardEvent {
  return composerKey(p, key);
}

/** Every row the menu is painting as the one Enter would take. */
const highlit = (p: Panel): string[] =>
  [...(menu(p)?.querySelectorAll('.on') ?? [])].map((r) => r.textContent?.trim() ?? '');

/** One row of the open menu, by position. */
const row = (p: Panel, at: number): HTMLElement | undefined =>
  [...(menu(p)?.querySelectorAll<HTMLElement>('.mnrow') ?? [])][at];

describe('skill pills', () => {
  it('opens the directory skill menu in a new-session draft', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          cwd: '/repo',
          sessions: [],
          skillsByBrand: { claude: ['dataviz', 'ponytail'] }
        })
      ])
    );
    newDraft(p, '/repo');

    at(p);
    assert.deepEqual(rows(p), ['dataviz', 'ponytail']);
    row(p, 0)?.click();
    assert.equal(composerValue(p), 'the dataviz skill ');
    assert.equal(composerPills(p, 'skill')[0]?.textContent, '@dataviz');

    enter(p);
    answerOpen(p, 9);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 9,
      text: 'the dataviz skill'
    });
  });

  it('switches the unsent draft catalog with its selected CLI', (t) => {
    const p = openPanel(t);
    const brands = ['claude', 'codex', 'grok'] as const;
    p.push(
      stateMessage(
        [
          groupView({
            cwd: '/repo',
            sessions: [],
            skillsByBrand: {
              claude: ['claude-private'],
              codex: ['codex-private', 'shared'],
              grok: ['grok-private', 'shared']
            }
          })
        ],
        {
          models: brands.map((brand) =>
            modelView({ brand, value: brand, name: brand, window: undefined, efforts: undefined })
          )
        }
      )
    );
    newDraft(p, '/repo');
    for (const brand of brands) {
      p.window.document.querySelector<HTMLElement>('#ctools .fpill.model')?.click();
      const item = [
        ...p.window.document.querySelectorAll<HTMLElement>('#ctools .fmenu .mitem')
      ].find((node) => node.querySelector('.nm')?.textContent === brand);
      assert.ok(item);
      item.click();
      type(p, '@skill:');
      assert.deepEqual(
        rows(p),
        brand === 'claude' ? ['claude-private'] : [`${brand}-private`, 'shared']
      );
      escape(p);
      type(p, '');
    }
    assert.equal(
      p.posted.some((message) => message.type === 'open'),
      false
    );
  });

  it('opens a menu of the skills the session can load', (t) => {
    const p = openThread(t, threadView({ skills: ['dataviz', 'ponytail', 'caveman:caveman'] }));
    at(p);
    assert.ok(menu(p), 'typing @ opened no menu');
    assert.deepEqual(rows(p), ['dataviz', 'ponytail', 'caveman:caveman']);
  });

  it('filters the menu as the reader types past the @', (t) => {
    const p = openThread(t, threadView({ skills: ['dataviz', 'ponytail', 'caveman:caveman'] }));
    at(p);
    type(p, '@pony');
    assert.deepEqual(rows(p), ['ponytail']);
  });

  it('opens with the first row already the one Enter takes', (t) => {
    const p = openThread(t, threadView({ skills: ['dataviz', 'dart', 'ponytail'] }));
    at(p);
    assert.deepEqual(highlit(p), ['dataviz']);
  });

  it('walks the highlight down the rows, and Enter takes that one', (t) => {
    const p = openThread(t, threadView({ skills: ['dataviz', 'dart', 'ponytail'] }));
    at(p);
    arrow(p, 'ArrowDown');
    arrow(p, 'ArrowDown');
    assert.deepEqual(highlit(p), ['ponytail']);
    enter(p);
    assert.equal(
      composerValue(p),
      'the ponytail skill ',
      'Enter took a row the reader had arrowed past'
    );
  });

  it('leaves the caret where it was while it moves the highlight', (t) => {
    const p = openThread(t, threadView({ skills: ['dataviz', 'dart'] }));
    at(p);
    const e = arrow(p, 'ArrowDown');
    assert.ok(e.defaultPrevented, 'the arrow was left to the caret');
  });

  it('leaves Up and Down to the box when no menu is open', (t) => {
    // A prose box is multi-line, and swallowing the arrows unconditionally
    // would strand the reader on one line of their own draft.
    const p = openThread(t, threadView({ skills: ['dataviz'] }));
    type(p, 'first line\nsecond line');
    assert.ok(!menu(p), 'nothing should be open on plain prose');
    assert.ok(!arrow(p, 'ArrowUp').defaultPrevented, 'the composer swallowed a caret move');
  });

  it('laps from the last row onto the first, and from the first onto the last', (t) => {
    const p = openThread(t, threadView({ skills: ['dataviz', 'dart', 'ponytail'] }));
    at(p);
    arrow(p, 'ArrowUp');
    assert.deepEqual(highlit(p), ['ponytail'], 'Up on the first row stayed there');
    // `.mnfoot` is prose about the list rather than a row in it, and Enter on
    // it would pick nothing while looking exactly like a pick.
    assert.equal(menu(p)?.querySelector('.mnfoot.on'), null, 'the highlight reached the caveat');
    arrow(p, 'ArrowDown');
    assert.deepEqual(highlit(p), ['dataviz'], 'Down on the last row stayed there');
  });

  it('keeps the highlight where it was through the rebuild typing causes', (t) => {
    const p = openThread(t, threadView({ skills: ['dataviz', 'dart', 'ponytail'] }));
    at(p);
    arrow(p, 'ArrowDown');
    assert.deepEqual(highlit(p), ['dart']);
    type(p, '@da');
    assert.deepEqual(rows(p), ['dataviz', 'dart']);
    assert.deepEqual(highlit(p), ['dart'], 'a keystroke dropped the highlight back to the top');
  });

  it('clamps the highlight when the filter shrinks the list under it', (t) => {
    const p = openThread(t, threadView({ skills: ['dataviz', 'dart', 'ponytail'] }));
    at(p);
    arrow(p, 'ArrowDown');
    arrow(p, 'ArrowDown');
    assert.deepEqual(highlit(p), ['ponytail']);
    type(p, '@da');
    assert.deepEqual(highlit(p), ['dart'], 'the highlight hung off the end of the shorter list');
    enter(p);
    assert.equal(composerValue(p), 'the dart skill ');
  });

  it('starts the next run at the top', (t) => {
    const p = openThread(t, threadView({ skills: ['dataviz', 'dart', 'ponytail'] }));
    at(p);
    arrow(p, 'ArrowDown');
    arrow(p, 'ArrowDown');
    type(p, 'and now @d');
    assert.deepEqual(highlit(p), ['dataviz'], 'a fresh @ inherited the last run’s highlight');
  });

  it('takes the row the pointer is over, not the one the keys left behind', (t) => {
    // Mouse and keyboard cannot disagree about what Enter means: hovering is
    // choosing, so it moves the same highlight the arrows do.
    const p = openThread(t, threadView({ skills: ['dataviz', 'dart', 'ponytail'] }));
    at(p);
    arrow(p, 'ArrowDown');
    row(p, 2)?.dispatchEvent(new p.window.MouseEvent('mousemove', { bubbles: true }));
    assert.deepEqual(highlit(p), ['ponytail'], 'the pointer and the keys disagreed');
    enter(p);
    assert.equal(composerValue(p), 'the ponytail skill ');
  });

  it('does not let a row sliding under a still pointer steer the keys', (t) => {
    // Measured in Chromium against the shipped bundle: scrolling the menu under
    // a parked cursor dispatches the boundary events, so a hover taken from
    // `mouseenter` fought every ArrowDown — the row scrolled under the pointer
    // pulled the highlight straight back, and it oscillated between two rows
    // for as long as the key was held. Only real pointer motion may choose.
    const p = openThread(t, threadView({ skills: ['dataviz', 'dart', 'ponytail'] }));
    at(p);
    arrow(p, 'ArrowDown');
    row(p, 2)?.dispatchEvent(new p.window.MouseEvent('mouseenter', { bubbles: false }));
    row(p, 2)?.dispatchEvent(new p.window.MouseEvent('mouseover', { bubbles: true }));
    assert.deepEqual(highlit(p), ['dart'], 'a boundary event alone moved the highlight');
  });

  it('starts at the top again when a dismissed run is typed back open', (t) => {
    const p = openThread(t, threadView({ skills: ['dataviz', 'dart', 'ponytail'] }));
    at(p);
    arrow(p, 'ArrowDown');
    arrow(p, 'ArrowDown');
    escape(p);
    assert.equal(menu(p), null, 'Escape did not shut the menu');
    type(p, '@d');
    assert.deepEqual(highlit(p), ['dataviz'], 'the reopened list kept a highlight from before');
  });

  it('scrolls the highlighted row into view when the list is longer than the menu', (t) => {
    // jsdom lays nothing out and ships no `scrollIntoView` (the harness stubs
    // one), so what is assertable here is that the active row is the one asked
    // to show itself — never the footer, and never a row the reader left.
    const p = openThread(t, threadView({ skills: ['dataviz', 'dart', 'ponytail'] }));
    at(p);
    const scrolled: string[] = [];
    p.window.Element.prototype.scrollIntoView = function scrollIntoView(this: Element): void {
      scrolled.push(this.textContent?.trim() ?? '');
    };
    arrow(p, 'ArrowDown');
    arrow(p, 'ArrowDown');
    assert.deepEqual(scrolled, ['dart', 'ponytail']);
  });

  it('mints a token when a row is picked, and paints it as a skill pill', (t) => {
    const p = openThread(t, threadView({ skills: ['dataviz'] }));
    at(p);
    menu(p)?.querySelector<HTMLElement>('.mnrow')?.click();
    assert.equal(composerValue(p), 'the dataviz skill ');
    const pill = composerPills(p, 'skill')[0];
    assert.equal(pill?.textContent, '@dataviz', 'the mirror did not paint a skill pill');
  });

  it('expands a pill in place, leaving the reader’s own prose alone', (t) => {
    const p = openThread(t, threadView({ skills: ['dataviz'] }));
    at(p);
    menu(p)?.querySelector<HTMLElement>('.mnrow')?.click();
    importComposer(p, `Before I write anything, apply ${composerValue(p)}so the axes are right.`);
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'Before I write anything, apply the dataviz skill so the axes are right.'
    });
  });

  it('expands two pills in the order they sit in the text', (t) => {
    // N skills in one message load N, in the order named. The menu picks below
    // are that order. The typed sentence after them forms the same chips from
    // the phrases.
    const p = openThread(t, threadView({ skills: ['dataviz', 'ponytail'] }));
    pick(p, 'ponytail');
    pick(p, 'dataviz');
    assert.equal(composerValue(p), 'the ponytail skill the dataviz skill ');
    // The prose the reader writes around them, each phrase forming its chip
    // again as it is typed.
    type(p, 'use the ponytail skill and then the dataviz skill, then answer');
    assert.equal(composerPills(p, 'skill').length, 2);
    enter(p);
    assert.equal(
      (p.posted.at(-1) as { text: string }).text,
      'use the ponytail skill and then the dataviz skill, then answer'
    );
  });

  it('expands a namespaced name whole, never to its alias', (t) => {
    // Measured: `the caveman skill` raises no Skill call at all, while the model
    // answers as though it had loaded it. The full spelling is the difference.
    const p = openThread(t, threadView({ skills: ['caveman:caveman'] }));
    at(p);
    menu(p)?.querySelector<HTMLElement>('.mnrow')?.click();
    assert.equal(composerValue(p), 'the caveman:caveman skill ');
    enter(p);
    assert.equal((p.posted.at(-1) as { text: string }).text, 'the caveman:caveman skill');
  });

  it('takes the whole token on one Backspace just after it', (t) => {
    const p = openThread(t, threadView({ skills: ['dataviz'] }));
    at(p);
    menu(p)?.querySelector<HTMLElement>('.mnrow')?.click();
    // Just after the chip, before the space a pick sets after it.
    selectComposer(p, composerValue(p).trimEnd().length);
    composerKey(p, 'Backspace', { cancelable: false });
    assert.equal(composerValue(p).trim(), '', 'backspace left part of a token behind');
  });

  it('hands the pills back working when a send is refused', (t) => {
    // A refused send restores the draft, and the next Enter posts the skill
    // phrase. It once restored the label with nothing behind it, and the model
    // read that and ignored it.
    const p = openThread(t, threadView({ skills: ['dataviz'] }));
    at(p);
    menu(p)?.querySelector<HTMLElement>('.mnrow')?.click();
    importComposer(p, `apply ${composerValue(p)}please`);
    enter(p);
    answerSend(p, { ok: false, reason: 'nope' });
    assert.equal(composerValue(p), 'apply the dataviz skill please', 'the draft did not come back');
    enter(p);
    assert.equal(
      (p.posted.at(-1) as { text: string }).text,
      'apply the dataviz skill please',
      'the restored pill posted as prose instead of expanding'
    );
  });

  it('does not let a picked file steal a skill’s token', (t) => {
    // A file whose name is a skill name goes out as its path. That path must
    // not replace the skill phrase beside it, or the turn loads no skill.
    const p = openThread(t, threadView({ skills: ['dataviz'] }));
    at(p);
    menu(p)?.querySelector<HTMLElement>('.mnrow')?.click();
    p.window.document.getElementById('fattach')?.click();
    answerFilePick(p, ['/repo/app/dataviz']);
    assert.equal(
      composerValue(p),
      'the dataviz skill /repo/app/dataviz ',
      'the file reused the skill’s token'
    );
    enter(p);
    assert.equal((p.posted.at(-1) as { text: string }).text, 'the dataviz skill /repo/app/dataviz');
  });

  it('sends a file and a skill whose token starts with the file’s, file first', (t) => {
    // The path and the phrase both go out, file first. A path that shares the
    // skill's name must not replace the phrase.
    const p = openThread(t, threadView({ skills: ['dataviz'] }));
    p.window.document.getElementById('fattach')?.click();
    answerFilePick(p, ['/dataviz']);
    pick(p, 'dataviz');
    assert.equal(composerValue(p), '/dataviz the dataviz skill ');
    enter(p);
    assert.equal((p.posted.at(-1) as { text: string }).text, '/dataviz the dataviz skill');
  });

  it('sends a skill and a file whose token starts with the skill’s, skill first', (t) => {
    const p = openThread(t, threadView({ skills: ['dataviz'] }));
    pick(p, 'dataviz');
    p.window.document.getElementById('fattach')?.click();
    answerFilePick(p, ['/dataviz']);
    assert.equal(composerValue(p), 'the dataviz skill /dataviz ');
    enter(p);
    assert.equal((p.posted.at(-1) as { text: string }).text, 'the dataviz skill /dataviz');
  });

  it('leaves a Backspace that belongs to an IME composition to the IME', (t) => {
    const p = openThread(t, threadView({ skills: ['dataviz'] }));
    pick(p, 'dataviz');
    const e = composerKey(p, 'Backspace', { isComposing: true });
    assert.equal(e.defaultPrevented, false, 'the composer took a composing key');
    assert.equal(composerValue(p), 'the dataviz skill ');
  });

  it('opens no menu at the end of a finished pill, so Enter sends', (t) => {
    // A single-word pill is a whitespace-bounded `@` run to the old test, so a
    // click at its end reopened its own search and Enter replaced it again.
    const p = openThread(t, threadView({ skills: ['dataviz'] }));
    pick(p, 'dataviz');
    selectComposer(p, 8);
    composerTarget(p).dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
    assert.equal(menu(p), null, 'the pill reopened its own search');
    enter(p);
    assert.equal((p.posted.at(-1) as { text: string }).text, 'the dataviz skill');
  });

  it('opens no menu at the end of a pill a refused send restored', (t) => {
    const p = openThread(t, threadView({ skills: ['dataviz'] }));
    pick(p, 'dataviz');
    importComposer(p, `apply ${composerValue(p)}please`);
    enter(p);
    answerSend(p, { ok: false, reason: 'nope' });
    assert.equal(composerValue(p), 'apply the dataviz skill please');
    selectComposer(p, 14);
    composerTarget(p).dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
    assert.equal(menu(p), null, 'a restored pill reopened its own search');
  });

  it('does not pick against a run the caret has left', (t) => {
    // The menu is rebuilt from the caret and the pick reads the caret again, so
    // a caret that moved between the two desyncs them. Picking then deleted
    // from where the reader no longer was and cut their own letters adrift —
    // `@pon` + ArrowLeft + Enter left `@ponytail n`.
    const p = openThread(t, threadView({ skills: ['ponytail'] }));
    type(p, '@pon');
    assert.ok(menu(p), 'the menu should be open on @pon');
    selectComposer(p, 3);
    composerTarget(p).dispatchEvent(
      new p.window.KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true })
    );
    enter(p);
    assert.ok(
      !composerValue(p).includes('ponytail n'),
      `cut the reader's text adrift: ${composerValue(p)}`
    );
  });

  it('does not leave Enter dead when the reader selects across the run', (t) => {
    // A range is not a caret: `selectionStart` is its left edge, which can sit
    // before the `@`. The menu stayed open owning Enter while the pick refused
    // to fire, so Enter did nothing at all until something else closed it.
    const p = openThread(t, threadView({ skills: ['ponytail'] }));
    type(p, '@pon');
    selectComposer(p, 0, 4);
    enter(p);
    enter(p);
    assert.equal(menu(p), null, 'the menu stayed open holding Enter');
  });

  it('keeps Escape shut, and reopens only when the reader types on', (t) => {
    // Escape leaves the text and the caret exactly as they were, so anything
    // that rebuilds the menu from those two rebuilds it immediately — the
    // keyup that follows the Escape itself did. A dismissal has to outlive the
    // recompute. Typing on is the reader changing their mind back.
    const p = openThread(t, threadView({ skills: ['ponytail'] }));
    at(p);
    assert.ok(menu(p), 'the menu should be open');
    composerKey(p, 'Escape', { cancelable: false });
    composerTarget(p).dispatchEvent(
      new p.window.KeyboardEvent('keyup', { key: 'Escape', bubbles: true })
    );
    assert.equal(menu(p), null, 'Escape did not stay shut');
    type(p, '@p');
    assert.ok(menu(p), 'typing on did not bring the menu back');
  });

  it('gives Escape to the menu alone — the interrupt only gets it back after', (t) => {
    // A change the extraction made, and the better one: the menu's claim is now
    // a document capture listener that stops the key, where before both were
    // bubble listeners on the box and Escape interrupted the turn *and*
    // dismissed the menu in one press.
    const p = openThread(t, threadView({ skills: ['ponytail'], status: 'busy' }));
    at(p);
    assert.ok(menu(p), 'the menu should be open');
    composerKey(p, 'Escape');
    assert.equal(menu(p), null, 'Escape did not shut the menu');
    assert.equal(
      p.posted.filter((m) => m.type === 'interrupt').length,
      0,
      'Escape interrupted the turn as well as dismissing the menu'
    );
    // With the menu gone it is the interrupt again.
    composerKey(p, 'Escape');
    assert.equal(p.posted.filter((m) => m.type === 'interrupt').length, 1);
  });

  it('shuts the menu when another session is selected', (t) => {
    // It is filtered against one session's skills and one box's caret. Left
    // open it floats over the next session's composer listing the last one's
    // skills — and owns Enter while it does.
    const p = openThread(t, threadView({ skills: ['dataviz'] }));
    at(p);
    assert.ok(menu(p), 'the menu should be open before the switch');
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 101 }), cardView({ pid: 202 })] })])
    );
    [...p.window.document.querySelectorAll<HTMLElement>('.card')][1]?.click();
    assert.equal(menu(p), null, 'the menu survived a session switch');
  });

  it('holds a refused send as a draft when the reader has moved on', (t) => {
    // A refusal can land a poll after the reader moved. Writing it into the
    // box then would drop the draft they are typing.
    const p = openThread(t, threadView({ skills: ['dataviz'] }));
    at(p);
    menu(p)?.querySelector<HTMLElement>('.mnrow')?.click();
    importComposer(p, `apply ${composerValue(p)}please`);
    enter(p);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 101 }), cardView({ pid: 202 })] })])
    );
    [...p.window.document.querySelectorAll<HTMLElement>('.card')][1]?.click();
    importComposer(p, 'a draft of my own');
    answerSend(p, { ok: false, reason: 'nope' });
    assert.equal(
      composerValue(p),
      'a draft of my own',
      'the refusal overwrote another session’s box'
    );
  });

  it('says plainly that not every listed skill will load', (t) => {
    // 8 of 36 entries were measured non-invocable and nothing on the wire says
    // which. At that rate silence reads as a claim.
    const p = openThread(t, threadView({ skills: ['dataviz'] }));
    at(p);
    assert.match(menu(p)?.querySelector('.mnfoot')?.textContent ?? '', /can.?t|cannot|not every/i);
  });

  it('leaves a literal @ when the session lists no skills', (t) => {
    const p = openThread(t, threadView({ skills: undefined }));
    at(p);
    assert.equal(menu(p), null, 'a session with no skills opened a menu anyway');
    assert.equal(composerValue(p), '@');
  });

  it('draws no trigger at all for a session in a terminal', (t) => {
    // It takes keystrokes this project never sends, so the affordance is absent
    // rather than disabled — and the host states that by sending no `skills`.
    const p = openThread(t, unreachableThread({ skills: undefined }));
    at(p);
    assert.equal(menu(p), null);
  });

  it('draws no trigger for an owned session another window holds', (t) => {
    const p = openPanel(t);
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(stateMessage(groups, { thread: threadView({ skills: undefined, canSend: false }) }));
    at(p);
    assert.equal(menu(p), null);
  });
});

/** Open the menu at the caret and pick one skill by name, as a reader does. */
function pick(p: Panel, name: string): void {
  typeMention(p, composerValue(p));
  const row = [...(menu(p)?.querySelectorAll<HTMLElement>('.mnrow') ?? [])].find(
    (r) => r.textContent?.trim() === name
  );
  assert.ok(row, `no menu row for ${name}`);
  row.click();
}
