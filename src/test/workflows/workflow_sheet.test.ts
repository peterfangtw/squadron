/**
 * The bottom drawer: the panel's one workflow surface, opened from the bar's
 * handle and from the composer's pill.
 *
 * One scenario per PRD §8 where the scenario is drawable in jsdom. S2 (the
 * drag) is P3 and lives with the pointer code; S6's layering is a stylesheet
 * fact and belongs to `containment.test.ts` and `z_index.md`.
 */
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cardView,
  groupView,
  openPanel,
  stateMessage,
  threadView,
  workflowView,
  type Panel,
  composerKey
} from '../harness';

const OWNED = [groupView({ sessions: [cardView({ pid: 5, owned: true, startedAt: 5_000 })] })];
/** A session this window does not drive. */
const TYPED = [groupView({ sessions: [cardView({ pid: 7, startedAt: 7_000 })] })];

const ship = workflowView({ id: 'ship', label: 'PR & CI' });
const review = workflowView({ id: 'review', label: 'Peer Review', steps: [] });
const triage = workflowView({ id: 'triage', label: 'Bug Triage' });

const sheet = (p: Panel): HTMLElement | null => p.window.document.getElementById('bottomdrawer');
const rows = (p: Panel): HTMLElement[] => [
  ...p.window.document.querySelectorAll<HTMLElement>('#bottomdrawer-body .wsrow')
];
const names = (p: Panel): (string | null)[] =>
  rows(p).map((r) => r.querySelector('.nm')!.textContent);
/** A row's own Edit, Duplicate or Delete button. */
const act = (row: HTMLElement | undefined, name: 'edit' | 'dup' | 'del'): HTMLElement | null =>
  row?.querySelector<HTMLElement>(`.act.${name}`) ?? null;
const handle = (p: Panel): HTMLElement | null =>
  p.window.document.querySelector<HTMLElement>('#bottomhub .wmore');

/** Escape, pressed on the sheet itself — the composer's own Escape is the
 *  interrupt, and the sheet deliberately leaves that alone. */
const esc = (p: Panel): void => {
  p.window.document
    .getElementById('bottomdrawer')
    ?.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
};

/** Opens the panel on one owned session, selected, with `workflows` on the wire. */
function open(
  t: Parameters<typeof openPanel>[0],
  workflows: WorkflowView[],
  groups = OWNED,
  pid = 5
): Panel {
  const p = openPanel(t);
  const startedAt = groups
    .flatMap((group) => group.sessions)
    .find((card) => card.pid === pid)?.startedAt;
  p.push(stateMessage(groups, { workflows }));
  p.window.document.querySelector<HTMLElement>('.card')?.click();
  p.push(
    stateMessage(groups, {
      workflows,
      thread: threadView({ pid, startedAt, owned: groups === OWNED })
    })
  );
  return p;
}

