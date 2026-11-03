import { cardView, groupView, stateMessage } from './harness';

/**
 * The board the mascot's cost is measured on (`docs/reference/mascot_performance.md`),
 * shared by the Chrome rig (`scripts/mascot_cost.mjs`) and the stock VS Code
 * reading (`smoke/mascot_cost.smoke.ts`), so both drive the same minute.
 *
 * Eight cards, all idle at rest. The busy minute is PRD §3's: a storm at 0 s
 * (six turns finish and a dialog opens, in one push), then one fact every
 * 12 s — a new card, a finished turn, a dialog, everything idle. The director
 * turns that into four flights and poses the rest.
 */

const PIDS = [901, 902, 903, 904, 905, 906, 907, 908];
const DONE = { word: 'done', tally: 'done' } as unknown as CardReading;

type Over = Partial<CardView>;

function board(
  mascot: boolean,
  cards: Record<number, Over> = {},
  extra: number[] = []
): StateMessage {
  const sessions = [...PIDS, ...extra].map((pid, i) =>
    cardView({ pid, name: `Session ${i + 1}`, status: 'busy', ...cards[pid] })
  );
  // A machine reading, or the nav bar's loading animation runs for ever and every
  // condition measures it rather than the chick.
  return stateMessage([groupView({ sessions })], {
    mascot,
    machine: { cpu: 4, memory: { used: 8e9, total: 24e9 } }
  });
}

/** The board at rest, with the chick on or off: every card idle, since a busy
 *  card runs CSS animations of its own that would bury what is measured. */
export function restState(mascot: boolean): StateMessage {
  return board(mascot, Object.fromEntries(PIDS.map((pid): [number, Over] => [pid, idle])));
}

const idle: Over = { status: 'idle' };
const finished: Over = { status: 'idle', unread: DONE };

/** The busy minute: each push and the second it lands at. */
export function busyMinute(): { at: number; state: StateMessage }[] {
  const storm: Record<number, Over> = {
    901: finished,
    902: finished,
    903: finished,
    904: finished,
    905: finished,
    906: finished,
    907: { status: 'waiting' }
  };
  const quiet: Record<number, Over> = Object.fromEntries(
    [...PIDS, 909].map((pid): [number, Over] => [pid, { status: 'idle' }])
  );
  return [
    { at: 0, state: board(true, storm) },
    { at: 12, state: board(true, { ...storm, 907: { status: 'busy' } }, [909]) },
    { at: 24, state: board(true, { ...storm, 907: { status: 'busy' }, 908: finished }, [909]) },
    {
      at: 36,
      state: board(
        true,
        { ...storm, 907: { status: 'busy' }, 908: finished, 909: { status: 'waiting' } },
        [909]
      )
    },
    { at: 48, state: board(true, quiet, [909]) }
  ];
}
