/**
 * The permission half of the dock's pending list: one dialog per tool call an
 * owned session is waiting to be allowed to make.
 *
 * It sits beside the ask dialog rather than under a surface of its own, because
 * the two arrive as the same `can_use_tool` request and a session blocked on
 * either is blocked in exactly the same way. What differs is the shape of the
 * answer: an ask is picked from, and this one is allowed, allowed always, or
 * denied.
 *
 * No decision here is staged. A pick can be reconsidered before the CTA carries
 * it, but each of these three buttons *is* the decision — there is no second
 * step to hold one at, and a permission prompt with an amber intermediate state
 * would be a control that looks answered while the session is still blocked.
 * The deny's reason box is disclosed rather than open, and what is typed into it
 * is kept across a repaint, but neither makes it a staged decision: the button
 * inside the drawer decides exactly as the two beside it do.
 */

import { el } from './dom';
import { bailBox, type Holder } from './boxes';
import { awaiting } from './kit';

/** Which of the three was pressed. Named because the caller keeps it — see
 *  `sending` in `question.ts` — and hands it back as `sent` on the next paint. */
export type PermissionAt = 'allow' | 'always' | 'deny';

/**
 * The dialog, and the one thing it does: hand a decision back, saying which
 * button it was made on. `bail` is the reason box's own state — whether it is
 * open and what is in it — which lives with the caller's staged state so a
 * repaint cannot shut it (`question.ts`).
 *
 * `sent` is that same state one paint later: the decision is on the pipe and
 * the push that takes this dialog away has not landed, so every button here is
 * dead and the one that was pressed says so. Nothing about it is staging — the
 * decision was made and cannot be taken back; this is only the panel admitting
 * it is still travelling.
 */
export function permissionDialog(
  view: Extract<PendingRequestView, { kind: 'permission' }>,
  decide: (decision: RequestDecision, at: PermissionAt) => void,
  bail: {
    open: boolean;
    text: string;
    key: string;
    /** Who keeps the reason box across paints (`boxes.ts`' `heldBox`). */
    hold: Holder;
    onOpen: (open: boolean) => void;
    onType: (text: string) => void;
  },
  sent?: string
): HTMLElement {
  const dlg = el('div', 'pdlg');

  // The tool's name and the CLI's own description of the call. The description
  // is never composed here — `notes.txt`, `Write hi to out.txt` — because the
  // CLI is the thing that knows what the call is for.
  const head = el('div', 'phead');
  head.append(el('span', 'ptool', view.toolName), el('span', 'plabel', view.label));
  dlg.append(head);

  // As text, always: this is a model's own output, and the one place the panel
  // shows it is the place a reader decides whether to run it.
  if (view.input) {
    dlg.append(el('pre', 'pin', view.input));
  }

  const row = el('div', 'prow');
  const allow = el('button', 'pallow', 'Allow once') as HTMLButtonElement;
  allow.onclick = () => decide({ allow: true }, 'allow');
  awaiting(allow, sent, 'allow');
  row.append(allow);

  // Only when the request suggested a rule. There is no standalone permissions
  // control request, so a rule can ride only on an allow, and its syntax is the
  // CLI's — the suggestion it sent is a known-correct rule for this one call,
  // where anything composed here would be a guess at another program's grammar.
  // The words are where it writes, so nobody has to know what `localSettings`
  // means to know what the button does.
  if (view.always) {
    const always = el('button', 'palways', 'Always allow · ' + view.always) as HTMLButtonElement;
    always.onclick = () => decide({ allow: true, always: true }, 'always');
    awaiting(always, sent, 'always');
    row.append(always);
  }

  // The third decision, on the same row as the other two, because that is what
  // it is — one of three peers. It opens the reason rather than deciding: the
  // box under it used to sit open before anyone meant to refuse, which made a
  // refusal the tallest thing on a dialog whose ordinary answer is Allow.
  const canReason = view.canDenyReason !== false;
  const deny = el(
    'button',
    'pdeny' + (canReason && bail.open ? ' on' : ''),
    canReason ? 'Deny…' : 'Deny'
  ) as HTMLButtonElement;
  deny.onclick = () => (canReason ? bail.onOpen(!bail.open) : decide({ allow: false }, 'deny'));
  // Dead whichever button was pressed, this one included, and with no `at`: the
  // denial is sent from inside the drawer, so that is the button that says so.
  awaiting(deny, sent);
  row.append(deny);

  dlg.append(row);

  // A refusal is the one decision here with something worth saying: the words
  // reach the model in place of the tool's result, so "that file is generated"
  // is the difference between the same call again and a different one. Nothing
  // of ours is invented — an empty box denies with no message at all, which is
  // what every denial from this panel used to be, and what the caption says.
  //
  // On the deny alone. An allow needs no words, and a box under one would
  // invite instructions that are sent nowhere.
  //
  // Nothing here stages, still: the drawer is a disclosure, and the button
  // inside it is the decision exactly as the two beside it are.
  if (canReason) {
    dlg.append(
      bailBox({
        open: bail.open,
        cap: 'Denying — say why, or don’t',
        why:
          'The model gets your words in place of the tool’s result. Left empty, it is told ' +
          'only that the call was denied.',
        back: '← never mind',
        onOpen: bail.onOpen,
        say: {
          placeholder: 'Why not? (optional)',
          action: 'Deny',
          cls: 'pdeny-go',
          needsText: false,
          key: bail.key,
          hold: bail.hold,
          value: bail.text,
          sent,
          at: 'deny',
          onType: bail.onType,
          onSend: (message) =>
            decide(message ? { allow: false, message } : { allow: false }, 'deny')
        }
      })
    );
  }
  return dlg;
}