describe('the bottom drawer', () => {
  for (const dismiss of ['backdrop', 'close', 'Escape', 'Cancel'] as const) {
    it(`leaves Warm open when login owns clicks and ${dismiss}`, (t) => {
      const p = open(t, [ship]);
      const doc = p.window.document;
      doc.querySelector<HTMLElement>('#bottomhub .warm-tab')?.click();
      p.push({ type: 'loginProgress', brand: 'claude', phase: 'paste' });
      const login = doc.getElementById('ascrim');
      assert.ok(login && !login.hidden, 'login did not open over Warm');
      login.querySelector<HTMLElement>('.asbody')?.click();
      assert.equal(sheet(p)?.hidden, false, 'login body click dismissed Warm');
      login.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert.equal(login.hidden, false, 'locked login lost Escape ownership');
      assert.equal(sheet(p)?.hidden, false);

      p.push({ type: 'loginProgress', brand: 'claude', phase: 'error', message: 'Try again.' });
      if (dismiss === 'backdrop') login.click();
      if (dismiss === 'close') login.querySelector<HTMLElement>('.ax')?.click();
      if (dismiss === 'Escape') {
        login.dispatchEvent(
          new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
      }
      if (dismiss === 'Cancel') {
        [...login.querySelectorAll('button')]
          .find((button) => button.textContent === 'Cancel')
          ?.click();
      }
      assert.equal(login.hidden, true, 'login did not dismiss');
      assert.equal(sheet(p)?.hidden, false, 'dismissing login also dismissed Warm');
      assert.equal(p.posted.at(-1)?.type, 'cancelLogin');
      esc(p);
      assert.equal(sheet(p)?.hidden, true, 'Warm did not take the next Escape');
    });
  }

  it('opens from the bar handle and lists every workflow in the pushed order', (t) => {
    const p = open(t, [triage, ship, review]);
    assert.ok(sheet(p)?.hidden, 'shut until asked for');
    handle(p)?.click();

    assert.equal(sheet(p)?.hidden, false);
    const note = p.window.document.getElementById('bottomdrawer-note');
    assert.equal(note?.hidden, false);
    assert.equal(
      note?.textContent,
      'Compose a workflow so an agent takes on more complex work, and follows the steps you wrote.'
    );
    assert.deepEqual(names(p), ['Bug Triage', 'PR & CI', 'Peer Review']);
    assert.equal(rows(p)[1]?.querySelector('.meta')?.textContent, '3 steps');
    assert.equal(rows(p)[2]?.querySelector('.meta')?.textContent, '0 steps');
  });

  // A workflow is applied from the composer, never from here: the sheet
  // manages the collection and shows what each one does.
  it('selects a row on a press, and applies nothing', (t) => {
    const p = open(t, [ship, review]);
    handle(p)?.click();
    const posts = p.posted.length;

    rows(p)[0]?.click();
    assert.equal(sheet(p)?.hidden, false, 'a press keeps the sheet up');
    assert.equal(
      p.window.document.querySelector('#bottomdrawer-body .bddetail .dh')?.textContent,
      'PR & CI3 steps'
    );
    assert.ok(rows(p)[0]?.classList.contains('sel'));
    assert.equal(p.window.document.querySelector('#wattach .wflow.armed'), null);
    assert.equal(p.posted.length, posts, 'nothing is posted');
  });

  it('names no session to apply to in its head', (t) => {
    const p = open(t, [ship]);
    handle(p)?.click();
    assert.doesNotMatch(
      p.window.document.getElementById('bottomdrawer-head')?.textContent ?? '',
      /Apply to/
    );
  });

  // Managing and reading the list never needed a session, and now nothing does.
  it('selects a row whatever the selected session is', (t) => {
    const p = open(t, [ship], TYPED, 7);
    handle(p)?.click();
    rows(p)[0]?.click();
    assert.equal(
      p.window.document.querySelector('#bottomdrawer-body .bddetail .dh')?.textContent,
      'PR & CI3 steps'
    );
  });

  it('draws the detail column empty until a row is selected, and never hides it', (t) => {
    const p = open(t, [ship, review]);
    handle(p)?.click();
    const detail = p.window.document.querySelector('#bottomdrawer-body .bddetail');
    assert.ok(detail, 'the column is drawn with nothing selected');
    assert.match(detail?.textContent ?? '', /Select a workflow to see its steps/);
    assert.equal(detail?.querySelector('.wssteps'), null);
  });

  it('shows the selected workflow’s steps beside the list, never inside it', (t) => {
    const p = open(t, [ship, review]);
    handle(p)?.click();
    rows(p)[0]?.click();

    const detail = p.window.document.querySelector('#bottomdrawer-body .bddetail');
    assert.equal(detail?.querySelector('.dh')?.textContent, 'PR & CI3 steps');
    assert.deepEqual(
      [...(detail?.querySelectorAll('.wssteps .wstep') ?? [])].map((s) => s.textContent),
      ['Plan', 'Build', 'Review']
    );
    // The list never gains a node, which is the whole point: selecting a row
    // cannot reflow the column the pointer is resting in.
    assert.equal(p.window.document.querySelector('#bottomdrawer-body .bdlist .wssteps'), null);
    assert.ok(rows(p)[0]?.classList.contains('sel'), 'the row says it is the one');

    rows(p)[1]?.click();
    assert.equal(
      p.window.document.querySelector('#bottomdrawer-body .bddetail .dh')?.textContent,
      'Peer Review0 steps'
    );
    assert.equal(rows(p).filter((r) => r.classList.contains('sel')).length, 1);
  });

  // A workflow deleted elsewhere leaves nothing to draw, so the column says
  // what an empty one says rather than keeping a title with no steps under it.
  it('falls back to the hint when the selected workflow goes', (t) => {
    const p = open(t, [ship, review, triage]);
    handle(p)?.click();
    rows(p)[0]?.click();

    p.push(stateMessage(OWNED, { workflows: [review, triage] }));
    assert.match(
      p.window.document.querySelector('#bottomdrawer-body .bddetail')?.textContent ?? '',
      /Select a workflow to see its steps/
    );
  });

  it('offers Edit, Duplicate and Delete on the row itself, and no menu', (t) => {
    const p = open(t, [ship, review]);
    handle(p)?.click();
    const row = rows(p)[0];
    assert.deepEqual(
      [...(row?.querySelectorAll<HTMLElement>('.act') ?? [])].map((b) =>
        b.getAttribute('aria-label')
      ),
      ['Edit PR & CI', 'Duplicate PR & CI', 'Delete PR & CI']
    );
    assert.equal(row?.querySelector('.act.peek, .act.more, .fwrap'), null);

    act(row, 'dup')?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'duplicateWorkflow', id: 'ship' });
    assert.ok(!row?.classList.contains('sel'), 'a row button is not a press on the row');
  });

  it('opens the editor from the list’s last row, and closes the sheet doing it', (t) => {
    const p = open(t, [ship]);
    handle(p)?.click();
    p.window.document.querySelector<HTMLElement>('#bottomdrawer-body .wsnew')?.click();
    assert.ok(sheet(p)?.hidden, 'one region — the editor is a mode of it');
    assert.equal(p.window.document.getElementById('wfeditor')?.hidden, false);
  });

  // S7
  it('draws the handle alone on the bar', (t) => {
    const p = open(t, [ship, review, triage]);
    assert.ok(handle(p), 'the handle is the only control left on the bar');
    assert.equal(p.window.document.querySelector('#bottomhub .rsw, #bottomhub .bedit'), null);
  });

  // S8
  it('never opens on an empty machine, which keeps its lone New workflow', (t) => {
    const p = open(t, []);
    assert.equal(handle(p), null);
    assert.equal(
      p.window.document.querySelector('#bottomhub .fpill')?.textContent,
      '+ New workflow'
    );
    assert.ok(sheet(p)?.hidden);
  });

  it('shuts on Esc and on a press past it on the board', (t) => {
    const p = open(t, [ship]);
    handle(p)?.click();
    esc(p);
    assert.ok(sheet(p)?.hidden);

    handle(p)?.click();
    p.window.document.getElementById('bottomdrawer-scrim')?.click();
    assert.ok(sheet(p)?.hidden);
  });

  it('does not shut on a press inside itself', (t) => {
    const p = open(t, [ship, review]);
    handle(p)?.click();
    p.window.document.querySelector<HTMLElement>('#bottomdrawer-head .ttl')?.click();
    assert.equal(
      sheet(p)?.hidden,
      false,
      '#bottomdrawer is a child of #board — the board rule would'
    );
    rows(p)[0]?.click();
    assert.equal(sheet(p)?.hidden, false);
  });

  // C9
  it('is mutually exclusive with the workflow overview drawer', (t) => {
    const p = openPanel(t);
    const groups = OWNED;
    const workflows = [ship];
    p.push(stateMessage(groups, { workflows }));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(
      stateMessage(groups, {
        workflows,
        thread: threadView({
          pid: 5,
          startedAt: 5_000,
          owned: true,
          workflow: { label: 'PR & CI', steps: [{ id: 'plan', label: 'Plan', status: 'pending' }] }
        })
      })
    );
    const live = p.window.document.querySelector<HTMLElement>('#wattach .wflow.live');
    assert.ok(live, 'the run drew no live chip');
    live.click();
    assert.equal(p.window.document.getElementById('workflowoverviewdrawer')?.hidden, false);

    handle(p)?.click();
    assert.equal(sheet(p)?.hidden, false);
    assert.ok(
      p.window.document.getElementById('workflowoverviewdrawer')?.hidden,
      'one covers the board at a time'
    );
  });

  it('fades the bar while it is up, and brings it back on close', (t) => {
    const p = open(t, [ship]);
    const board = p.window.document.getElementById('board');
    handle(p)?.click();
    assert.ok(board?.classList.contains('drawer-open'));
    esc(p);
    assert.ok(!board?.classList.contains('drawer-open'));
  });

  // What that menu offers is `chat_workflow.test.ts`'s; what belongs here is
  // that a pick made at the caret opens nothing over the board.
  it('is not what the composer opens for a pick', (t) => {
    const p = open(t, [ship, review]);
    const pill = p.window.document.querySelector<HTMLElement>('#wattach .fpill');
    assert.match(pill?.textContent ?? '', /Apply workflow/);
    pill?.click();
    assert.ok(sheet(p)?.hidden);
    assert.ok(p.window.document.querySelector('#wattach .fmenu .mitem'));
  });

  it('offers a filter past eight workflows, and narrows on it', (t) => {
    const many = Array.from({ length: 9 }, (_, i) =>
      workflowView({ id: `w${i}`, label: `Workflow ${i}` })
    );
    const p = open(t, many);
    handle(p)?.click();
    const box = p.window.document.querySelector<HTMLInputElement>(
      '#bottomdrawer-body .fsearch, #bottomdrawer-filter'
    );
    assert.ok(box, 'a list this long is worth searching');
    box.value = 'Workflow 3';
    box.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    assert.deepEqual(names(p), ['Workflow 3']);
  });

  it('keeps the search over the list column', (t) => {
    const many = Array.from({ length: 9 }, (_, i) =>
      workflowView({ id: `w${i}`, label: `Workflow ${i}` })
    );
    const p = open(t, many);
    handle(p)?.click();
    const box = p.window.document.querySelector<HTMLInputElement>('#bottomdrawer-filter');
    assert.ok(box);
    assert.equal(box.parentElement?.id, 'bottomdrawer-find');
    assert.equal(box.closest('#bottomdrawer-body'), null);
    assert.equal(box.closest('.bddetail'), null);
    const find = box.parentElement;
    assert.ok(find);
    const body = p.window.document.getElementById('bottomdrawer-body')!;
    const columns = (node: Element): string => p.window.getComputedStyle(node).gridTemplateColumns;
    const findCols = columns(find);
    assert.ok(findCols && findCols !== 'none', `the search band has no columns (${findCols})`);
    assert.equal(findCols, columns(body));
    assert.equal(p.window.getComputedStyle(box).gridColumn, '1');

    p.push(stateMessage(OWNED, { workflows: [ship, review] }));
    assert.equal(box.hidden, true);
    assert.equal(p.window.getComputedStyle(find).display, 'none');
  });

  // S4 — the ids linger in the file; the panel draws neither
  it('draws no row for a workflow that has gone', (t) => {
    const p = open(t, [ship, review]);
    handle(p)?.click();
    assert.equal(rows(p).length, 2);

    p.push(stateMessage(OWNED, { workflows: [review] }));
    assert.deepEqual(names(p), ['Peer Review']);
  });
  // Found in review: the confirm button is keyed and survives a repaint, so a
  // handler closed over the first id would delete the workflow nobody asked about.
  // The confirm moved onto the row itself, so the second ask must also *leave*
  // the first row — a morph that matched by position would have left two.
  it('deletes the workflow the confirm is currently asking about', (t) => {
    const p = open(t, [ship, review]);
    handle(p)?.click();
    act(rows(p)[0], 'del')?.click();
    act(rows(p)[1], 'del')?.click();
    const asking = [
      ...p.window.document.querySelectorAll<HTMLElement>('#bottomdrawer-body .wsrow.confirming')
    ];
    assert.equal(asking.length, 1, 'one row is asking');
    assert.equal(asking[0]?.dataset.id, 'review');
    // The controls it stands in place of are gone while it does.
    assert.equal(asking[0]?.querySelector('.act.edit, .act.dup, .act.del'), null);

    [...(asking[0]?.querySelectorAll<HTMLElement>('.fbtn') ?? [])]
      .find((b) => b.textContent === 'Delete')
      ?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'deleteWorkflow', id: 'review' });
  });

  it('cancels on the row, and gives the row its controls back', (t) => {
    const p = open(t, [ship, review]);
    handle(p)?.click();
    act(rows(p)[0], 'del')?.click();
    const posts = p.posted.length;
    [...rows(p)[0]!.querySelectorAll<HTMLElement>('.fbtn')]
      .find((b) => b.textContent === 'Cancel')
      ?.click();
    assert.equal(p.posted.length, posts, 'nothing is written');
    assert.equal(p.window.document.querySelector('#bottomdrawer-body .wsrow.confirming'), null);
    assert.ok(act(rows(p)[0], 'del'));
  });

  // A press on the row while it is asking must not move the selection under
  // the question — the confirm's two buttons are the only answers.
  it('does not select the row a confirm is standing on', (t) => {
    const p = open(t, [ship, review]);
    handle(p)?.click();
    act(rows(p)[0], 'del')?.click();
    rows(p)[0]?.click();
    assert.ok(!rows(p)[0]?.classList.contains('sel'), 'the press got through');
    assert.ok(rows(p)[0]?.classList.contains('confirming'), 'the question is still up');
  });

  it('shuts from the close in its own head', (t) => {
    const p = open(t, [ship]);
    handle(p)?.click();
    p.window.document.getElementById('bottomdrawer-close')?.click();
    assert.ok(sheet(p)?.hidden);
  });

  // Found in review: the drawer's chip is in the dock, so it trips no dismissal
  // listener — and a drawer opened under #bottomdrawer-scrim is greyed out and unclickable.
  it('closes when the workflow overview drawer opens, as well as the other way round', (t) => {
    const groups = OWNED;
    const workflows = [ship];
    const p = openPanel(t);
    p.push(stateMessage(groups, { workflows }));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(
      stateMessage(groups, {
        workflows,
        thread: threadView({
          pid: 5,
          startedAt: 5_000,
          owned: true,
          workflow: { label: 'PR & CI', steps: [{ id: 'plan', label: 'Plan', status: 'pending' }] }
        })
      })
    );
    handle(p)?.click();
    assert.equal(sheet(p)?.hidden, false);

    const live = p.window.document.querySelector<HTMLElement>('#wattach .wflow.live');
    assert.ok(live, 'the selected session shows its live workflow');
    live?.click();
    assert.equal(p.window.document.getElementById('workflowoverviewdrawer')?.hidden, false);
    assert.ok(sheet(p)?.hidden, 'one covers the board at a time');
  });

  // The row is the only way to select, so it is a tab stop and Enter or Space
  // on it selects. Focus alone does not: a press focuses the row ahead of the
  // click's guards.
  it('selects from the keyboard on the row itself, never on focus', (t) => {
    const p = open(t, [ship, review]);
    handle(p)?.click();
    const row = rows(p)[1]!;
    assert.equal(row.tabIndex, 0);
    assert.equal(row.getAttribute('role'), null);
    // Not `aria-disabled` either, which ARIA inherits to focusable descendants
    // and would tell a reader its buttons are dead too.
    assert.equal(row.getAttribute('aria-disabled'), null);
    row.focus();
    assert.ok(!rows(p)[1]?.classList.contains('sel'), 'focus selected');
    const key = (on: Element, k: string): void => {
      on.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
    };
    key(act(rows(p)[1], 'dup')!, 'Enter');
    assert.ok(!rows(p)[1]?.classList.contains('sel'), 'Enter on a button selected the row');
    key(rows(p)[1]!, 'Enter');
    assert.ok(rows(p)[1]?.classList.contains('sel'));
    key(rows(p)[0]!, ' ');
    assert.ok(rows(p)[0]?.classList.contains('sel'));
  });

  // The confirm stands on the row that holds its own Delete and Cancel, so a row
  // that marked itself disabled would make the question unanswerable.
  it('leaves a confirming row answerable', (t) => {
    const p = open(t, [ship, review]);
    handle(p)?.click();
    act(rows(p)[0], 'del')?.click();
    const asking = rows(p)[0];
    assert.equal(asking?.getAttribute('role'), null, 'no longer a button while it asks');
    assert.equal(asking?.getAttribute('aria-disabled'), null);
    for (const b of asking?.querySelectorAll<HTMLButtonElement>('.fbtn') ?? []) {
      assert.equal(b.disabled, false);
      assert.equal(b.getAttribute('aria-disabled'), null);
    }
  });

  // Found in review: the composer's Escape is the interrupt, and the sheet must
  // not take it — the dock stays usable while the sheet is up.
  it('closes on Escape off the composer without ending the turn', (t) => {
    const p = openPanel(t);
    const thread = threadView({ pid: 5, startedAt: 5_000, owned: true, status: 'busy' });
    p.push(stateMessage(OWNED, { workflows: [ship] }));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(stateMessage(OWNED, { workflows: [ship], thread }));
    handle(p)?.click();
    assert.equal(sheet(p)?.hidden, false);
    const interrupts = (): number => p.posted.filter((m) => m.type === 'interrupt').length;
    p.window.document.body.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    assert.equal(sheet(p)?.hidden, true);
    assert.equal(interrupts(), 0, 'one Escape closed the sheet and ended the turn');
    p.window.document.body.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    assert.equal(interrupts(), 1);
  });

  it('leaves the composer its own Escape', (t) => {
    const p = open(t, [ship]);
    handle(p)?.click();
    composerKey(p, 'Escape', { cancelable: false });
    assert.equal(sheet(p)?.hidden, false, 'Escape in the box is the interrupt, not a dismissal');
  });

  it('stays open when Escape belongs to IME composition in the filter', (t) => {
    const many = Array.from({ length: 9 }, (_, i) =>
      workflowView({ id: `w${i}`, label: `Workflow ${i}` })
    );
    const p = open(t, many);
    handle(p)?.click();
    const box = p.window.document.querySelector<HTMLInputElement>('#bottomdrawer-filter');
    assert.ok(box);
    box.focus();
    for (const extra of [{ isComposing: true }, { keyCode: 229 }]) {
      box.dispatchEvent(
        new p.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
          ...extra
        })
      );
      assert.equal(sheet(p)?.hidden, false);
    }
    box.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    assert.equal(sheet(p)?.hidden, true);
  });
});

