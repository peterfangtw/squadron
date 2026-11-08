/** A workflow step prompt is a prose editor: mentions are chips, and Save writes prose. */
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  attachWorkflow,
  cardView,
  groupView,
  modelView,
  openPanel,
  proseKey,
  proseOf,
  proseRoot,
  stateMessage,
  threadView,
  typeProse,
  workflowView,
  type Panel,
  composerKey,
  typeIn
} from '../harness';

const board = () => [groupView({ sessions: [cardView({ pid: 5, owned: true })] })];

const SKILLS = ['caveman:caveman', 'design', 'ponytail', 'ponytail-audit'];

function select(p: Panel): void {
  p.window.document.querySelector<HTMLElement>('.card')?.click();
}

/** Board mode, on a new workflow — the path that needs no card selected. */
function openNew(p: Panel, over: Record<string, unknown> = {}): void {
  p.push(stateMessage(board(), { workflows: [], skills: SKILLS, ...over }));
  select(p);
  p.window.document.querySelector<HTMLElement>('#wattach .fpill')?.click();
  p.window.document.querySelector<HTMLElement>('#wattach .fmenu .faction')?.click();
}

/** The open step's prompt box: the editor's host. */
function promptField(p: Panel, index = 0): HTMLElement {
  const fields = [...p.window.document.querySelectorAll<HTMLElement>('#wfeditor .wcbody')];
  const field = fields[index];
  assert.ok(field, 'no step prompt open');
  return field;
}

/** Replace what the box holds with `text`, typed as a reader types it. */
function typeInto(p: Panel, box: HTMLElement, text: string): void {
  typeProse(p, box, text);
}

/** Type `text` at the caret, after whatever is there. */
function typeMore(box: HTMLElement, text: string): void {
  proseOf(box).type(text);
}

const value = (box: HTMLElement): string => proseOf(box).value();

function menu(p: Panel): HTMLElement | null {
  const node = p.window.document.getElementById('mentionmenu');
  return node && !node.hidden ? node : null;
}

function menuRows(p: Panel): HTMLElement[] {
  return [...(menu(p)?.querySelectorAll<HTMLElement>('.mnrow') ?? [])];
}

/** The chips in a step's prompt, as the reader sees them, in document order. */
function pills(p: Panel, index = 0): string[] {
  return [...promptField(p, index).querySelectorAll('.pchip.skill')].map(
    (n) => n.textContent ?? ''
  );
}

/** Every chip in the open prompt, as `<kind>:<label>`. */
function chips(p: Panel): string[] {
  return [...promptField(p).querySelectorAll<HTMLElement>('.pchip')].map((n) => {
    const kind = ['skill', 'session', 'model'].find((k) => n.classList.contains(k)) ?? '?';
    return `${kind}:${n.textContent ?? ''}`;
  });
}

/** One Backspace or Delete at document position `at`, as a browser sends it. */
function key(p: Panel, box: HTMLElement, name: string, at: number): KeyboardEvent {
  proseOf(box).select(at);
  return proseKey(p, box, name);
}

const undo = (p: Panel, box: HTMLElement): void => {
  proseKey(p, box, 'z', { ctrlKey: true });
};

function sheetEdit(p: Panel, label: string): void {
  p.window.document.querySelector<HTMLElement>('#bottomhub .wmore')?.click();
  const row = [...p.window.document.querySelectorAll<HTMLElement>('#bottomdrawer .wsrow')].find(
    (r) => r.querySelector('.nm')?.textContent === label
  );
  row?.querySelector<HTMLElement>('.act.edit')?.click();
  p.window.document.querySelector<HTMLElement>('#wfeditor .wcnode')?.click();
}

function openExisting(p: Panel, prompt: string, skills: string[] = SKILLS): void {
  p.push(
    stateMessage(board(), {
      skills,
      workflows: [
        workflowView({
          id: 'hand',
          label: 'Hand written',
          steps: [{ id: 'one', label: 'One', prompt }]
        })
      ]
    })
  );
  select(p);
  sheetEdit(p, 'Hand written');
}

