/**
 * Spawn decisions before the child exists: prompt admission, CLI and model,
 * and command-line quoting. Prompt text can come from someone else's ticket
 * body in a shared workspace.
 */

import { BURST_MAX, BURST_WINDOW_MS, FLEET_MAX } from './guards';
import { WRAPPER_CLOSE, WRAPPER_OPEN } from './send';
import type { BrandId, LaunchTarget } from '../model';
import { DEFAULT_BRAND, sessionBrand } from '../brands';
import { catalogFor, windowOf } from '../catalog';
import { brandForModel, resolveModel, type Model } from '../model_names';
import { ORCHESTRATION_OFF } from '../verbs';
/**
 * How much prompt is allowed onto a command line. A ticket title and its
 * description are hundreds of characters; a runaway agent looping its own
 * output into a spawn is thousands. The real ceiling is `ARG_MAX`, which is a
 * megabyte here — far too high to catch anything, and hitting it fails in the
 * shell rather than in us. This is the refusal that comes with a reason.
 */
const MAX_PROMPT = 4000;

/**
 * Control characters that must never reach the command line. `\n` and `\t` are
 * allowed — a ticket body is multi-line, and inside single quotes both are
 * literal text. The rest are the ones that mean something to a terminal rather
 * than to the shell: `\x1b` starts an escape sequence, `\x03` is what the CLI
 * reads as an interrupt, `\r` submits.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\x00-\x08\x0b-\x1f\x7f]/;

/**
 * The answer every check in this module gives: this spawn may happen, or it may
 * not and here is the sentence to say so.
 *
 * Named for the spawn rather than for the prompt, because only one of the three
 * checks is about a prompt at all — the other two read the fleet and the depth,
 * and neither has a prompt in front of it.
 */
export type SpawnRefused = {
  ok: false;
  reason: string;
  limit?: { kind: 'burst' | 'fleet'; count: number; max: number };
};
export type SpawnAllowed = { ok: true };

/**
 * Whether the machine can take another spawned session, given every spawn on
 * record and whether its child's shell is still running.
 *
 * A judgement rather than a queue: throttling would hold a request open past the
 * 3s reply budget and answer with a session nobody is waiting for any more, and
 * dropping it silently is the thing this codebase refuses to do. A refusal with
 * a count in it is something an orchestrator can act on.
 *
 * The input is every window's spawns, because the CPU is not per-window. Dead
 * children are counted for the burst — five sessions started and killed in a
 * minute is still five starts — and not for the fleet, which is about what is
 * resident now.
 */
export function checkFleet(
  spawns: readonly { spawnedAt: number; alive: boolean }[],
  now: number
): SpawnAllowed | SpawnRefused {
  const burst = spawns.filter((s) => now - s.spawnedAt < BURST_WINDOW_MS).length;
  if (burst >= BURST_MAX) {
    return {
      ok: false,
      limit: { kind: 'burst', count: burst, max: BURST_MAX },
      reason: `${burst} sessions were spawned in the last minute; the limit is ${BURST_MAX}. Wait and try again.`
    };
  }
  const alive = spawns.filter((s) => s.alive).length;
  if (alive >= FLEET_MAX) {
    return {
      ok: false,
      limit: { kind: 'fleet', count: alive, max: FLEET_MAX },
      reason: `${alive} spawned sessions are still running; the limit is ${FLEET_MAX}. Close some first.`
    };
  }
  return { ok: true };
}

/**
 * Refuse with a reason instead of silently sanitizing: the caller could
 * otherwise wait for a session that never starts.
 */
export function checkPrompt(prompt: string): SpawnAllowed | SpawnRefused {
  if (prompt.trim() === '') {
    return { ok: false, reason: 'The prompt is empty.' };
  }
  if (prompt.length > MAX_PROMPT) {
    return {
      ok: false,
      reason: `The prompt is ${prompt.length} characters; the limit is ${MAX_PROMPT}.`
    };
  }
  if (FORBIDDEN.test(prompt)) {
    return { ok: false, reason: 'The prompt contains control characters.' };
  }
  // The window wraps the first turn as the spawner's message, and a body that
  // holds a tag is not unwrapped (`unwrapMessage`) — nor may it forge an author.
  if (prompt.includes(WRAPPER_OPEN) || prompt.includes(WRAPPER_CLOSE)) {
    return {
      ok: false,
      reason:
        'The prompt contains the attribution wrapper. It is written for you, ' +
        'around the prompt, and a prompt cannot carry its own.'
    };
  }
  return { ok: true };
}