/**
 * S2 — the drag.
 *
 * jsdom lays nothing out, so every rect is zero and every boundary is the tail.
 * `stackRows` gives the drawn rows a 100px ruler for the length of one test —
 * the row at index `i` covers `[i * 100, i * 100 + 100)`, so its midpoint is
 * `i * 100 + 50` and a boundary can be aimed at. `offsetTop` / `offsetHeight`
 * are stacked to the same ruler, which is a different question: the index is
 * read off viewport coordinates and the drop line is placed in the list's own.
 */
function stackRows(p: Panel): void {
  const index = (n: Element): number => {
    const parent = n.parentElement;
    if (!parent || !n.classList.contains('wsrow')) return -1;
    return [...parent.children].indexOf(n);
  };
  const proto = p.window.Element.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
  };
  proto.getBoundingClientRect = function rect(this: Element) {
    const i = index(this);
    const top = i === -1 ? 0 : i * 100;
    const height = i === -1 ? 0 : 100;
    return { top, height, bottom: top + height, left: 0, right: 0, width: 0 } as DOMRect;
  };
  const html = p.window.HTMLElement.prototype;
  Object.defineProperty(html, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      return Math.max(index(this), 0) * 100;
    }
  });
  Object.defineProperty(html, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return index(this) === -1 ? 0 : 100;
    }
  });
}

