import * as assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { warmConfig } from '../../core/cache_ttl';
import { DEFAULT_WARM_POLICY } from '../../core/warm_policy';
import {
  applyState,
  clearWantThemeIf,
  modelInForce,
  panelDrives,
  resetBagForTests,
  setWantTheme,
  ui
} from '../../ui/panel_bag';
import { chats } from '../../ui/chat_state';

afterEach(resetBagForTests);

const card = (pid: number, over: Partial<CardView> = {}): CardView => ({
  pid,
  name: 'session',
  fullCwd: '/proj',
  status: 'idle',
  reading: { word: 'idle', tally: 'idle' },
  canControl: true,
  startedAt: pid * 1000,
  updatedAt: 0,
  cacheTtlMs: 60 * 60_000,
  ...over
});

const thread = (pid: number, over: Partial<ThreadView> = {}): ThreadView => ({
  ...card(pid),
  owned: true,
  exchanges: [],
  canSend: true,
  canAttach: true,
  who: 'claude',
  ...over
});

const push = (sessions: CardView[], selected?: ThreadView, models: ModelView[] = []): void => {
  void applyState({
    type: 'state',
    groups: [{ label: 'proj', app: 'VS Code', cwd: '/proj', sessions }],
    cafe: false,
    cafeRemote: false,
    cafeWarm: false,
    warmOn: false,
    orchestrators: false,
    skipPermissions: false,
    executionCapture: false,
    soundLevel: 'off',
    devServers: false,
    mascot: false,
    warmCache: false,
    warmConfig: warmConfig(DEFAULT_WARM_POLICY),
    theme: 'follow',
    model: '',
    efforts: {},
    models,
    ...(selected ? { thread: selected } : {})
  });
};

describe('panel bag', () => {
  it('keeps host thread data out of the panel-wide state', () => {
    push([card(1)], thread(1));
    assert.equal('thread' in ui.state, false);
    assert.equal(chats.session(1)?.thread?.pid, 1);
  });

  it('answers whether this panel can drive a session from cards or its owned thread', () => {
    push([card(1, { owned: true })]);
    assert.equal(panelDrives(1), true);
    assert.equal(panelDrives(2), false);
    push([], thread(2));
    assert.equal(panelDrives(2), true);
  });

  it('resolves the model in force and lets a chat-owned target lead', () => {
    const models: ModelView[] = [
      { value: 'opus', name: 'Opus', id: 'claude-opus-5', brand: 'claude' },
      { value: 'haiku', name: 'Haiku', id: 'claude-haiku-4-5', brand: 'claude' }
    ];
    const session = card(1, { model: 'claude-opus-5' });
    push([session], undefined, models);
    assert.equal(modelInForce(session), 'opus');
    chats.chooseTarget(1, { model: 'haiku' });
    assert.equal(modelInForce(session), 'haiku');
  });

  it('holds a local theme choice until the host echoes it', () => {
    setWantTheme('paper');
    clearWantThemeIf('ink');
    assert.equal(ui.wantTheme, 'paper');
    clearWantThemeIf('paper');
    assert.equal(ui.wantTheme, null);
  });
});