/**
 * Keep the full decision testable, including its composition. Check in the
 * order the sender can act: flag, prompt, cwd, fleet.
 */
export function checkVerbSpawn(input: {
  /**
   * `squadron.orchestrators.enabled`, read by the caller.
   */
  enabled: boolean;
  prompt: string;
  /**
   * Result of `fs.stat(cwd).isDirectory()`, or `undefined` when the stat
   * threw. Distinguishes "No such directory" from "Not a directory".
   */
  cwdIsDirectory: boolean | undefined;
  cwd: string;
  spawns: readonly { spawnedAt: number; alive: boolean }[];
  now: number;
}): SpawnAllowed | SpawnRefused {
  // The flag is an opt-in rather than a boundary: anything that can write a
  // request file skips the CLI's gate (`cli/gate.ts`). The checks that follow
  // it are the ones doing real work.
  if (!input.enabled) {
    return { ok: false, reason: ORCHESTRATION_OFF };
  }
  const prompt = checkPrompt(input.prompt);
  if (!prompt.ok) {
    return prompt;
  }
  // A missing cwd is the quiet one — `createTerminal` does not fail on it,
  // it silently lands the shell in the home directory, and the child takes
  // its task in the wrong repository.
  if (input.cwdIsDirectory === undefined) {
    return { ok: false, reason: `No such directory: ${input.cwd}` };
  }
  if (!input.cwdIsDirectory) {
    return { ok: false, reason: `Not a directory: ${input.cwd}` };
  }
  return checkFleet(input.spawns, input.now);
}

/**
 * Limit names so children of one repo differ in the visible part
 * of a card's single-line name.
 */
const MAX_NAME = 40;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/g;

/**
 * A name somebody typed, as a card and a command line can both wear it:
 * flattened onto one line and cut — or nothing, when it says nothing.
 *
 * **It folds a newline rather than stopping at one.** Somebody who typed two
 * lines meant both, and the fold is also what keeps one frame one command:
 * a newline reaching the wire is a second command
 * (`cli/rename.ts`, and the test that says so).
 *
 * `--name` is the one road to telling a CLI a name, and the flag is read at
 * start only — nothing here renames a session later. What a *card* wears is a
 * separate question, answered on every poll by `core/naming.ts`.
 */
export function sessionName(text?: string): string | undefined {
  return clean(text ?? '');
}

/**
 * A prompt as the label its card wears until the CLI titles the conversation.
 *
 * **The opening line only**, where `sessionName` above folds: that is where a
 * task states itself, and the rest of a prompt is context, constraints and the
 * shape of the answer. Folding instead would spend the 40 characters a card has
 * on the second sentence.
 *
 * A second function rather than a flag, because the two callers want opposite
 * things from a newline and one of them is a rename on the wire. It used to be
 * the second parameter here, ranked against the first — and that collapse is
 * what sent a prompt crop out as `--name`, which no CLI can tell from a name
 * somebody chose (sessions.md).
 */
export function promptLabel(prompt?: string): string | undefined {
  return sessionName(prompt?.split('\n')[0]);
}

/**
 * Strip controls instead of refusing a label sliced from other text:
 * there is no one to report a refusal to. `…` distinguishes truncation
 * from a short name. A cut at the previous word would lose a word.
 */
function clean(text: string): string | undefined {
  const flat = text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_NAME) {
    return flat || undefined;
  }
  return `${flat.slice(0, MAX_NAME - 1).trimEnd()}…`;
}

/**
 * The requested launch target (`core/model.ts`). A window needs a model
 * to name anything. Effort is checked against the stated or inherited model
 * (`effortOf`).
 */