const grip = (p: Panel, i: number): HTMLElement => {
  const g = rows(p)[i]?.querySelector<HTMLElement>('.wsgrip');
  assert.ok(g, `no grip on row ${i}`);
  return g;
};

/**
 * One pointer event, on the node a real one would land on.
 *
 * `PointerEvent` is read off the window rather than the realm's globals — the
 * script builds against this window's prototypes — and typed by hand, because
 * `@types/jsdom` does not carry the constructor.
 */
function pointer(p: Panel, node: EventTarget, type: string, y: number, x = 0): void {
  const Ctor = (p.window as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
  node.dispatchEvent(
    new Ctor(type, { pointerId: 1, clientX: x, clientY: y, bubbles: true, cancelable: true })
  );
}

const flying = (p: Panel): HTMLElement | null =>
  p.window.document.querySelector<HTMLElement>('#bottomdrawer .wsrow.flying');

describe('the bottom drawer’s drag', () => {
  /** Three workflows, sheet open, rows on the 100px ruler. */
  function dragging(t: Parameters<typeof openPanel>[0]): Panel {
    const p = open(t, [triage, ship, review]);
    handle(p)?.click();
    stackRows(p);
    return p;
  }

  it('lifts from the grip, carries a copy, and lands the row where the line is', (t) => {
    const p = dragging(t);
    pointer(p, grip(p, 0), 'pointerdown', 20);

    assert.ok(flying(p), 'a copy is in the air, inside the sheet');
    assert.ok(rows(p)[0]?.classList.contains('lifted'), 'the source stays, dimmed');
    assert.equal(flying(p)?.dataset.id, undefined, 'the copy is not a second row with that id');

    // Past the first row's midpoint and short of the second's: the boundary
    // above `Peer Review`, which lands the carried row second.
    pointer(p, p.window.document, 'pointermove', 160);
    const line = p.window.document.querySelector<HTMLElement>('#bottomdrawer-body .bdlist .wsins');
    assert.ok(line?.classList.contains('on'), 'the line says where it would land');
    assert.equal(line?.style.top, '199px', 'drawn in the gutter, never onto a row');

    pointer(p, p.window.document, 'pointerup', 160);
    assert.equal(flying(p), null);
    assert.equal(p.window.document.querySelector('.wsrow.lifted'), null);
    assert.equal(p.window.document.querySelector('.wsins'), null);
    assert.deepEqual(names(p), ['PR & CI', 'Bug Triage', 'Peer Review']);
    // Only as far down as the move reached — the tail stays label-ordered.
    assert.deepEqual(p.posted.at(-1), {
      type: 'writeWorkflowOrder',
      order: ['ship', 'triage']
    });
  });

  // Nothing crosses the wire until the release, which is what makes S6 true: a
  // question painting over the sheet mid-flight leaves the order alone.
  it('states nothing until the release', (t) => {
    const p = dragging(t);
    const posts = p.posted.length;
    pointer(p, grip(p, 0), 'pointerdown', 20);
    pointer(p, p.window.document, 'pointermove', 260);
    assert.equal(p.posted.length, posts, 'a flight in the air has written nothing');
    assert.deepEqual(names(p), ['Bug Triage', 'PR & CI', 'Peer Review']);
  });

  // A drag ends in a click on the row it started on, and a click here selects.
  it('does not select the row it just dragged', (t) => {
    const p = dragging(t);
    pointer(p, grip(p, 0), 'pointerdown', 20);
    pointer(p, p.window.document, 'pointermove', 160);
    pointer(p, p.window.document, 'pointerup', 160);
    p.window.document.querySelector<HTMLElement>('.wsrow[data-id="triage"]')?.click();

    assert.equal(sheet(p)?.hidden, false, 'the sheet is still open');
    assert.match(
      p.window.document.querySelector('#bottomdrawer-body .bddetail')?.textContent ?? '',
      /Select a workflow to see its steps/
    );
  });

  it('lifts on a hold anywhere on the row, and not on a press that travels', async (t) => {
    const p = dragging(t);
    pointer(p, rows(p)[0]!, 'pointerdown', 20);
    assert.equal(flying(p), null, 'nothing is in the air yet');
    await new Promise((r) => setTimeout(r, 420));
    assert.ok(flying(p), 'the hold became a lift');
    pointer(p, p.window.document, 'pointerup', 20);

    // The same press, moved first: a scroll, not a lift.
    pointer(p, rows(p)[0]!, 'pointerdown', 20);
    pointer(p, p.window.document, 'pointermove', 60);
    await new Promise((r) => setTimeout(r, 420));
    assert.equal(flying(p), null);
    pointer(p, p.window.document, 'pointerup', 60);
  });

  it('puts the row back on Esc, and keeps the sheet', (t) => {
    const p = dragging(t);
    const posts = p.posted.length;
    pointer(p, grip(p, 0), 'pointerdown', 20);
    pointer(p, p.window.document, 'pointermove', 260);
    esc(p);

    assert.equal(flying(p), null);
    assert.equal(sheet(p)?.hidden, false, 'Esc cancels what is in the air, not the surface');
    assert.equal(p.posted.length, posts);
    assert.deepEqual(names(p), ['Bug Triage', 'PR & CI', 'Peer Review']);
  });

  // The `heldOpen` guard's other half: a poll must not reorder the rows a
  // flight is measuring itself against.
  it('holds the list still while a row is in the air', (t) => {
    const p = dragging(t);
    const first = rows(p)[0]!;
    pointer(p, grip(p, 0), 'pointerdown', 20);
    p.push(stateMessage(OWNED, { workflows: [review, ship, triage] }));

    assert.equal(rows(p)[0], first, 'the list was morphed under the flight');
    assert.deepEqual(names(p), ['Bug Triage', 'PR & CI', 'Peer Review']);
    assert.ok(flying(p), 'and the flight survived it');
  });

  // The drawn rows are the hits, and the order is stated over the whole list.
  it('refuses to lift while the list is filtered', (t) => {
    const many = Array.from({ length: 9 }, (_, i) =>
      workflowView({ id: `w${i}`, label: `Workflow ${i}` })
    );
    const p = open(t, many);
    handle(p)?.click();
    stackRows(p);
    const box = p.window.document.querySelector<HTMLInputElement>('#bottomdrawer-filter')!;
    box.value = 'Workflow';
    box.dispatchEvent(new p.window.Event('input', { bubbles: true }));

    pointer(p, grip(p, 0), 'pointerdown', 20);
    assert.equal(flying(p), null);
  });

  // The add is not a row, so no boundary under it exists to be offered — the
  // last workflow is the last place a workflow can land.
  it('never lands a row under the list’s New', (t) => {
    const p = dragging(t);
    pointer(p, grip(p, 0), 'pointerdown', 20);
    // Well past every row, which is where the add sits.
    pointer(p, p.window.document, 'pointermove', 900);
    pointer(p, p.window.document, 'pointerup', 900);

    assert.deepEqual(names(p), ['PR & CI', 'Peer Review', 'Bug Triage']);
    assert.ok(
      p.window.document.querySelector('#bottomdrawer-body .bdlist > :last-child')?.matches('.wsnew')
    );
  });

  it('starts no flight from a row’s own controls', (t) => {
    const p = dragging(t);
    const edit = act(rows(p)[0], 'edit');
    pointer(p, edit!, 'pointerdown', 20);
    assert.equal(flying(p), null, 'a press on Edit is a press on Edit');
  });
});
