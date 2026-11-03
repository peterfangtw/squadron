import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { before, beforeEach, describe, it } from 'node:test';
import * as helpers from '../helpers';
import type { ModelListing } from '../../core/model_listing';
import type { Reply } from '../../core/coordination/requests';

let home: string;
let cli: typeof import('../../cli/models');
let listing: typeof import('../../core/model_listing');
let requests: typeof import('../../core/coordination/requests');
let codex: typeof import('../../core/codex/models');

before(async () => {
  home = await helpers.tempHome();
  cli = await import('../../cli/models');
  listing = await import('../../core/model_listing');
  requests = await import('../../core/coordination/requests');
  codex = await import('../../core/codex/models');
});

beforeEach(async () => {
  codex.resetCodexModelsForTest();
  await fs.rm(path.join(home, '.squadron'), { recursive: true, force: true });
});

describe('model discovery', () => {
  it('carries native efforts and validates the saved preference against them', async () => {
    await codex.refreshCodexModels({
      request: () =>
        Promise.resolve({
          data: [
            {
              id: 'reasoner',
              model: 'gpt-reasoner',
              displayName: 'Reasoner',
              hidden: false,
              isDefault: true,
              defaultReasoningEffort: 'medium',
              inputModalities: ['text'],
              supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: 'Fast' },
                { reasoningEffort: 'medium', description: 'Balanced' }
              ]
            }
          ]
        }),
      notify: () => {},
      onNotification: () => () => {}
    });
    const make = listing.modelListing;
    const row = make([{ brand: 'codex' }], { 'gpt-reasoner': 'low' }).models[0];
    assert.ok(row);
    assert.deepEqual(row.efforts, [
      { value: 'medium', description: 'Balanced' },
      { value: 'low', description: 'Fast' }
    ]);
    assert.equal(row.defaultEffort, 'medium');
    assert.equal(row.preferredEffort, 'low');
    const invalid = make([{ brand: 'codex' }], { 'gpt-reasoner': 'invented' }).models[0];
    assert.ok(invalid);
    assert.equal(invalid.preferredEffort, 'medium');
  });
  it('rejects unknown brands and malformed flags before looking for a host', () => {
    assert.deepEqual(cli.parseArgs([]), {});
    assert.deepEqual(cli.parseArgs(['--brand', 'codex']), { brand: 'codex' });
    for (const argv of [['--brand'], ['--brand', ''], ['--brand', 'other'], ['--model', 'x']]) {
      assert.equal(cli.parseArgs(argv), undefined);
    }
  });

  it('keeps unknown availability distinct from a known negative and preserves context gates', () => {
    const result = listing.modelListing([
      { brand: 'claude' },
      { brand: 'grok', installed: false, signedIn: true },
      { brand: 'codex', installed: true, signedIn: false }
    ]);
    assert.deepEqual(result.brands[0], {
      brand: 'claude',
      installed: null,
      signedIn: null,
      source: 'maintained'
    });
    assert.ok(result.models.length > 0);
    assert.ok(result.models.every((row) => row.brand === 'claude'));
    assert.deepEqual(
      result.models.filter((row) => row.model === 'claude-opus-5').map((row) => row.context),
      [1_000_000, 200_000]
    );
    assert.equal(
      result.models.find((row) => row.model === 'claude-sonnet-4-6' && row.context === 1_000_000)
        ?.gated,
      true
    );
    assert.ok(result.models.every((row) => !row.model.includes('[1m]')));
  });

  it('lists only account-reported Codex IDs, including new IDs without invented contexts', async () => {
    assert.deepEqual(listing.modelListing([{ brand: 'codex' }]).models, []);
    await codex.refreshCodexModels({
      request: () =>
        Promise.resolve({
          data: [
            {
              id: 'display-id',
              model: 'gpt-future',
              displayName: 'Future',
              hidden: false,
              isDefault: true,
              defaultReasoningEffort: 'medium',
              inputModalities: ['text'],
              supportedReasoningEfforts: []
            }
          ]
        }),
      notify: () => {},
      onNotification: () => () => {}
    });
    const result = listing.modelListing([{ brand: 'codex', installed: true, signedIn: true }]);
    assert.equal(result.brands[0]?.source, 'account');
    assert.deepEqual(result.models, [{ brand: 'codex', model: 'gpt-future', name: 'Future' }]);
    assert.deepEqual(listing.modelListing([{ brand: 'codex', signedIn: false }]).models, []);
  });
});