export type SpawnIdentity = LaunchTarget;

/**
 * The parent the window can see: an owned or published session record.
 *
 * **No `effort`, and that is not an omission.** Every field here is something
 * the parent *asked for* — see `window` below, filled from `windowAsked` or
 * `contextAsked` and never from the figure a card reads. There is no
 * `effortAsked`: `Session.effort` is read back off the transcript and moves the
 * moment somebody types `/effort`, so inheriting it would be inheriting an
 * observation, which is exactly what `window`'s two comments refuse.
 */
export type SpawnParent = {
  brand?: BrandId;
  model?: string;
  modelPick?: string;
  /**
   * The window the parent is running in, in tokens, so a fan-out inherits it
   * along with the model.
   *
   * **What the parent *asked for*, never what the wire stated.** Every session
   * observes a window off its first `result`, so inheriting the observation
   * would launch every child pinned to a figure nobody chose: they would stop
   * teaching `models.json`, and a gated pair would 400 on a window nobody
   * asked for. `host/sessions.ts` fills this from the parent's `windowAsked`.
   *
   * One source since row 71. It used to have two — the registry for a parent
   * this window owns, and a published record for one another window owned,
   * whose `Session` states `contextAsked` for the same reason and not
   * `contextSize`. A spawn lands in its caller's window now, so while a
   * parent's window is alive the parent is in this window's registry; one that
   * died in between degrades as an unknown parent does.
   */
  window?: number;
};