/** A new workflow's two names, so Save has nothing to refuse. */
function nameIt(p: Panel): void {
  const root = p.window.document.getElementById('wfeditor')!;
  const label = root.querySelector<HTMLInputElement>('.wefield input')!;
  label.value = 'Review';
  label.dispatchEvent(new p.window.Event('input', { bubbles: true }));
  const title = root.querySelector<HTMLInputElement>('input.wctitle')!;
  title.value = 'Look';
  title.dispatchEvent(new p.window.Event('input', { bubbles: true }));
}

function savePrompt(p: Panel): Record<string, unknown> {
  p.window.document.querySelector<HTMLButtonElement>('#wfeditor .wesave')?.click();
  const message = p.posted.find((m) => m.type === 'saveWorkflow');
  assert.ok(message, 'no saveWorkflow message');
  return message;
}

const saved = (prompt: string) => ({
  type: 'saveWorkflow',
  id: 'hand',
  label: 'Hand written',
  steps: [{ id: 'one', label: 'One', prompt }]
});

const REF = '@squadron[4821][/home/u/.claude/projects/p/abc.jsonl]';

describe('shared workflow prompt controls', () => {
  it('updates skill recognition after a refresh arrives with the mention menu dismissed', (t) => {
    const p = openPanel(t);
    openNew(p);
    const field = promptField(p);
    typeInto(p, field, '@game');
    proseKey(p, field, 'Escape');
    p.push(stateMessage(board(), { workflows: [], skills: ['game-studio'] }));
    assert.equal(menu(p), null);
    assert.equal(promptField(p), field);
    typeInto(p, field, 'the game-studio skill ');
    assert.deepEqual(pills(p), ['@game-studio']);
    typeInto(p, field, 'the ponytail skill ');
    assert.deepEqual(pills(p), []);
  });

  it('refreshes an unmatched workflow query without rebuilding its prompt', (t) => {
    const p = openPanel(t);
    openNew(p);
    const field = promptField(p);
    typeInto(p, field, '@game');
    assert.equal(p.posted.filter((message) => message.type === 'refreshSkills').length, 1);
    p.push(stateMessage(board(), { workflows: [], skills: [...SKILLS, 'game-studio'] }));
    assert.equal(promptField(p), field);
    assert.deepEqual(
      menuRows(p).map((node) => node.querySelector('.nm')?.textContent),
      ['game-studio']
    );
    menuRows(p)[0]?.click();
    assert.equal(value(field), 'the game-studio skill ');
    assert.deepEqual(pills(p), ['@game-studio']);
  });

  it('offers models and skills without sessions, and saves a model with effort', (t) => {
    const p = openPanel(t);
    openNew(p, { models: [modelView()] });
    nameIt(p);
    const box = promptField(p);
    typeInto(p, box, '@');
    assert.deepEqual(
      menuRows(p).map((row) => row.querySelector('.nm')?.textContent),
      ['Models', 'Skills']
    );
    menuRows(p)
      .find((row) => row.textContent?.includes('Models'))
      ?.click();
    menuRows(p)[0]?.click();
    menuRows(p)
      .find((row) => row.textContent === 'high')
      ?.click();
    assert.match(chips(p)[0] ?? '', /^model:@.*high/);
    assert.match(value(box), /squadron-spawn --brand claude --model-id .*--effort high/);
    assert.equal((savePrompt(p).steps as { prompt: string }[])[0]?.prompt, value(box));
  });

  for (const [format, delivered] of [
    ['code', '`hello`'],
    ['codeBlock', '```\nhello\n```'],
    ['bulletList', '- hello'],
    ['orderedList', '1. hello']
  ]) {
    it(`offers four shared formats and saves ${format}`, (t) => {
      const p = openPanel(t);
      openNew(p);
      nameIt(p);
      const box = promptField(p);
      typeInto(p, box, 'hello');
      proseOf(box).select(1, 6);
      const bar = box.parentElement?.querySelector<HTMLElement>('[role="toolbar"]');
      assert.ok(bar, 'no workflow formatting toolbar');
      assert.deepEqual(
        [...bar.querySelectorAll<HTMLElement>('[data-format]')].map(
          (button) => button.dataset.format
        ),
        ['bulletList', 'orderedList', 'code', 'codeBlock']
      );
      bar.querySelector<HTMLButtonElement>(`[data-format="${format}"]`)?.click();
      assert.equal(value(box), delivered);
      undo(p, box);
      assert.equal(value(box), 'hello');
      proseKey(p, box, 'z', { ctrlKey: true, shiftKey: true });
      assert.equal((savePrompt(p).steps as { prompt: string }[])[0]?.prompt, delivered);
    });
  }

  it('keeps the toolbar and editor through close/reopen and explains chip refusal', (t) => {
    const p = openPanel(t);
    openExisting(p, 'Use the design skill');
    const box = promptField(p);
    const bar = box.parentElement?.querySelector<HTMLElement>('[role="toolbar"]');
    assert.ok(bar);
    const button = bar.querySelector<HTMLButtonElement>('[data-format="codeBlock"]');
    assert.equal(button?.getAttribute('aria-disabled'), 'true');
    assert.match(button?.dataset.tip ?? '', /mention/);
    p.window.document.querySelector<HTMLElement>('#wfeditor .wcdone')?.click();
    p.window.document.querySelector<HTMLElement>('#wfeditor .wcnode')?.click();
    assert.equal(promptField(p), box);
    assert.equal(box.parentElement?.querySelector('[role="toolbar"]'), bar);
    assert.deepEqual(pills(p), ['@design']);
  });
});

