import { warmConfig } from '../core/cache_ttl';
import { resolveModel } from '../core/model_names';
import { DEFAULT_WARM_POLICY } from '../core/warm_policy';
import { chats } from './chat_state';
import type { Draft } from './chat_state';

type PanelStateBag = {
  ready: boolean;
  state: Omit<StateMessage, 'thread'>;
  boardView: 'sessions' | 'tickets';
  wantTheme: ThemeName | null;
  wantAsk: number | null;
  threadKeys: string[];
  cols: number;
};

export type PanelUi = {
  readonly ready: boolean;
  readonly state: Omit<StateMessage, 'thread'>;
  readonly selected: number | null;
  readonly draft: Readonly<Draft> | null;
  readonly boardView: 'sessions' | 'tickets';
  readonly wantTheme: ThemeName | null;
  readonly wantAsk: number | null;
  readonly threadKeys: readonly string[];
  readonly cols: number;
};

const initialState = (): Omit<StateMessage, 'thread'> => ({
  type: 'state',
  groups: [],
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
  models: []
});

const bag: PanelStateBag = {
  ready: false,
  state: initialState(),
  boardView: 'sessions',
  wantTheme: null,
  wantAsk: null,
  threadKeys: [],
  cols: 2
};

export const ui: PanelUi = {
  get ready(): boolean {
    return bag.ready;
  },
  get state(): Omit<StateMessage, 'thread'> {
    return bag.state;
  },
  get selected(): number | null {
    return chats.selected();
  },
  get draft(): Readonly<Draft> | null {
    return chats.activeDraft();
  },
  get boardView(): 'sessions' | 'tickets' {
    return bag.boardView;
  },
  get wantTheme(): ThemeName | null {
    return bag.wantTheme;
  },
  get wantAsk(): number | null {
    return bag.wantAsk;
  },
  get threadKeys(): readonly string[] {
    return bag.threadKeys;
  },
  get cols(): number {
    return bag.cols;
  }
};

export function applyState(msg: StateMessage): import('./chat_state').SessionIdentity[] {
  const retired = chats.observe(msg);
  bag.state = msg;
  bag.ready = true;
  return retired;
}

export function acceptEnds(sessions: readonly { pid: number; startedAt: number }[]): void {
  for (const group of bag.state.groups) {
    for (const card of group.sessions) {
      if (!sessions.some(({ pid, startedAt }) => card.pid === pid && card.startedAt === startedAt))
        continue;
      card.closing = true;
      delete card.endStuck;
      delete card.endFailure;
    }
  }
}

export function setBoardView(view: 'sessions' | 'tickets'): void {
  bag.boardView = view;
}

export function setWantTheme(theme: ThemeName | null): void {
  bag.wantTheme = theme;
}

export function clearWantThemeIf(echo: ThemeName): void {
  if (bag.wantTheme === echo) bag.wantTheme = null;
}

export function setWantAsk(pid: number | null): void {
  bag.wantAsk = pid;
}

export function clearWantAskIf(pid: number): void {
  if (bag.wantAsk === pid) bag.wantAsk = null;
}

export function setCols(n: number): void {
  bag.cols = n;
}

export function setThreadKeys(keys: string[]): void {
  bag.threadKeys = keys;
}

export function clearThreadKeys(): void {
  bag.threadKeys = [];
}

export function modelInForce(session: CardView): string | undefined {
  const held = chats.session(session.pid)?.target;
  if (held?.model) return held.model;
  return (
    resolveModel(bag.state.models, session.model, session.modelPick)?.value ??
    session.model ??
    session.modelPick
  );
}

export function panelDrives(pid: number | null): boolean {
  if (pid === null) return false;
  return (
    bag.state.groups.some((group) =>
      group.sessions.some((session) => session.pid === pid && session.owned === true)
    ) || chats.session(pid)?.thread?.owned === true
  );
}

export function resetBagForTests(): void {
  chats.reset();
  bag.state = initialState();
  bag.boardView = 'sessions';
  bag.wantTheme = null;
  bag.wantAsk = null;
  bag.threadKeys = [];
  bag.cols = 2;
}