function stated(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Whether `--brand` / `--model` may be posted as stated.
 *
 * `--model` alone cannot be resolved: even though `brandForModel` places the
 * observed `grok-*` and `gpt-*` families, treating every other value as Claude
 * would start the wrong CLI for a future id. A mismatch is only the
 * unambiguous case. Membership in the catalog is not consulted, and matters more
 * now that the catalog is hand-kept: a row we have not added yet is still an
 * id the CLI will run, and refusing it here would be our list overruling the
 * binary's.
 *
 * **`--context` is the one exception, and only where the catalog can speak.**
 * A window is not a spelling the CLI accepts — it is ours, and the launch line
 * is *composed* from it (`[1m]`, or the flag, or nothing). So a window we
 * cannot place is a window we cannot ask for, and starting the session anyway
 * would silently give the caller a different one than they named. Refused only
 * when the model **is** a catalog row and the window is not one of its: an id
 * we have not added yet still falls through, unchanged, because there the
 * catalog has no standing to refuse anything.
 */
export function checkSpawnIdentity(asked: SpawnIdentity): SpawnAllowed | SpawnRefused {
  const brand = asked.brand;
  const model = stated(asked.model);
  if (model && !brand) {
    return {
      ok: false,
      reason: '--model-id needs --brand; pass neither to inherit from the spawning session'
    };
  }
  if (brand && model) {
    const owner = brandForModel(model);
    if (owner !== undefined && owner !== brand) {
      return {
        ok: false,
        reason: `--model-id ${model} does not belong to --brand ${brand}`
      };
    }
    const window = asked.window;
    if (window !== undefined && !windowOf(brand, model, window)) {
      const row = catalogFor(brand).filter((m) => m.value === model);
      if (row.length) {
        return {
          ok: false,
          reason:
            `--model-id ${model} has no ${window}-token context window; ` +
            `it offers ${row.map((m) => m.window).join(' and ')}`
        };
      }
    }
  }
  return { ok: true };
}

/**
 * Brand and `--model` for a prompt-carrying open, once the window has the
 * parent's record.
 *
 * | given | do |
 * | neither | inherit parent brand + `modelPick`, else resolve the reading; degrade to no `--model` when that is unreadable |
 * | both | as stated, after `checkSpawnIdentity` |
 * | `--model` only | refuse |
 * | `--brand` only | that brand, no `--model` |
 *
 * No setting is consulted. `agentsview.cli` retired when a start began stating
 * its own brand, and `squadron.model` — which stayed — is read in the webview
 * to seed a draft's pill and nowhere on this path
 * (`TASK_done_draft_new_session.md` Step 8). A spawn that omitted both
 * used to pick the gear up here, which is why the cross-brand silent drop
 * existed.
 */
export function resolveSpawnIdentity(
  asked: SpawnIdentity,
  parent?: SpawnParent,
  models: readonly Model[] = []
): { ok: true; brand: BrandId; model?: string; window?: number; effort?: string } | SpawnRefused {
  const check = checkSpawnIdentity(asked);
  if (!check.ok) return check;
  const picked = pickTarget(asked, parent, models);
  // Check effort even when the model is inherited. Omitting `--brand`
  // must not silently discard the requested effort.
  const effort = effortOf(stated(asked.effort), picked, models);
  if (!effort.ok) return effort;
  return { ok: true, ...picked, ...(effort.effort === undefined ? {} : { effort: effort.effort }) };
}

/**
 * Omit an absent window rather than setting it to `undefined`: callers
 * and tests compare the whole result.
 */
function pickTarget(
  asked: SpawnIdentity,
  parent: SpawnParent | undefined,
  models: readonly Model[]
): { brand: BrandId; model?: string; window?: number } {
  const brand = asked.brand;
  const model = stated(asked.model);
  const win = (w: number | undefined) => (w === undefined ? {} : { window: w });
  if (brand && model) return { brand, model, ...win(asked.window) };
  if (brand) return { brand };
  const inheritedBrand = parent ? sessionBrand(parent.brand) : DEFAULT_BRAND;
  const inherited = inheritModel(parent, models);
  // Drop a mismatched inherited pick instead of refusing a child for
  // a mismatch the reader never stated.
  if (!inherited) return { brand: inheritedBrand };
  const owner = brandForModel(inherited.model);
  if (owner !== undefined && owner !== inheritedBrand) return { brand: inheritedBrand };
  return { brand: inheritedBrand, model: inherited.model, ...win(inherited.window) };
}

/**
 * The effort the child opens at, checked against the row of the model it will
 * run — Phase 2 of `PRD_shipped_effort_configuration.md`.
 *
 * | row | stated | omitted |
 * | none (unknown id, or no model) | as stated — the CLI refuses it, not our list | none |
 * | states no efforts (Haiku) | refused | none |
 * | states efforts | kept if one of them, else refused | the row's `defaultEffort` |
 *
 * The default is the panel's: `+` sends the row's own figure, and a spawn that
 * sent none used to open at the CLI's (`medium` on Claude, against `high`).
 * Never the parent's — see `SpawnParent`.
 */
function effortOf(
  asked: string | undefined,
  target: { model?: string; window?: number },
  models: readonly Model[]
): { ok: true; effort?: string } | SpawnRefused {
  const row = target.model
    ? resolveModel(models, target.model, target.model, target.window)
    : undefined;
  if (!row) return { ok: true, effort: asked };
  const offered = row.efforts ?? [];
  if (asked === undefined) {
    return { ok: true, effort: offered.length ? row.defaultEffort : undefined };
  }
  if (!offered.length) {
    return { ok: false, reason: `--effort ${asked}: ${row.name} has no effort setting` };
  }
  if (offered.some((e) => e.value === asked)) return { ok: true, effort: asked };
  return {
    ok: false,
    reason: `--effort ${asked} is not one ${row.name} offers: ${offered.map((e) => e.value).join(', ')}`
  };
}

/**
 * Inherit model and window together, or the children could run in a
 * different window from their parent. See the return below for why the
 * resolved row's window is not a fallback.
 */
function inheritModel(
  parent: SpawnParent | undefined,
  models: readonly Model[]
): { model: string; window?: number } | undefined {
  if (!parent) return undefined;
  const pick = stated(parent.modelPick);
  if (pick) return { model: pick, window: parent.window };
  const row = resolveModel(models, parent.model, parent.modelPick, parent.window);
  if (!row) return undefined;
  // `parent.window`, and nothing else. The row's own window is the catalog's
  // first entry — 1M for Sonnet 5 — so falling back to it would pin a child
  // that its parent never pinned, at the widest window on offer.
  return { model: row.value, window: parent.window };
}