describe('the step prompt is one editor', () => {
  it('saves an untouched prompt byte for byte, whatever markdown would make of it', (t) => {
    // Every construct here loads normalized: leading and doubled spaces, three
    // blank lines, a trailing space, a `*` bullet, an escaped star. Untouched,
    // none of that may reach the file.
    const prompt =
      '  Apply the design skill.\n\n\n\nKeep  @unknown and \\*this\\*  \n* one\n* two\n';
    const p = openPanel(t);
    openExisting(p, prompt);
    const box = promptField(p);
    proseOf(box);
    assert.deepEqual(pills(p), ['@design'], 'a saved phrase opens as a chip');
    assert.deepEqual(savePrompt(p), saved(prompt));
  });

  it('saves an edit undone back to the opened text byte for byte', (t) => {
    const prompt = 'Run it.\n\n\nThen  stop.';
    const p = openPanel(t);
    openExisting(p, prompt);
    const box = promptField(p);
    typeMore(box, ' Now.');
    assert.notEqual(value(box), prompt);
    undo(p, box);
    assert.deepEqual(savePrompt(p), saved(prompt));
  });

  it('saves an edited prompt with only the accepted normalizations', (t) => {
    // Blank lines fold to one, a run of spaces or a tab to one space, a `*`
    // bullet re-emits as `-`, `1)` as `1.`, underscore emphasis as stars:
    // Key Decisions, "Accepted normalization when a loaded prompt is edited",
    // and Step 1 and Step 17's deviations. Nothing else moves.
    const p = openPanel(t);
    openExisting(p, 'Read  the\tdiff, _a_ __b__ snake_case.\n\n\n1) first\n\n* one\n* two');
    const box = promptField(p);
    typeMore(box, ' more');
    assert.deepEqual(
      savePrompt(p),
      saved('Read the diff, *a* **b** snake_case.\n\n1. first\n\n- one\n- two more')
    );
  });

  it('saves a skill chip and a session reference in one prompt, each as written', (t) => {
    // `@squadron` was a skill's short token and the head of every reference,
    // and Save expanded the token inside the reference. A chip is an atom: no
    // text of one can be the head of another.
    const prompt = `Use the squadron skill, then hand off to ${REF}.`;
    const p = openPanel(t);
    openExisting(p, prompt, [...SKILLS, 'squadron']);
    const box = promptField(p);
    assert.deepEqual(
      chips(p).map((c) => c.split(':')[0]),
      ['skill', 'session']
    );
    typeMore(box, ' Done.');
    assert.deepEqual(savePrompt(p), saved(`${prompt} Done.`));
  });

  it('keeps the box, its caret, its words and its Undo through a refused Save', (t) => {
    // A refused Save repaints the whole editor and its canvas, as every
    // gesture does.
    const p = openPanel(t);
    openExisting(p, 'first');
    const box = promptField(p);
    proseOf(box).focus();
    typeMore(box, ' second');
    const label = p.window.document.querySelector<HTMLInputElement>('#wfeditor .wefield input')!;
    label.value = '';
    label.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    proseOf(box).focus();
    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .wesave')?.click();
    assert.equal(p.posted.filter((m) => m.type === 'saveWorkflow').length, 0);
    assert.ok(p.window.document.querySelector('#wfeditor .westrip'), 'the refusal was not drawn');
    assert.equal(promptField(p), box, 'the repaint made a new box');
    assert.equal(p.window.document.activeElement, proseRoot(box), 'the repaint took the caret');
    assert.equal(value(box), 'first second');
    undo(p, box);
    assert.equal(value(box), 'first', 'the repaint took the Undo history');
  });

  it('keeps the box through a canvas gesture that repaints the open node', (t) => {
    // A lane rename runs `mountCanvas` again with this node still open.
    const p = openPanel(t);
    p.push(
      stateMessage(board(), {
        skills: SKILLS,
        workflows: [
          workflowView({
            id: 'hand',
            label: 'Hand written',
            steps: [
              { id: 'one', label: 'One', prompt: 'first' },
              { id: 'two', label: 'Two', prompt: 'peer', lane: 's1', needs: ['one'] }
            ]
          })
        ]
      })
    );
    select(p);
    sheetEdit(p, 'Hand written');
    const box = promptField(p);
    typeMore(box, ' typed');
    const lane = p.window.document.querySelector<HTMLButtonElement>('#wfeditor .wchd button.name');
    assert.ok(lane, 'no lane to rename');
    lane.click();
    const field = p.window.document.querySelector<HTMLInputElement>('#wfeditor .wchd input.name')!;
    field.value = 'writers';
    field.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.ok(
      p.window.document.querySelector('#wfeditor .wchd button.name')?.textContent === 'writers',
      'the rename did not repaint'
    );
    assert.equal(promptField(p), box, 'the canvas made a new box');
    assert.equal(value(box), 'first typed');
    undo(p, box);
    assert.equal(value(box), 'first');
  });

  it('gives the same step id in another workflow a fresh editor', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage(board(), {
        skills: SKILLS,
        workflows: [
          workflowView({
            id: 'hand',
            label: 'Hand written',
            steps: [{ id: 'one', label: 'One', prompt: 'first' }]
          }),
          workflowView({
            id: 'other',
            label: 'Other',
            steps: [{ id: 'one', label: 'One', prompt: 'second' }]
          })
        ]
      })
    );
    select(p);
    sheetEdit(p, 'Hand written');
    const first = promptField(p);
    typeMore(first, ' edited');
    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .weback')?.click();
    assert.equal(
      (first as { prose?: unknown }).prose,
      undefined,
      'closing the editor left its prompt editor alive'
    );
    sheetEdit(p, 'Other');
    const second = promptField(p);
    assert.notEqual(second, first);
    assert.equal(value(second), 'second');
    undo(p, second);
    assert.equal(value(second), 'second', 'the other workflow’s history came along');
  });
});

