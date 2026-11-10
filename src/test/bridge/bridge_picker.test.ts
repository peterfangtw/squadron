import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as picker from '../../core/bridge/picker';
import * as words from '../../core/bridge/words';
import type { LaunchTarget } from '../../core/model';
import type { RemoteModels } from '../../core/model_listing';

const folder = { folder: path.resolve('/repo', 'app'), windowId: 'w1' };
const destination = { under: 'original' };
const catalog: RemoteModels = {
  models: {
    brands: [],
    models: [
      { brand: 'claude', model: 'vintage', name: 'Vintage', legacy: true },
      {
        brand: 'codex',
        model: 'reasoner',
        name: 'Reasoner',
        context: 200_000,
        efforts: [{ value: 'high' }, { value: 'low' }],
        defaultEffort: 'high',
        preferredEffort: 'low'
      }
    ]
  },
  remoteSelection: {
    defaultTarget: { brand: 'codex', model: 'reasoner', window: 200_000, effort: 'low' }
  }
};

function models(listing = catalog): picker.PickerDraft {
  const discovering = picker.revise(picker.initial(destination), { kind: 'discover', folder });
  return picker.revise(
    picker.revise(discovering, { kind: 'catalog', result: { catalog: listing } }),
    { kind: 'advance' }
  );
}

function choose(draft: picker.PickerDraft, choice: picker.Choice): picker.Selection {
  return picker.choose(draft, { generation: draft.generation, choice });
}

