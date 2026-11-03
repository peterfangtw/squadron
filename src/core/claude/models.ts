/**
 * The `list_models` control request — **a maintenance tool, not the panel's
 * list.**
 *
 * This file used to be where the flyout's rows came from, and its header used
 * to argue that asking beats writing rows down: the CLI grows aliases and
 * retires them without telling anyone, and `list_models` gates itself where a
 * hardcoded row goes stale in silence.
 *
 * That argument lost to a measurement: the list is a *subset* of what the
 * binary will run, and nothing in the CLI's changelog records a removal from
 * the picker (`cli_state/models.md` § *The gap: listed ⊂ runnable*, where the
 * probe is dated and versioned). So asking cannot reach a model that has been
 * dropped from the list, cannot state a spelling stable enough for a workflow
 * file on another machine, and answers in the CLI's own spellings rather than
 * ours. `core/catalog.ts` is the bargain that replaced it: rows we maintain,
 * answered synchronously, with the spellings a live reading arrives in.
 *
 * What is given up, stated plainly: `list_models` was the only source that is a
 * subset of *this user's* runnable, and this extension ships publicly. A
 * catalog row naming a model a user's binary does not know does not error — it
 * silently compacts at 200k (`cli_state/models.md`). The guards are the release
 * scenario (`src/test/live_session/model_catalog.md`) and a deferred per-row
 * version floor. The whole argument, including the review finding that wanted
 * this file kept as a runtime filter, is in
 * `docs/tasks/TASK_done_model_catalog.md`.
 *
 * **So this is what it is for now:** `models.mjs claude` diffs what the
 * installed CLI advertises against the catalog, both directions, so a model
 * that appears or disappears is something a person is told about rather than
 * something nobody notices. It needs a real binary, so it is **not** in
 * `npm run check` — CI has none. Its tests stay: the parse is still of another
 * program's JSON, and it is still the only thing that reads this wire.
 *
 * **A brand's spelling stops here, and in `model_names.ts`.** `value` /
 * `resolvedModel` / `displayName` are this CLI's words for it; everything above
 * these two files reads `Model`, which is ours.
 *
 * **Its own child, deliberately.** The request is answered on a fresh session
 * before `init` is, with no `user` frame sent, so it costs a spawn and no model
 * call at all (observed 2.1.220, 2026-08-04 — `docs/reference/cli_state/claude/protocol.md`).
 */

import type { Program } from '../platform/executables';
import { SessionTransport, childTransport } from '../session';
import { Model } from '../model_names';
import { controlRequest, readFrame } from './frames';
import { PROTOCOL_ARGS, PROTOCOL_ENV } from './session';

export type { Model } from '../model_names';

/** How long to wait for the answer before giving up on it. The response came
 *  back in well under a second; a CLI that is downloading an update, or one
 *  that has never heard of `list_models`, must not leave a promise open for the
 *  panel's lifetime. */
const ANSWER_MS = 8000;

/** The request id. One request, one child, so nothing has to be unique. */
const REQUEST_ID = 'squadron-models';

/**
 * The CLI's own `default` row is dropped.
 *
 * It is not a model, it is the absence of a pick — the panel draws its own
 * `default` under a rule, storing the empty string, and that row must never
 * claim a resolved name. The CLI's version carries one (`claude-opus-5[1m]`
 * here) which is the *configured* default and goes stale the moment a reader
 * changes it elsewhere.
 */
const CLI_DEFAULT = 'default';

/**
 * A row the CLI lists in order to say it cannot run it.
 *
 * Observed 2026-09-02 on 2.1.241, the day 2.1.257 shipped Fable 5.1:
 * `{ value: 'cc-update-required-1', displayName: 'Fable 5.1 (disabled)',
 * description: 'Update to 2.1.255+ to use Fable 5.1', disabled: true }`. The
 * `value` is a placeholder rather than a model — `--model cc-update-required-1`
 * names nothing — so it is an update nag wearing a row's shape, and passing it
 * through made `models.mjs` report a catalog row was missing for it.
 *
 * Dropped on the flag rather than on the `cc-update-required-` prefix: the flag
 * is the field that means it, and a prefix rule would be this file guessing at
 * a spelling the CLI never documented.
 */
function disabled(raw: Record<string, unknown>): boolean {
  return raw.disabled === true;
}

function read(payload: Record<string, unknown> | undefined): Model[] {
  // `unknown[]`, not what `Array.isArray` hands back: it narrows to `any[]`, and
  // every guard below would then be checked by nobody — the cast on the next
  // line included. This is the one file whose whole job is parsing another
  // program's JSON.
  const rows: unknown[] = Array.isArray(payload?.models) ? payload.models : [];
  const out: Model[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const raw = row as Record<string, unknown>;
    if (disabled(raw)) continue;
    const value = typeof raw.value === 'string' ? raw.value : '';
    if (!value || value === CLI_DEFAULT) continue;
    const name = typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : value;
    const id = typeof raw.resolvedModel === 'string' ? raw.resolvedModel : '';
    out.push({ value, name, id, brand: 'claude' });
  }
  return out;
}

/**
 * Ask a transport for its models. Split from `listModels` so the tests can
 * drive it over a stub, and so a broker that already holds a pipe could answer
 * without spawning anything.
 *
 * Never rejects: a CLI that answers an error, answers nothing, or dies on the
 * way is a panel with no list to offer, which the flyout draws as such. The
 * transport is closed either way — this is its only reason to exist.
 */
export function askModels(transport: SessionTransport): Promise<Model[]> {
  return new Promise<Model[]>((resolve) => {
    let done = false;
    const finish = (models: Model[]): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      transport.close();
      resolve(models);
    };
    const timer = setTimeout(() => finish([]), ANSWER_MS);
    // The parse is here rather than in the transport, which carries JSON and
    // knows no brand: this round trip is a Claude control request, so reading
    // its answer as a Claude frame is this file's own business.
    transport.onLine((value) => {
      const frame = readFrame(value);
      if (frame?.type !== 'control_response' || frame.requestId !== REQUEST_ID) return;
      finish(frame.ok ? read(frame.payload) : []);
    });
    transport.onExit(() => finish([]));
    transport.write(controlRequest(REQUEST_ID, 'list_models'));
  });
}

/** The list, from a child of our own. `cwd` only decides where that child
 *  starts; the answer is the account's and does not depend on it. */
export function listModels(bin: Program, cwd: string): Promise<Model[]> {
  return askModels(childTransport({ bin, cwd, args: PROTOCOL_ARGS, env: PROTOCOL_ENV }));
}
