import { $ } from './dom';

export { chats } from '../ui/chat_state';
export {
  ui,
  applyState,
  acceptEnds,
  setBoardView,
  setWantTheme,
  clearWantThemeIf,
  setWantAsk,
  clearWantAskIf,
  setAlertExpanded,
  setCols,
  setThreadKeys,
  clearThreadKeys,
  modelInForce,
  panelDrives
} from '../ui/panel_bag';

export const vscode = acquireVsCodeApi();

export const cards = $('cards');
export const nav = $('nav');
export const alertBar = $('alert');
export const dock = $('dock');
export const thread = $('thread');
export const promptBar = $('prompt-bar');
/** The composer's host: `composer.ts` mounts the prose editor in it. */
export const input = $('input');
export const question = $('question');
export const ask = $('ask');
export const scrim = $('scrim');
export const qlaunch = $('qlaunch');
export const sessionsHead = $('sessions-head');
export const chatBody = $('chat');
export const ticketsHead = $('tk-head');
export const ticketsList = $('tk-list');
export const saved: PanelState = vscode.getState() ?? {};

export const ALERT_CAP = 8;

/** Image bytes are immutable and content-addressed by transcript ref. */
export const opened = new Set<string>();
export const fetched = new Map<string, { dataUrl?: string; reason?: 'gone' | 'tooLarge' }>();