describe('new-job picker decisions', () => {
  it('starts at folder or the sole folder’s model stage with the original destination', () => {
    assert.deepEqual(picker.initial(destination), {
      stage: 'folder',
      generation: 0,
      page: 0,
      published: 0,
      destination
    });
    assert.deepEqual(picker.initial(destination, folder), {
      stage: 'model',
      generation: 0,
      page: 0,
      published: 0,
      destination,
      folder
    });
    assert.deepEqual(
      choose(picker.initial(destination), { command: 'folder', value: folder.folder }),
      {
        kind: 'folder',
        value: folder.folder
      }
    );
  });

  it('keeps model row indices through Older and selects native effort with its context', () => {
    const model = models();
    const pick = choose(model, { command: 'model', index: 1 });
    assert.equal(pick.kind, 'advance');
    assert.ok(pick.kind === 'advance');
    const effort = picker.revise(pick.draft, { kind: 'advance' });
    assert.equal(effort.stage, 'effort');
    assert.deepEqual(choose(effort, { command: 'effort', value: 'low' }), {
      kind: 'launch',
      target: { brand: 'codex', model: 'reasoner', window: 200_000, effort: 'low' },
      source: 'catalog'
    });
    assert.deepEqual(choose(effort, { command: 'effort', value: 'unsupported' }), {
      kind: 'ignore'
    });
    assert.deepEqual(choose(effort, { command: 'back' }), { kind: 'discover', folder });
  });

  for (const efforts of [undefined, [{ value: 'low' }]])
    it(`skips the effort stage with ${efforts?.length ?? 0} native choices`, () => {
      const draft = models({
        models: {
          brands: [],
          models: [
            {
              brand: 'claude',
              model: 'simple',
              name: 'Simple',
              ...(efforts === undefined ? {} : { efforts, defaultEffort: 'low' })
            }
          ]
        },
        remoteSelection: { defaultTarget: {} }
      });
      assert.deepEqual(choose(draft, { command: 'model', index: 0 }), {
        kind: 'launch',
        source: 'catalog',
        target: {
          brand: 'claude',
          model: 'simple',
          ...(efforts === undefined ? {} : { effort: 'low' })
        }
      });
    });

  it('uses the captured default and preserves compatibility with an older receiving window', () => {
    assert.deepEqual(choose(models(), { command: 'default' }), {
      kind: 'launch',
      target: catalog.remoteSelection?.defaultTarget,
      source: 'catalog'
    });
    const accountDefault = models({
      models: catalog.models,
      remoteSelection: { defaultTarget: { model: 'account-only' } }
    });
    assert.deepEqual(choose(accountDefault, { command: 'default' }), {
      kind: 'launch',
      target: { model: 'account-only' },
      source: 'default'
    });
    const legacy = models({ models: catalog.models });
    assert.deepEqual(choose(legacy, { command: 'default' }), {
      kind: 'launch',
      target: {},
      source: undefined
    });
    assert.deepEqual(choose(legacy, { command: 'model', index: 0 }), { kind: 'ignore' });
  });

  it('refreshes after discovery failure, retaining Older but clearing stale catalog and target', () => {
    const model = { ...models(), older: true as const };
    const failed = picker.revise(model, { kind: 'catalog', result: { issue: 'offline' } });
    assert.deepEqual(choose(failed, { command: 'retry' }), { kind: 'discover', folder });
    assert.deepEqual(choose(failed, { command: 'default' }), { kind: 'ignore' });
    const refreshing = picker.revise(failed, { kind: 'discover', folder });
    assert.equal(refreshing.stage, 'model');
    assert.equal(refreshing.older, true);
    assert.equal(refreshing.catalog, undefined);
    assert.equal(refreshing.target, undefined);
    assert.equal(refreshing.issue, undefined);
    assert.equal(refreshing.generation, failed.generation + 1);
    assert.equal(refreshing.page, 0);
    assert.equal(refreshing.published, 0);
  });

  it('rejects stale generations, missing choices and model indices without changing the draft', () => {
    const draft = models();
    const before = structuredClone(draft);
    for (const action of [
      { generation: draft.generation - 1, choice: { command: 'cancel' as const } },
      { generation: draft.generation + 1, choice: { command: 'default' as const } },
      { choice: { command: 'default' as const } },
      { generation: draft.generation }
    ])
      assert.deepEqual(picker.choose(draft, action), { kind: 'ignore' });
    assert.deepEqual(choose(draft, { command: 'model', index: 20 }), { kind: 'ignore' });
    assert.deepEqual(choose(draft, { command: 'page' }), { kind: 'ignore' });
    assert.deepEqual(draft, before);
  });

  it('cancels before starting and expires at the deadline, including migrated folder drafts', () => {
    const draft = models();
    assert.deepEqual(choose(draft, { command: 'cancel' }), { kind: 'cancel' });
    assert.equal(picker.expired({ picker: draft, expiresAt: 100 }, 99), false);
    assert.equal(picker.expired({ picker: draft, expiresAt: 100 }, 100), true);
    assert.equal(picker.expired({ expiresAt: 100 }, 100), true);
    assert.equal(picker.expired(undefined, 100), false);
  });

  it('makes a starting draft inert through expiry, every choice and reload', () => {
    const draft = picker.revise(models(), {
      kind: 'start',
      target: catalog.remoteSelection?.defaultTarget ?? {},
      source: 'catalog'
    });
    assert.equal(picker.expired({ picker: draft, expiresAt: 100 }, 1000), false);
    for (const command of [
      'cancel',
      'default',
      'retry',
      'back',
      'model',
      'effort',
      'page',
      'older',
      'folder'
    ] as const)
      assert.deepEqual(choose(draft, { command, index: 0, value: 'low' }), { kind: 'ignore' });
    const recovered = picker.revise(draft, { kind: 'reload' });
    assert.equal(recovered.stage, 'starting');
    assert.equal(recovered.generation, draft.generation);
    assert.equal(recovered.issue, words.startUnknownAfterReload);
    assert.equal(picker.revise(recovered, { kind: 'reload' }), recovered);
    assert.equal(picker.revise(models(), { kind: 'reload' }).issue, undefined);
  });

  it('permits a new attempt only on positive evidence that no child started', () => {
    const draft = picker.revise(models(), { kind: 'start', target: {}, source: undefined });
    assert.deepEqual(picker.startRecovery(draft, { reason: 'invalid', outcome: 'stopped' }), {
      kind: 'retry',
      folder,
      reason: 'invalid'
    });
    const unknown = picker.startRecovery(draft, { reason: 'no reply', outcome: 'unknown' });
    assert.equal(unknown.kind, 'uncertain');
    assert.ok(unknown.kind === 'uncertain');
    assert.equal(unknown.draft.stage, 'starting');
    assert.equal(unknown.draft.generation, draft.generation);
    assert.equal(unknown.draft.issue, words.startUnknown('no reply'));
    assert.deepEqual(choose(unknown.draft, { command: 'retry' }), { kind: 'ignore' });
  });

  it('rejects a closed or replaced window and resets selection without keeping its catalog', () => {
    const draft = models();
    assert.equal(picker.folderAvailable(folder, [folder]), true);
    assert.equal(picker.folderAvailable(folder, []), false);
    assert.equal(picker.folderAvailable(folder, [{ ...folder, windowId: 'w2' }]), false);
    const reset = picker.revise({ ...draft, older: true }, { kind: 'reset' });
    assert.deepEqual(reset, {
      stage: 'folder',
      generation: draft.generation,
      page: 0,
      published: 0,
      destination
    });
    assert.deepEqual(choose(reset, { command: 'retry' }), { kind: 'ignore' });
  });

  it('revises paging and Older with new generations, clearing publication progress', () => {
    const draft = { ...models(), page: 4, published: 2 };
    const showing = choose(draft, { command: 'older' });
    assert.ok(showing.kind === 'advance');
    const shown = picker.revise(showing.draft, { kind: 'advance' });
    assert.equal(shown.older, true);
    assert.equal(shown.page, 0);
    assert.equal(shown.generation, draft.generation + 1);
    assert.equal(shown.published, 0);
    const hiding = choose(shown, { command: 'older' });
    assert.ok(hiding.kind === 'advance');
    assert.equal(hiding.draft.older, undefined);
    const page = choose(shown, { command: 'page', index: 1 });
    assert.ok(page.kind === 'advance');
    assert.equal(page.draft.page, 1);
  });

  it('keeps every model reachable within two buttons, with current rows before Older', () => {
    const listing: RemoteModels = {
      ...catalog,
      models: {
        brands: [],
        models: Array.from({ length: 12 }, (_, i) => ({
          brand: 'claude',
          model: `model-${i}`,
          name: `Model ${i}`,
          ...(i < 3 ? { legacy: true as const } : {})
        }))
      }
    };
    let draft = models(listing);
    const hidden = words.pickerPages(draft, [], 2).flatMap((p) => p.choices);
    assert.ok(hidden.some((c) => c.label === 'claude · Model 3'));
    assert.ok(!hidden.some((c) => c.label.includes('Older ·')));
    const current = models({
      ...catalog,
      models: { brands: [], models: [catalog.models.models[1]!] }
    });
    assert.ok(
      !words
        .pickerPages(current, [], 2)
        .flatMap((p) => p.choices)
        .some((c) => c.choice.command === 'older')
    );
    const show = choose(draft, { command: 'older' });
    assert.ok(show.kind === 'advance');
    draft = picker.revise(show.draft, { kind: 'advance' });
    const labels: string[] = [];
    for (let page = 0; page < 12; page++) {
      const pages = words.pickerPages(draft, [], 2);
      for (const rendered of pages) assert.ok(rendered.choices.length <= 2);
      const choices = pages.flatMap((p) => p.choices);
      for (const offered of choices.filter((c) => c.choice.command === 'model')) {
        labels.push(offered.label);
        const decision = choose(draft, offered.choice);
        assert.ok(decision.kind === 'launch');
        assert.equal(decision.target.model, `model-${offered.choice.index}`);
      }
      const next = choices.find((c) => c.label === 'Next');
      if (!next) break;
      const decision = choose(draft, next.choice);
      assert.ok(decision.kind === 'advance');
      draft = picker.revise(decision.draft, { kind: 'advance' });
    }
    assert.equal(new Set(labels).size, 12);
    assert.ok(labels.slice(0, 9).every((label) => !label.includes('Older')));
    assert.ok(labels.slice(9).every((label) => label.includes('Older')));
  });

  it('distinguishes a captured default without effort from an account-only default', () => {
    const target: LaunchTarget = { brand: 'claude', model: 'vintage' };
    assert.deepEqual(
      choose(models({ ...catalog, remoteSelection: { defaultTarget: target } }), {
        command: 'default'
      }),
      {
        kind: 'launch',
        target,
        source: 'catalog'
      }
    );
  });
});
