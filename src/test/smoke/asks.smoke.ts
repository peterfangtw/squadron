/**
 * A question already answered, reopened from the turn that asked it.
 *
 * `question_replay.test.ts`'s `a replayed question` holds every rule about what the
 * record draws, against an `AnsweredAskView` a test wrote by hand. What it
 * cannot write is the half below it: a **file another program's format wrote**,
 * walked by `core/transcript.ts`, folded into a `ThreadView` by `ui/activity.ts`
 * and pushed over the wire — the whole path between a `toolUseResult` on disk
 * and a pill on screen, which no `PanelMessage` a test composes ever exercises.
 *
 * **Why the shared fixture card rather than a child of its own**, for the
 * reason `diff.smoke.ts` says at length: the transcript this reads is written
 * once in `boot.ts`, in the CLI's own entry shapes, and a second child would
 * need a second copy of it. Since row 71 that card is an owned session like any
 * other — `fixtureSession()` resumes the planted transcript through recovery.
 * Nothing here answers anything, so ownership buys this file nothing either.
 *
 * `notices.smoke.ts` rewrites that same transcript down to a single entry; the
 * reset before each section puts it back.
 */
import * as assert from 'node:assert/strict';
import { ASKED, openPanel, panel, section, step } from './boot';
import { FIXTURE_NAME, fixtureSession, openDraft } from './kit';

/** Every pill on the thread, one per question of the ask that wrote it. */
const pills = () => panel().locator('#thread .tool .askpill');
const question = () => panel().locator('#question');

section('an answered ask, replayed off a real transcript', () => {
  step('draws the record the transcript holds, with nothing to answer', async () => {
    await openPanel();
    await fixtureSession();
    await panel().locator('.card', { hasText: FIXTURE_NAME }).click();

    // One pill per question, wearing that question's own header — and the pills
    // being there at all is the record having survived the walk.
    await pills().first().waitFor({ timeout: 30_000 });
    assert.equal(await pills().count(), 2);
    assert.equal(await pills().first().textContent(), ASKED.questions[0]?.header);
    assert.equal(await pills().nth(1).textContent(), ASKED.questions[1]?.header);

    await pills().first().click();

    // The layer opens over the board for a record exactly as it does for a live
    // ask — `#ask` is one element and a replay borrows it.
    const dialog = question().locator('.pdlg.replay');
    await dialog.waitFor({ timeout: 10_000 });
    assert.equal(await question().locator('.qtext').textContent(), ASKED.questions[0]?.question);
    assert.equal(await question().locator('.qhdr .cnt').textContent(), 'picked');

    // What was picked, and only what was picked.
    const marked = question().locator('.qopt.on .qopt-label');
    assert.deepEqual(await marked.allTextContents(), ['staging']);

    // The note, as it was sent, with no box to type another into.
    assert.equal(
      await question().locator('.qnote .qnote-said').textContent(),
      ASKED.annotations['Which branch should this land on?'].notes
    );
    assert.equal(await question().locator('.qnote-in').count(), 0);

    // Nothing here can answer anything: no CTA, and nothing to type into.
    assert.equal(await question().locator('.cta').count(), 0);
    assert.equal(await question().locator('textarea').count(), 0);
  });

  step('draws the second question’s record from its own pill', async () => {
    await pills().nth(1).click();
    assert.equal(await question().locator('.qtext').textContent(), ASKED.questions[1]?.question);

    // A multi-select answered with one label and words no label carries: the
    // pick on its row, the words on the `Other` row where they were typed.
    assert.deepEqual(await question().locator('.qopt.on .qopt-label').allTextContents(), [
      'lint',
      'Your own words'
    ]);
    assert.equal(
      await question().locator('.qopt.other .qother-said').textContent(),
      ASKED.answers['Which checks should run?'][1]
    );
    // Two rows green, so the chip counts the own-words row with the picks.
    assert.equal(await question().locator('.qhdr .cnt').textContent(), 'picked several');
    // This question carried no annotation, so nothing borrows the other's.
    assert.equal(await question().locator('.qnote').count(), 0);

    // The half jsdom cannot hold, and the whole of what the reader reported.
    //
    // The row is a column so that a live field can sit under the pick, and a
    // record that drew the digit, the mark and the label as three of that
    // column's own children stacked them: the digit alone on one line, the
    // badge adrift under the answer.
    const box = async (sel: string) => {
      const b = await question().locator(sel).boundingBox();
      assert.ok(b, sel + ' has no box');
      return b;
    };
    const [kbd, label, badge, words] = await Promise.all([
      box('.qopt.other .kbd'),
      box('.qopt.other .qopt-label'),
      box('.qopt.other .answered'),
      box('.qopt.other .qother-said')
    ]);
    type Box = { y: number; height: number };
    const shares = (a: Box, b: Box) => a.y < b.y + b.height && b.y < a.y + a.height;
    assert.ok(shares(kbd, label), 'the digit sits on the label’s line');
    // The badge is centred against the whole row rather than against the
    // label, so what it must not do is fall past the words onto a line of its
    // own — it is beside them, at the far edge.
    assert.ok(shares(badge, words), 'the badge is beside the answer');
    assert.ok(badge.x >= words.x + words.width, 'at the row’s far edge');

    // The whole answer is on screen, asked of the words themselves rather than
    // of their height: one line of them is ~23px against a 15px line box, so a
    // height threshold that separates one line from three is a coincidence of
    // the padding the fixed row does not have.
    const [saidScroll, saidClient] = await question()
      .locator('.qopt.other .qother-said')
      .evaluate((n) => [n.scrollWidth, n.clientWidth]);
    assert.ok(saidScroll <= saidClient, `the answer is clipped: ${saidScroll} > ${saidClient}`);

    // And the column does not pan, which is the gutter's doing rather than the
    // wrapping's: `.qopt` is align-items: flex-start, so a column child is
    // shrink-to-fit and a nowrap span took max-content width — `.qcol` is
    // overflow-y: auto, which computes overflow-x to auto with it. The
    // `.qother-pick` width: 100% restored above is what holds this.
    const [colScroll, colClient] = await question()
      .locator('.qcol')
      .evaluate((n) => [n.scrollWidth, n.clientWidth]);
    assert.ok(colScroll <= colClient, `the column pans sideways: ${colScroll} > ${colClient}`);

    // Dismiss the replay, then return to composition.
    await question().locator('.qclose').click();
    await panel().locator('#ask').waitFor({ state: 'hidden', timeout: 10_000 });
    await openDraft();
  });
});