describe('the step prompt’s lifetime', () => {
  const two = () =>
    stateMessage(board(), {
      skills: SKILLS,
      workflows: [
        workflowView({
          id: 'hand',
          label: 'Hand written',
          steps: [{ id: 'one', label: 'One', prompt: 'first' }]
        }),
        workflowView({
          id: 'other',
          label: 'Other',
          steps: [{ id: 'one', label: 'One', prompt: 'second' }]
        })
      ]
    });

  it('gives the same step id a fresh editor when another workflow opens over this one', (t) => {
    // The composer's workflow chip stays live under the editor, so its Edit
    // opens a second workflow with no Back in between: only the opening in
    // the box's key tells the two `one`s apart.
    const p = openPanel(t);
    p.push(two());
    select(p);
    sheetEdit(p, 'Hand written');
    const first = promptField(p);
    typeMore(first, ' edited');
    attachWorkflow(p, 'Other');
    p.window.document.querySelector<HTMLElement>('#wattach .wflow .wedit')?.click();
    p.window.document.querySelector<HTMLElement>('#wfeditor .wcnode')?.click();
    const second = promptField(p);
    assert.notEqual(second, first);
    assert.equal(value(second), 'second');
    assert.equal(
      (first as { prose?: unknown }).prose,
      undefined,
      'the first one outlived its opening'
    );
  });

  it('gives a new step a fresh editor when it takes a removed step’s id', (t) => {
    // `mintId` hands a removed, never-saved id out again.
    const p = openPanel(t);
    openNew(p);
    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .wcaddstep')?.click();
    const removed = promptField(p);
    assert.equal(
      p.window.document.querySelector('#wfeditor .wcnode.editing')?.getAttribute('data-node'),
      'step-2'
    );
    typeInto(p, removed, 'left behind');
    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .wcnode.editing .werm')?.click();
    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .wcaddstep')?.click();
    assert.equal(
      p.window.document.querySelector('#wfeditor .wcnode.editing')?.getAttribute('data-node'),
      'step-2'
    );
    const added = promptField(p);
    assert.notEqual(added, removed);
    assert.equal(value(added), '');
  });
});

