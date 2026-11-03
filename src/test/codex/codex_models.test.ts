import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  codexAcceptsImages,
  codexEffort,
  codexModels,
  modelPage,
  noteCodexModelAccount,
  refreshCodexModels,
  resetCodexModelsForTest
} from '../../core/codex/models';
import type { CodexRpc } from '../../core/codex/runtime';

class FakeRpc implements CodexRpc {
  readonly calls: { method: string; params?: unknown }[] = [];
  private notifications = new Set<(method: string, params: unknown) => void>();

  constructor(private readonly answer: (method: string, params?: unknown) => unknown) {}

  request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, ...(params === undefined ? {} : { params }) });
    try {
      return Promise.resolve(this.answer(method, params));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  notify(): void {}

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  emit(method: string, params: unknown): void {
    for (const listener of this.notifications) listener(method, params);
  }
}

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(`src/test/fixtures/codex-app-server-0.151.0/${name}`, 'utf8')
  ) as unknown;
}

const model = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  model: id,
  displayName: id.toUpperCase(),
  hidden: false,
  isDefault: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'fixture' }],
  defaultReasoningEffort: 'medium',
  inputModalities: ['text', 'image'],
  ...over
});

describe('Codex model catalog', () => {
  it('prefers catalog names and falls back to live names, then ids, for unknown models', () => {
    const rows = modelPage({
      data: [
        model('gpt-6.1-sol'),
        model('gpt-6-astra'),
        model('gpt-6-luna'),
        model('gpt-future', { displayName: '  Future model  ' }),
        model('gpt-unnamed', { displayName: '  ' })
      ]
    })?.models;
    assert.deepEqual(
      rows?.map((row) => [row.value, row.name]),
      [
        ['gpt-6.1-sol', 'Sol 6.1'],
        ['gpt-6-astra', 'Astra 6'],
        ['gpt-6-luna', 'Luna 6'],
        ['gpt-future', 'Future model'],
        ['gpt-unnamed', 'gpt-unnamed']
      ]
    );
  });

  it('defaults Astra and GPT-6.1 Sol to medium, and nothing else', () => {
    const rows = modelPage({
      data: [
        model('gpt-6.1-sol', { defaultReasoningEffort: 'high' }),
        model('gpt-6-astra', { defaultReasoningEffort: 'high' }),
        model('gpt-6-sol'),
        model('gpt-6-luna'),
        model('gpt-5.6-sol')
      ]
    })?.models;
    assert.deepEqual(
      rows?.map((row) => [row.value, row.defaultEffort]),
      [
        ['gpt-6.1-sol', 'medium'],
        ['gpt-6-astra', 'medium'],
        ['gpt-6-sol', 'medium'],
        ['gpt-6-luna', 'medium'],
        ['gpt-5.6-sol', 'medium']
      ]
    );
  });

  it('parses every visible fixture page and retains effort/modality facts', () => {
    const raw = fixture('c5_models.json') as {
      current: { visiblePages: unknown[] };
    };
    const rows = raw.current.visiblePages.flatMap((page) => modelPage(page)?.models ?? []);
    assert.equal(rows.length, 7);
    assert.equal(rows[0]?.value, 'gpt-5.6-sol');
    // Reversed out of the fixture's weakest-first order: strongest on top.
    assert.deepEqual(rows[0]?.efforts, [
      { value: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
      { value: 'max', description: 'Maximum reasoning depth for the hardest problems' },
      { value: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
      { value: 'high', description: 'Greater reasoning depth for complex problems' },
      {
        value: 'medium',
        description: 'Balances speed and reasoning depth for everyday tasks'
      },
      { value: 'low', description: 'Fast responses with lighter reasoning' }
    ]);
    assert.deepEqual(rows[0]?.modalities, ['text', 'image']);
    assert.deepEqual(
      rows.map((row) => [row.value, row.window]),
      [
        ['gpt-5.6-sol', 258_400],
        ['gpt-5.6-terra', 258_400],
        ['gpt-5.6-luna', 258_400],
        ['gpt-5.5', 258_400],
        ['gpt-5.4', 258_400],
        ['gpt-5.4-mini', 258_400],
        ['gpt-5.3-codex-spark', 121_600]
      ]
    );
  });

  /**
   * The half of `catalog.test.ts`'s effort invariant that cannot reach this
   * brand: no `CODEX_MODELS` row authors efforts, so a Codex row's default is
   * only ever the account's — or, for two ids, the `medium` `modelPage` stamps
   * over it. An override naming a value that row does not offer would reach the
   * menu as a default nothing in it can be, which is what this catches.
   */
  it('gives every live row a default among the efforts it offers', () => {
    const raw = fixture('c5_models.json') as { current: { visiblePages: unknown[] } };
    const rows = raw.current.visiblePages.flatMap((page) => modelPage(page)?.models ?? []);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.ok(
        row.efforts?.some((effort) => effort.value === row.defaultEffort),
        `${row.value} defaults to ${row.defaultEffort}, which it does not offer`
      );
    }
  });

  it('keeps a new live model without inventing a context window', () => {
    assert.equal(modelPage({ data: [model('gpt-future')] })?.models[0]?.window, undefined);
  });

  it('pages opaque cursors and keeps the last good catalog on a repeated cursor', async () => {
    resetCodexModelsForTest();
    noteCodexModelAccount('in:first');
    const good = new FakeRpc((_method, params) => {
      const cursor = (params as { cursor?: string }).cursor;
      return cursor
        ? { data: [model('m2')], nextCursor: undefined }
        : { data: [model('m1')], nextCursor: 'opaque' };
    });
    assert.equal(await refreshCodexModels(good), true);
    assert.deepEqual(
      codexModels().map((row) => row.value),
      ['m1', 'm2']
    );

    const repeated = new FakeRpc(() => ({ data: [], nextCursor: 'same' }));
    assert.equal(await refreshCodexModels(repeated), false);
    assert.deepEqual(
      codexModels().map((row) => row.value),
      ['m1', 'm2']
    );

    noteCodexModelAccount('in:second');
    assert.deepEqual(codexModels(), []);
  });

  it('ranks live known models by the maintained catalog', async () => {
    resetCodexModelsForTest();
    noteCodexModelAccount('in:first');
    const rpc = new FakeRpc(() => ({
      data: [model('gpt-5.6-sol'), model('gpt-future'), model('gpt-6-astra')]
    }));
    assert.equal(await refreshCodexModels(rpc), true);
    assert.deepEqual(
      codexModels().map((row) => row.value),
      ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-future']
    );
  });

  it('rejects malformed visibility/default facts as a whole page', () => {
    assert.equal(modelPage({ data: [model('missing-hidden', { hidden: undefined })] }), undefined);
    assert.equal(
      modelPage({ data: [model('missing-default', { isDefault: undefined })] }),
      undefined
    );
    assert.equal(
      modelPage({
        data: [
          model('bad-effort-description', {
            supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 42 }]
          })
        ]
      }),
      undefined
    );
  });

  it('does not let an older account refresh overwrite a newer account', async () => {
    resetCodexModelsForTest();
    let finishFirst: (value: unknown) => void = () => undefined;
    const first = new FakeRpc(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        })
    );
    noteCodexModelAccount('in:first');
    const stale = refreshCodexModels(first);

    noteCodexModelAccount('in:second');
    const second = new FakeRpc(() => ({ data: [model('second')] }));
    assert.equal(await refreshCodexModels(second), true);
    finishFirst({ data: [model('first')] });
    assert.equal(await stale, false);
    assert.deepEqual(
      codexModels().map((row) => row.value),
      ['second']
    );
  });

  it('uses known model effort and modality facts without guessing on a cold cache', async () => {
    resetCodexModelsForTest();
    assert.equal(codexAcceptsImages('unknown'), true);
    assert.equal(codexEffort('unknown', 'ultra'), 'ultra');
    const rpc = new FakeRpc(() => ({
      data: [
        model('text-only', {
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'fixture' }],
          defaultReasoningEffort: 'high',
          inputModalities: ['text']
        })
      ]
    }));
    assert.equal(await refreshCodexModels(rpc), true);
    assert.equal(codexAcceptsImages('text-only'), false);
    assert.equal(codexAcceptsImages(undefined), false);
    assert.equal(codexEffort('text-only', 'medium'), undefined);
    assert.equal(codexEffort('text-only', 'high'), 'high');
  });
});