function run(
  argv: string[] = []
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(
      process.execPath,
      [path.join(helpers.repoRoot(), 'dist/squadron-models.js'), ...argv],
      {
        cwd: home,
        env: { ...process.env, ...helpers.homeEnv(home), SQUADRON_ORIGIN_WINDOW: 'origin' }
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function answer(reply: Reply, argv: string[] = []): ReturnType<typeof run> {
  for (const id of ['other', 'origin']) {
    await helpers.writeJson(path.join(home, '.squadron/windows', `${id}.json`), {
      id,
      label: id,
      app: 'IDE',
      shellPids: [],
      updatedAt: Date.now(),
      folder: id === 'other' ? home : path.join(home, 'elsewhere')
    });
  }
  const running = run(argv);
  let handled = false;
  const until = Date.now() + 5_000;
  while (!handled && Date.now() < until) {
    await requests.claimRequests('other', () => {
      assert.fail('ignored the spawn origin');
    });
    await requests.claimRequests('origin', (request) => {
      assert.equal(request.kind, 'models');
      handled = true;
      return reply;
    });
    if (!handled) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(handled, 'the CLI must post a model request');
  return running;
}

describe('bundled squadron-models', () => {
  it('uses usage exit 1 and no-window exit 3', async () => {
    assert.equal((await run(['--brand', 'wrong'])).code, 1);
    const result = await run();
    assert.equal(result.code, 3);
    assert.equal(result.stdout, '');
  });

  it('routes like spawn and filters both availability and choices', async () => {
    const models = listing.modelListing([{ brand: 'claude' }, { brand: 'grok' }]);
    const result = await answer({ ok: true, models }, ['--brand', 'grok']);
    assert.equal(result.code, 0, result.stderr);
    const printed = JSON.parse(result.stdout) as ModelListing & { window: { id: string } };
    assert.equal(printed.window.id, 'origin');
    assert.equal(printed.brands.length, 1);
    assert.equal(printed.brands[0]?.brand, 'grok');
    assert.ok(printed.models.length > 0);
    assert.ok(printed.models.every((row) => row.brand === 'grok'));
  });

  it('prints an empty catalog successfully but does not disguise missing support as empty', async () => {
    const empty = await answer({ ok: true, models: { brands: [], models: [] } });
    assert.equal(empty.code, 0, empty.stderr);
    const missing = await answer({ ok: true });
    assert.equal(missing.code, 5);
    assert.match(missing.stderr, /update Squadron and reload/);
    assert.equal(missing.stdout, '');
  });

  it('reports the refusal from an older host as missing model support', async () => {
    // Before models existed, serve() fell through to ownedSession(undefined).
    const result = await answer({ ok: false, reason: 'This window does not drive that session.' });
    assert.equal(result.code, 5);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /does not support model discovery; update Squadron and reload/);
  });

  it('reports a host refusal separately', async () => {
    const result = await answer({ ok: false, reason: 'unsupported request' });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unsupported request/);
  });

  it('rejects malformed rows before filtering or printing a successful catalog', async () => {
    const brand = { brand: 'claude', installed: true, signedIn: null, source: 'maintained' };
    const model = { brand: 'claude', model: 'claude-opus-5', name: 'Opus 5', context: 200_000 };
    const malformed = [
      { brands: [null], models: [{}] },
      { brands: [{ ...brand, source: 'guessed' }], models: [] },
      { brands: [{ ...brand, signedIn: 'yes' }], models: [] },
      { brands: [{ ...brand, installed: undefined }], models: [] },
      { brands: [brand], models: [{ ...model, model: '' }] },
      { brands: [brand], models: [{ ...model, brand: 'unknown' }] },
      { brands: [brand], models: [{ ...model, name: null }] },
      { brands: [brand], models: [{ ...model, context: -1 }] },
      { brands: [brand], models: [{ ...model, gated: 'yes' }] },
      { brands: [brand], models: [{ ...model, legacy: false }] }
    ];
    for (const models of malformed) {
      for (const argv of [[], ['--brand', 'grok']]) {
        const result = await answer({ ok: true, models } as unknown as Reply, argv);
        assert.equal(result.code, 5, JSON.stringify({ models, argv, result }));
        assert.equal(result.stdout, '');
      }
    }
  });
});

describe('remote launch target validation', () => {
  it('uses captured defaults without reading settings, and validates every catalog dimension', () => {
    const resolve = listing.remoteTarget;
    const models: ModelListing = {
      brands: [],
      models: [
        {
          brand: 'claude',
          model: 'opus',
          name: 'Opus',
          context: 200_000,
          efforts: [{ value: 'high' }, { value: 'low' }],
          defaultEffort: 'high'
        }
      ]
    };
    const fallback = () => {
      throw new Error('must not reread defaults');
    };
    assert.deepEqual(resolve({ cwd: '/work', selection: 'default' }, models, fallback), {
      ok: true,
      target: {}
    });
    assert.deepEqual(
      resolve({ cwd: '/work', selection: 'default', model: 'typed-model' }, models, fallback),
      { ok: true, target: { model: 'typed-model' } }
    );
    const selected = {
      cwd: '/work',
      selection: 'catalog' as const,
      brand: 'claude' as const,
      model: 'opus',
      window: 200_000,
      effort: 'low'
    };
    assert.equal(resolve(selected, models, fallback).ok, true);
    for (const changed of [
      { brand: 'codex' as const },
      { model: 'unknown' },
      { window: 1_000_000 },
      { effort: 'invented' }
    ]) {
      assert.equal(resolve({ ...selected, ...changed }, models, fallback).ok, false);
    }
    assert.equal(resolve(selected, { brands: [], models: [] }, fallback).ok, false);
    assert.deepEqual(
      resolve({ cwd: '/work' }, models, () => ({ model: 'old-default' })),
      { ok: true, target: { model: 'old-default' } }
    );
  });
});

describe('model listing effort data', () => {
  it('rejects orphaned or malformed native effort defaults at read boundaries', () => {
    const row = { brand: 'claude', model: 'opus', name: 'Opus' };
    for (const fields of [
      { defaultEffort: 5 },
      { preferredEffort: 'low' },
      { efforts: [] },
      { efforts: [{ value: '' }], defaultEffort: '' },
      { efforts: [{ value: 'low' }], defaultEffort: 'invented' },
      { efforts: [{ value: 'low' }], defaultEffort: 'low', preferredEffort: 'invented' }
    ]) {
      assert.equal(listing.isModelListing({ brands: [], models: [{ ...row, ...fields }] }), false);
    }
  });
});