describe('skills in a workflow step', () => {
  it('saves an edit as its delivery, without Done', (t) => {
    const p = openPanel(t);
    openExisting(p, 'Use the design skill');
    typeInto(p, promptField(p), 'First the design skill, then review.');
    assert.deepEqual(savePrompt(p), saved('First the design skill, then review.'));
  });

  it('offers the machine’s skills, not the selected session’s', (t) => {
    // The population is the point of this case. A thread carrying a different
    // list is what tells the two apart — reading `ThreadView.skills` here would
    // be absent exactly when a workflow is written with no card selected.
    const p = openPanel(t);
    p.push(
      stateMessage(board(), {
        workflows: [],
        skills: SKILLS,
        thread: threadView({ pid: 5, skills: ['a-session-only-skill'] })
      })
    );
    select(p);
    p.window.document.querySelector<HTMLElement>('#bottomhub .fpill')?.click();
    typeInto(p, promptField(p), 'first @');
    assert.ok(menu(p), 'no menu opened in the step prompt');
    assert.deepEqual(
      menuRows(p).map((r) => r.textContent),
      SKILLS,
      'the editor drew the session’s list rather than the machine’s'
    );
  });

  it('writes a pick as a chip, then one space', (t) => {
    const p = openPanel(t);
    openNew(p);
    const box = promptField(p);
    typeInto(p, box, 'Read the diff, @pony');
    menuRows(p)[0]?.click();
    assert.equal(value(box), 'Read the diff, the ponytail skill ');
    assert.deepEqual(pills(p), ['@ponytail']);
  });

  it('carries a namespaced name whole, never its alias', (t) => {
    const p = openPanel(t);
    openNew(p);
    const box = promptField(p);
    typeInto(p, box, '@caveman');
    menuRows(p)[0]?.click();
    // Measured: `the caveman skill` answers in the skill's voice and loads
    // nothing at all, which is worse than failing.
    assert.equal(value(box).trim(), 'the caveman:caveman skill');
  });

  it('keeps the chip when the node is closed and reopened', (t) => {
    const p = openPanel(t);
    openNew(p);
    const box = promptField(p);
    typeInto(p, box, 'use the ponytail skill.');
    assert.deepEqual(pills(p), ['@ponytail']);
    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .wcdone')?.click();
    assert.equal(p.window.document.querySelector('#wfeditor .wcbody'), null);
    assert.equal(
      p.window.document.querySelector('#wfeditor .wcdesc')?.textContent,
      'use the ponytail skill.',
      'the closed face shows the prose'
    );
    p.window.document.querySelector<HTMLElement>('#wfeditor .wcnode')?.click();
    assert.equal(promptField(p), box, 'reopening made a new box');
    assert.deepEqual(pills(p), ['@ponytail']);
    nameIt(p);
    assert.deepEqual(savePrompt(p), {
      type: 'saveWorkflow',
      label: 'Review',
      steps: [{ id: 'step-1', label: 'Look', prompt: 'use the ponytail skill.' }]
    });
  });

  it('forms two, in the order they sit in the text', (t) => {
    const p = openPanel(t);
    openNew(p);
    typeInto(p, promptField(p), 'first the design skill then the ponytail skill, then stop');
    assert.deepEqual(pills(p), ['@design', '@ponytail']);
  });

  it('forms a phrase nobody used the menu for', (t) => {
    // The prose is the record, so a phrase typed out forms exactly like one
    // picked off the menu.
    const p = openPanel(t);
    openNew(p);
    typeInto(p, promptField(p), 'apply the ponytail skill here');
    assert.deepEqual(pills(p), ['@ponytail']);
  });

  it('leaves a name this machine has never heard of as prose', (t) => {
    const p = openPanel(t);
    openNew(p);
    typeInto(p, promptField(p), 'use the fictional skill for this');
    assert.deepEqual(pills(p), []);
  });

  it('does not form a plural, or a match starting mid-word', (t) => {
    const p = openPanel(t);
    openNew(p);
    typeInto(p, promptField(p), 'the design skills and soothe design skill ');
    assert.deepEqual(pills(p), []);
  });

  it('takes a chip whole on one Backspace after it, or one Delete before it', (t) => {
    for (const [name, at] of [
      ['Backspace', 6],
      ['Delete', 5]
    ] as const) {
      const p = openPanel(t);
      openExisting(p, 'use the design skill then review');
      const box = promptField(p);
      // `use ` is 1–5, the chip 5–6.
      const event = key(p, box, name, at);
      assert.equal(event.defaultPrevented, true, name);
      assert.deepEqual(pills(p), [], name);
      assert.deepEqual(savePrompt(p), saved('use  then review'), name);
    }
  });

  it('saves the prose the menu wrote, which is the whole feature', (t) => {
    const p = openPanel(t);
    openNew(p);
    nameIt(p);
    typeInto(p, promptField(p), 'Use @ponytail-a');
    menuRows(p)[0]?.click();
    assert.deepEqual(savePrompt(p), {
      type: 'saveWorkflow',
      label: 'Review',
      steps: [{ id: 'step-1', label: 'Look', prompt: 'Use the ponytail-audit skill ' }]
    });
  });

  it('repeats a pick, keeps a namespace whole, and leaves a typed @name as text', (t) => {
    const p = openPanel(t);
    openExisting(p, 'literal @design, use skills');
    const box = promptField(p);
    typeInto(p, box, 'literal @design, use @design');
    menuRows(p)
      .find((row) => row.textContent === 'design')
      ?.click();
    typeMore(box, '@design');
    menuRows(p)
      .find((row) => row.textContent === 'design')
      ?.click();
    typeMore(box, '@caveman');
    menuRows(p)[0]?.click();
    assert.deepEqual(pills(p), ['@design', '@design', '@caveman:caveman']);
    assert.deepEqual(
      savePrompt(p),
      saved('literal @design, use the design skill the design skill the caveman:caveman skill ')
    );
  });

  it('keeps the same box through a refused Save, and saves its edit after', (t) => {
    const p = openPanel(t);
    openExisting(p, 'literal @design, then the design skill');
    const box = promptField(p);
    assert.deepEqual(pills(p), ['@design']);
    typeMore(box, '. Review carefully.');
    const label = p.window.document.querySelector<HTMLInputElement>('#wfeditor .wefield input')!;
    label.value = '';
    label.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .wesave')?.click();
    assert.equal(p.posted.filter((message) => message.type === 'saveWorkflow').length, 0);
    assert.equal(promptField(p), box, 'save refusal replaced the box');
    assert.equal(value(box), 'literal @design, then the design skill. Review carefully.');
    const rebuiltLabel = p.window.document.querySelector<HTMLInputElement>(
      '#wfeditor .wefield input'
    )!;
    rebuiltLabel.value = 'Hand written';
    rebuiltLabel.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    assert.deepEqual(
      savePrompt(p),
      saved('literal @design, then the design skill. Review carefully.')
    );
  });

  it('draws no trigger at all when the machine has reported no skills', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [] }));
    select(p);
    p.window.document.querySelector<HTMLElement>('#bottomhub .fpill')?.click();
    const box = promptField(p);
    typeInto(p, box, 'plain @pony');
    assert.equal(menu(p), null);
    assert.equal(value(box), 'plain @pony');
  });

  it('lets the composer keep its Enter while the editor’s menu is up', (t) => {
    // One menu node, two live boxes: board mode swaps the cards and leaves the
    // dock alone. Without an owner test the composer's Enter was swallowed by a
    // menu belonging to the editor.
    const p = openPanel(t);
    openNew(p);
    typeInto(p, promptField(p), '@pony');
    assert.ok(menu(p), 'the editor’s own menu did not open');
    typeIn(p, 'send me');
    composerKey(p, 'Enter');
    assert.equal(
      p.posted.filter((m) => m.type === 'send').length,
      1,
      'the editor’s menu ate the composer’s send'
    );
  });

  it('shuts on a rebuild, so no menu is left over a replaced field', (t) => {
    const p = openPanel(t);
    openNew(p);
    typeInto(p, promptField(p), '@pony');
    assert.ok(menu(p));
    // Adding a step calls renderEditor(), which replaces every node under it.
    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .wcaddstep')?.click();
    assert.equal(menu(p), null, 'a fixed menu was left parked over a field no longer shown');
  });

  it('shuts when the editor closes, with no pointer anywhere', (t) => {
    // The pointerdown handler masks this for a mouse: pressing Back closes the
    // menu on the way. jsdom's `click()` dispatches no pointerdown, so this is
    // the keyboard-only path — and it is the one that left a fixed menu floating
    // over the restored board, bound to a detached field.
    const p = openPanel(t);
    openNew(p);
    typeInto(p, promptField(p), '@pony');
    assert.ok(menu(p));
    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .weback')?.click();
    assert.equal(menu(p), null, 'the menu outlived the editor');
  });

  it('leaves a phrase that formed no chip to the platform’s Backspace', (t) => {
    const p = openPanel(t);
    openNew(p);
    const box = promptField(p);
    typeInto(p, box, 'soothe design skill');
    const event = proseKey(p, box, 'Backspace');
    assert.equal(event.defaultPrevented, false);
    assert.equal(value(box), 'soothe design skill');
  });

  it('yields a modified Enter to the box while the menu is up', (t) => {
    const p = openPanel(t);
    openNew(p);
    const box = promptField(p);
    typeInto(p, box, '@pony');
    assert.ok(menu(p));
    const ev = proseKey(p, box, 'Enter', { altKey: true });
    assert.equal(ev.defaultPrevented, false);
    assert.equal(value(box), '@pony', 'Alt+Enter picked a menu row');
    assert.equal(p.window.document.querySelectorAll('#wfeditor .wcnode').length, 1);
  });

  it('shuts on a press outside it', (t) => {
    const p = openPanel(t);
    openNew(p);
    typeInto(p, promptField(p), '@pony');
    assert.ok(menu(p));
    p.window.document.body.dispatchEvent(new p.window.Event('pointerdown', { bubbles: true }));
    assert.equal(menu(p), null);
  });

  it('opens no menu beside a chip, picked or reopened from disk', (t) => {
    const p = openPanel(t);
    openNew(p);
    const box = promptField(p);
    typeInto(p, box, 'use @');
    menuRows(p)
      .find((r) => r.textContent === 'design')
      ?.click();
    assert.deepEqual(pills(p), ['@design']);
    // `use ` is 1–5, the chip 5–6: the caret just after it.
    proseOf(box).select(6);
    assert.equal(menu(p), null, 'a picked chip reopened its own search');

    const q = openPanel(t);
    openExisting(q, 'Use the design skill');
    const opened = promptField(q);
    proseOf(opened).select(6);
    assert.equal(menu(q), null, 'a reopened chip offered its own search');
  });
});

