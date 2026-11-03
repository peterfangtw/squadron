import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { modeBitsSkip, repoRoot, tempHome } from '../helpers';

type Choices = typeof import('../../core/warm_choice');
let home: string;
let choices: Choices;
const dir = () => path.join(home, '.squadron', 'warm');

before(async () => {
  home = await tempHome();
  choices = await import('../../core/warm_choice');
});

async function reset(): Promise<void> {
  await fs.rm(dir(), { recursive: true, force: true });
}

async function put(file: string, record: unknown): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(
    path.join(dir(), file),
    typeof record === 'string' ? record : JSON.stringify(record)
  );
}

describe('conversation warm choices', () => {
  it('uses the default only when no choice was stated, including explicit off', async () => {
    await reset();
    const empty = await choices.readWarmChoices();
    assert.equal(choices.effectiveWarm(empty.get('grok\0same'), false), false);
    assert.equal(choices.effectiveWarm(empty.get('grok\0same'), true), true);
    assert.equal(await choices.writeWarmChoice('grok', 'same', false, 1700), true);
    assert.equal(await choices.writeWarmChoice('claude', 'same', true, 1800), true);
    const back = await choices.readWarmChoices();
    assert.deepEqual(back.get('grok\0same'), {
      schema: 1,
      brand: 'grok',
      sessionId: 'same',
      on: false,
      statedAt: 1700
    });
    assert.equal(choices.effectiveWarm(back.get('grok\0same'), true), false);
    assert.equal(choices.effectiveWarm(back.get('claude\0same'), false), true);
    assert.deepEqual((await fs.readdir(dir())).sort(), ['claude.same.json', 'grok.same.json']);
  });

  it('overwrites one choice without losing another conversation', async () => {
    await reset();
    await choices.writeWarmChoice('codex', 'one', true, 1);
    await choices.writeWarmChoice('codex', 'two', true, 2);
    await choices.writeWarmChoice('codex', 'one', false, 3);
    const back = await choices.readWarmChoices();
    assert.equal(back.get('codex\0one')?.on, false);
    assert.equal(back.get('codex\0one')?.statedAt, 3);
    assert.equal(back.get('codex\0two')?.on, true);
  });

  it('skips malformed, foreign, future and mismatched records', async () => {
    await reset();
    const record = { schema: 1, brand: 'claude', sessionId: 'bad', on: false, statedAt: 2 };
    for (const [file, raw] of Object.entries({
      'half.json': '{',
      'claude.old.json': { ...record, sessionId: 'old', schema: 0 },
      'claude.future.json': { ...record, sessionId: 'future', schema: 2 },
      'claude.bad.json': { ...record, on: 'false' },
      'claude.mismatch.json': record,
      'other.bad.json': { ...record, brand: 'other' },
      'claude.nan.json': { ...record, sessionId: 'nan', statedAt: null },
      'claude.empty.json': { ...record, sessionId: '' }
    }))
      await put(file, raw);
    assert.equal((await choices.readWarmChoices()).size, 0);
  });

  it('refuses unsafe conversation keys without writing outside its store', async () => {
    await reset();
    assert.equal(await choices.writeWarmChoice('claude', '../elsewhere', true, 1), false);
    assert.equal(await choices.writeWarmChoice('claude', '', true, 1), false);
    assert.equal(await choices.writeWarmChoice('claude', 'sid', true, NaN), false);
    assert.equal((await choices.readWarmChoices()).size, 0);
  });

  it('reports a failed write and retains the previous choice', { skip: modeBitsSkip }, async () => {
    await reset();
    await choices.writeWarmChoice('claude', 'sid', false, 1);
    await fs.chmod(dir(), 0o500);
    try {
      assert.equal(await choices.writeWarmChoice('claude', 'sid', true, 2), false);
      assert.equal((await choices.readWarmChoices()).get('claude\0sid')?.on, false);
    } finally {
      await fs.chmod(dir(), 0o700);
    }
  });
});

it('declares the experimental application default off', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(repoRoot(), 'package.json'), 'utf8'));
  const setting = manifest.contributes.configuration.properties['squadron.warmCache.enabled'];
  assert.equal(setting.type, 'boolean');
  assert.equal(setting.default, false);
  assert.equal(setting.scope, 'application');
  const description: unknown = setting.markdownDescription;
  assert.ok(typeof description === 'string');
  assert.match(description, /^\*\*Experimental\.\*\*/);
});
