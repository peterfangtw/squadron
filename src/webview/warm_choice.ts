import * as holds from './holds';
import * as warmRows from '../ui/warm_rows';
import { ui, vscode } from './state';

type Session = { pid: number; startedAt: number };

/** One pending preference shared by the card and the Warm switches. */
const choices = holds.add<string, boolean>(
  (id) =>
    ui.state.groups.flatMap((group) => group.sessions).find((card) => key(card) === id)?.warm?.on
);

export function key(session: Session): string {
  return `warm:${session.pid}:${session.startedAt}`;
}

export function shown(card: CardView): boolean {
  return choices.shown(key(card), card.warm?.on ?? false);
}

export function set(session: Session, on: boolean): void {
  const card = ui.state.groups
    .flatMap((group) => group.sessions)
    .find((candidate) => key(candidate) === key(session));
  if (!card?.canControl || !warmRows.warmable(card.warm)) return;
  choices.hold(key(card), on);
  vscode.postMessage({ type: 'setWarm', pid: card.pid, startedAt: card.startedAt, on });
}

export function settle(msg: Session & { on?: boolean }): void {
  if (msg.on === undefined) choices.drop(key(msg));
}