describe('models and sessions in a workflow step', () => {
  // As `modelMention` writes it; the editor forms it where it stands.
  const MODEL =
    'a peer on Sonnet 5.5 at low effort (squadron-spawn --brand claude --model-id claude-sonnet-5-5 --context 200000 --effort low)';

  it('forms a model expansion into one chip, and saves it as written', (t) => {
    const p = openPanel(t);
    openNew(p);
    const box = promptField(p);
    typeInto(p, box, `ask ${MODEL} to review`);
    assert.deepEqual(
      chips(p).map((c) => c.split(':')[0]),
      ['model']
    );
    assert.equal(value(box), `ask ${MODEL} to review`);
  });

  it('forms a session reference in the session colour', (t) => {
    const p = openPanel(t);
    openNew(p);
    typeInto(p, promptField(p), `hand off to ${REF} now`);
    assert.deepEqual(
      chips(p).map((c) => c.split(':')[0]),
      ['session']
    );
  });

  it('takes a model chip whole on one Backspace just after it', (t) => {
    const p = openPanel(t);
    openNew(p);
    const box = promptField(p);
    typeInto(p, box, `use ${MODEL}`);
    // `use ` is 1–5, the chip 5–6.
    const event = key(p, box, 'Backspace', 6);
    assert.equal(event.defaultPrevented, true);
    assert.equal(value(box).trimEnd(), 'use');
    assert.deepEqual(chips(p), []);
  });

  it('keeps a squadron skill chip and a session reference apart, and saves both', (t) => {
    // `@squadron` was the short token of a skill this machine has and the head
    // of every reference. A pick is an atom now, so the reference after it is
    // a reference, and Save writes each as it stands.
    const p = openPanel(t);
    openNew(p, { skills: [...SKILLS, 'squadron'] });
    nameIt(p);
    const box = promptField(p);
    typeInto(p, box, 'use @squad');
    menuRows(p)[0]?.click();
    typeMore(box, `then ${REF} `);
    assert.deepEqual(
      chips(p).map((c) => c.split(':')[0]),
      ['skill', 'session']
    );
    assert.deepEqual(savePrompt(p), {
      type: 'saveWorkflow',
      label: 'Review',
      steps: [{ id: 'step-1', label: 'Look', prompt: `use the squadron skill then ${REF} ` }]
    });
  });

  it('draws a model chip on the canvas in the model grey, never an accent', (t) => {
    // jsdom resolves the cascade but not var(): the declaration that won is
    // what is checked, as `chat_mentions.test.ts` does for the composer.
    const p = openPanel(t);
    openNew(p);
    typeInto(p, promptField(p), `ask ${MODEL}`);
    const pill = p.window.document.querySelector('#wfcanvas .wcbody .pchip.model');
    assert.ok(pill, 'no model chip on the canvas');
    const style = p.window.getComputedStyle(pill);
    for (const value of [style.getPropertyValue('background'), style.boxShadow]) {
      assert.match(value, /var\(--av-fg-3\)/);
      assert.doesNotMatch(value, /--av-(orange|yellow|green|purple|link)/);
    }
  });
});
