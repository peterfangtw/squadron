import * as nodeFs from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseAnswered } from './asks';
import type { AnsweredAsk } from '../transcript';
import type { Witness } from '../record';
import { imagePathsIn } from '../pastes';
import { proseImages } from '../prose_images';
import { CLAUDE_DIR } from '../paths';
import { scrubbedInput } from '../scrub';
import { narrationText } from './narration';
import { delivered } from '../coordination/send';
import {
  type Block,
  type Exchange,
  type Marker,
  type Recent,
  type Written,
  type WriteInput,
  addWritten,
  localReply,
  noteWrite,
  HOLD_MISSES,
  cutOutput,
  isMarker,
  MAX_TURNS
} from '../transcript';

/**
 * How much of the file's end to read first. Sized against bytes rather than
 * turns: a transcript is mostly tool results, which the thread drops but still
 * has to read past, so one `Read` can be a single line of hundreds of kilobytes.
 * Measured over every transcript on this machine — 2MB reaches a hundred turns
 * for all but an eighth of them, where 1MB leaves a third of them widening.
 */
const TAIL_BYTES = 2 * 1024 * 1024;

/**
 * How far back the read will widen when the first window lands short. One pasted
 * screenshot is a megabyte of base64 on a single line, which swallows the whole
 * first window and leaves a five-turn session claiming its history was lost.
 * Doubling from `TAIL_BYTES`, that is at most two further reads, and none at all
 * for a session whose start the first window already reached.
 */
const MAX_TAIL_BYTES = 8 * 1024 * 1024;

/**
 * How long a slug may be before the CLI truncates it and appends a hash of the
 * path it came from. Read out of the 2.1.220 bundle, 2026-07-27.
 */
const MAX_SLUG = 200;

/**
 * The CLI's own name for a cwd's directory under `projects/`.
 *
 * Read out of the bundle rather than inferred, after a derived path missed a
 * real transcript by one character: this repo replaced `/` and `.` and left
 * everything else alone, where the CLI replaces **every** non-alphanumeric —
 * `_`, spaces, `@` — with a dash. Confirmed against the 289 project
 * directories on this machine: not one contains an underscore.
 *
 *     function RA(e){let t=e.replace(/[^a-zA-Z0-9]/g,"-");
 *       if(t.length<=200)return t;return`${t.slice(0,200)}-${o0h(e)}`}
 *     function art(e){let t=0;for(let r=0;r<e.length;r++)
 *       t=(t<<5)-t+e.charCodeAt(r)|0;return t}
 *
 * The hash is over the **original** path, not over the slug, and `|0` makes it
 * a signed 32-bit integer — which is why it is written out the long way here
 * rather than with a `%`.
 */
export function projectSlug(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= MAX_SLUG) {
    return slug;
  }
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) {
    hash = (Math.imul(hash, 31) + cwd.charCodeAt(i)) | 0;
  }
  return `${slug.slice(0, MAX_SLUG)}-${Math.abs(hash).toString(36)}`;
}

/**
 * Where a session's transcript is, derived.
 *
 * Only a derivation: an owned session's wire states the path outright, and this
 * is what answers for a discovered one. The cwd has to be the
 * CLI's own, which is the real path: it calls `realpath` before slugging, so
 * `/tmp/x` is filed under `-private-tmp-x` on macOS.
 */
export function transcriptPath(cwd: string, sessionId: string): string {
  return path.join(CLAUDE_DIR, 'projects', projectSlug(cwd), `${sessionId}.jsonl`);
}

/**
 * Where the CLI will file a session we start in `cwd` under `sessionId`,
 * before it has said which cwd it resolved.
 *
 * The CLI realpaths the cwd before slugging (`transcriptPath` above). Synchronous
 * because it seeds a constructor's first state, and `reduce` keeps that pin when
 * `init` restates the same id.
 */
export function launchTranscriptPath(cwd: string, sessionId: string): string {
  let real = cwd;
  try {
    real = nodeFs.realpathSync(cwd);
  } catch {
    // Unresolvable: slugged as given, since the CLI cannot start there anyway.
  }
  return transcriptPath(real, sessionId);
}

/**
 * Where a session's transcript actually is, and which directory the session
 * lives in — not what the pid file says once the session has moved.
 *
 * The CLI rewrites `cwd` in `sessions/<pid>.json` on every directory change
 * while the transcript stays where it was filed (2.1.220; see
 * `docs/reference/cli_state/claude/transcript.md`), so deriving for a session
 * that stepped into a subdirectory points at a project directory that has never
 * existed — the dock said the conversation was gone, and the card left its
 * repository's group.
 *
 * **`pinned` is a candidate, not the answer.** A session on a pipe had its path
 * derived once, off its first `init`, from the cwd the conversation *began* in
 * (`core/claude/reduce.ts`), which is the bucket the CLI filed it under. A plain
 * `cd` leaves it there, so the pin outlives a cwd that has since moved — the
 * derivation that replaces it misses, and then sweeps: a session that walked
 * into a subdirectory emptied its own dock in every window open at the time,
 * until that window was reloaded (2026-08-17). It costs a `stat` and, once per
 * session, the head read below — against the ~95 `stat`s the sweep it skips
 * would pay every poll.
 *
 * `EnterWorktree` is the case the pin gets wrong: the CLI moves the file into
 * the new cwd's slug and writes a `relocated` entry (2026-08-18). The pin is
 * then a path with nothing at it, which is why it is stat'd rather than
 * believed, and why the memo above is stat'd too.
 *
 * Only a miss sweeps `projects/`, which also covers the blind spot deriving can
 * never reach: the CLI slugs the *real* path, so a session under a symlink is
 * unfindable — and is why a pinned path that is not there falls through rather
 * than being believed.
 *
 * `home` is what binds a card to a group, so the head is taken only when it
 * slugs back to the directory the file was found in. Otherwise it is a head
 * left behind by a resume in another directory (see `transcriptHome`), and
 * believing it would move a running session's card into the group of the
 * checkout its conversation *began* in, reading that checkout's branch.
 */
export async function locateTranscript(
  cwd: string,
  sessionId: string,
  /** The path this session's own frames pinned, for a caller that holds them. */
  pinned?: string
): Promise<{ file: string; home: string }> {
  const remembered = located.get(sessionId);
  // Re-stat rather than believe: `EnterWorktree` *moves* the transcript into the
  // new cwd's slug and leaves a `relocated` entry behind (2.1.220; 57 of the
  // transcripts on this machine carry one), so a remembered path is a file that
  // can stop existing. Held ones emptied their own dock for the life of the
  // panel — reported 2026-08-18 against the session whose `EnterWorktree` this
  // comment was written from. One `stat`, which is what the derivation below
  // costs anyway; dropping the entry lets that derivation answer.
  if (remembered && (await isFile(remembered.file))) {
    return { file: remembered.file, home: remembered.home ?? cwd };
  }
  located.delete(sessionId);
  if (pinned && (await isFile(pinned))) {
    return filedAt(pinned, cwd, sessionId);
  }
  const derived = transcriptPath(cwd, sessionId);
  // Filed under this cwd's own slug, so this cwd is where the session lives.
  if (await isFile(derived)) {
    return { file: derived, home: cwd };
  }
  const file = await sweep(sessionId);
  if (!file) {
    return { file: derived, home: cwd };
  }
  return filedAt(file, cwd, sessionId);
}

async function filedAt(
  file: string,
  cwd: string,
  sessionId: string
): Promise<{ file: string; home: string }> {
  const said = await transcriptHome(file);
  const filedUnder = path.basename(path.dirname(file));
  const found = {
    file,
    home: said !== undefined && projectSlug(said) === filedUnder ? said : undefined
  };
  located.set(sessionId, found);
  return { file, home: found.home ?? cwd };
}

/**
 * One entry per session whose transcript cost a read to place — a pinned path
 * taken, or a sweep that found one. A session id names one file at a time (the
 * CLI refuses a start whose id already has a transcript), and a lookup that
 * found nothing is not remembered, so a transcript written later is still found
 * on the next poll. Dies with the panel, like every cache here.
 *
 * **What is remembered is a path, and a path is not a file.** `EnterWorktree`
 * relocates the transcript out from under an entry written before it; the entry
 * is dropped on the first call that finds nothing there.
 *
 * **`home` is absent, not defaulted, when the file names no directory of its
 * own.** The fallback is the caller's cwd, and that moves: freezing one taken
 * mid-`cd` left a card in a group named after the subdirectory a session was
 * standing in half an hour ago. What is stored here is what the file says,
 * which cannot go stale; the fallback is applied per call.
 */
const located = new Map<string, { file: string; home?: string }>();

const isFile = (file: string): Promise<boolean> =>
  fs.stat(file).then(
    (info) => info.isFile(),
    () => false
  );

/** The transcript this session id names, wherever it was filed. An id is unique
 *  across every project directory, so the first hit is the answer. */
async function sweep(sessionId: string): Promise<string | undefined> {
  const projects = path.join(CLAUDE_DIR, 'projects');
  let dirs: string[];
  try {
    dirs = await fs.readdir(projects);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const file = path.join(projects, dir, `${sessionId}.jsonl`);
    if (await isFile(file)) {
      return file;
    }
  }
  return undefined;
}

/**
 * The directory a transcript was written in, off its own head — the path the
 * slug cannot be turned back into. A head rather than a line: the first entry
 * can be a `custom-title`, which states no cwd.
 *
 * **A candidate, not an answer.** Usually the file's first entries were written
 * where it was created, which is the directory whose slug named it. But
 * resuming a conversation from another directory copies its entries into a file
 * filed under the *new* one, so the head then names the checkout it began in —
 * measured 2026-08-13 across one monorepo's checkouts, where
 * one worktree's directory holds heads naming two other checkouts. A caller
 * asking which directory a transcript belongs to must slug this back and check
 * it matches; `locateTranscript` is spared that only because it has already
 * found the file and wants the conversation's origin either way.
 */
export async function transcriptHome(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    // Ignore a partial last line as any other unparseable line.
    for (const line of buffer.toString('utf8', 0, bytesRead).split('\n')) {
      const dir = parsed(line)?.cwd;
      if (typeof dir === 'string' && dir) {
        return dir;
      }
    }
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
  return undefined;
}

/** How much of a transcript's head is read for the cwd it was written in.
 *  Generous: a session that opened with a pasted image writes a megabyte before
 *  its first turn, but every entry states the cwd, including the meta ones. */
const HEAD_BYTES = 64 * 1024;

/**
 * whole means the read reached the start; otherwise older history remains.
 * ok distinguishes an empty file from a failed read, which must not be cached.
 */
export async function tail(
  file: string,
  want: number
): Promise<{ lines: string[]; whole: boolean; ok: boolean }> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return { lines: [], whole: true, ok: false };
    const { size } = stat;
    const length = Math.min(want, size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    const whole = length >= size;
    return { lines: whole ? lines : lines.slice(1), whole, ok: true };
  } catch {
    return { lines: [], whole: true, ok: false };
  } finally {
    await handle?.close();
  }
}

type Parsed = {
  recent: Recent;
  /**
   * Every `message.id` in the window this read covered, whether or not the entry
   * behind it produced a turn.
   *
   * The one field both halves of the CLI write for the same message — the frame
   * on the pipe and the entry on disk — and therefore the only sound way to ask
   * whether our own record witnessed everything this file can show.
   * `core/record.ts`'s `drawable` is the caller, and it treats this as evidence
   * about the window rather than about the conversation: what is older than the
   * walk reached is not evidence at all, so it is not drawn from the record
   * either.
   *
   * **A `<synthetic>` entry is left out, and that is not tidiness.** Swept
   * 2026-08-20 over all 2092 transcripts here: 186,854 assistant entries all
   * carry an id, and **94 of them are `message.model: "<synthetic>"`** — the CLI
   * writing its own turn where the model's would go (`API Error: 529
   * Overloaded`, a weekly limit, a credits notice). Their id is a **bare UUID,
   * never `msg_…`**, so it is minted locally at write time rather than returned
   * by the API, and whether any frame carries it is unmeasured. They are not a
   * TUI artefact either: 55 of the 63 files holding one are `entrypoint:
   * sdk-cli`, driven over exactly the pipe the tee reads. Counted, one 529 in a
   * long session would pin that conversation to the fallback for good — the
   * record keys on the conversation and `--resume` keeps the file, so nothing
   * would ever clear it. Left out because it is an entry the CLI wrote *about*
   * the conversation rather than a message we could have been there for.
   */
  witnessed: Set<string>;
};

/**
 * The tail, over one read of the file, remembered until the file changes. Size
 * and mtime together decide it is the same file: a transcript grows rather than
 * changes, and a rewrite landing on the same length would still move the clock.
 *
 * Callers must not mutate cached arrays. Keep the last good parse until
 * HOLD_MISSES consecutive failed stats; successful reads replace it.
 * One entry per transcript read, for the panel's lifetime.
 */
const cache = new Map<string, { stamp: string; parsed: Parsed }>();

/** Consecutive failed stats per file, cleared by any stat that succeeds. */
const misses = new Map<string, number>();

/** Build per call so a caller that mutates this cannot affect another caller. */
const nothing = (): Parsed => ({
  recent: { exchanges: [], truncated: false },
  witnessed: new Set()
});

/**
 * Hold the last good parse: failed reads and empty transcripts both reach
 * panel.ts as empty exchanges, and both show "No conversation found".
 * A successful read replaces the cache even when empty; do not prefer fuller.
 */
async function parse(file: string): Promise<Parsed> {
  let stamp: string;
  try {
    const { size, mtimeMs } = await fs.stat(file);
    stamp = `${size}:${mtimeMs}`;
    misses.delete(file);
  } catch {
    // Read the cache at failure: another caller may have updated it during await.
    // Only failed stats count against HOLD_MISSES; a failed read after a successful
    // stat leaves a file on disk that is still ours to hold.
    const seen = (misses.get(file) ?? 0) + 1;
    if (seen >= HOLD_MISSES) {
      misses.delete(file);
      cache.delete(file);
      return nothing();
    }
    misses.set(file, seen);
    return cache.get(file)?.parsed ?? nothing();
  }

  const hit = cache.get(file);
  if (hit?.stamp === stamp) {
    return hit.parsed;
  }

  const read = await widen(file);
  if (!read) {
    // Keep the old stamp after a failed read, or a changed transcript would remain
    // unread until it changed again.
    return cache.get(file)?.parsed ?? nothing();
  }
  const parsed = { recent: read.recent, witnessed: read.witnessed };
  cache.set(file, { stamp, parsed });
  return parsed;
}

/**
 * Reads the tail, and reads further back when that one landed short. Only a
 * walk the buffer ran out under is worth widening for: one the turn cap stopped
 * already holds its hundred, and one that reached the file's start holds
 * everything there is. So the common session pays a single read, and the one
 * that pays more is the one that would otherwise have lied about its history.
 */
async function widen(file: string): Promise<(Parsed & { order: readonly Witness[] }) | undefined> {
  for (let want = TAIL_BYTES; ; want *= 2) {
    const { lines, whole, ok } = await tail(file, want);
    if (!ok) {
      return undefined;
    }
    const { exchanges, capped, witnessed, order } = walk(lines);
    if (whole || capped || want >= MAX_TAIL_BYTES) {
      return { recent: { exchanges, truncated: capped || !whole }, witnessed, order };
    }
  }
}

/**
 * Harness-injected content that arrives as a user turn but was never typed:
 * task notifications, reminders, slash-command scaffolding, command output —
 * and the note the CLI writes down beside an attached image, which is a turn of
 * its own reading `[Image: original 2460x1702, displayed at ...]`.
 */
const INJECTED =
  /^(<(task-notification|system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-caveat)>|\[Image: )/;

/** The one of those worth reading before dropping: every note on this machine
 *  matches, and it is the only place an attached image's size is written. */
const IMAGE_NOTE = /^\[Image: original (\d+)x(\d+)/;

/** The command a slash-command entry names, which is the only place the typed
 *  path writes a skill's name down. Searched, not anchored: the entry carries a
 *  `<command-message>` line above it. */
const COMMAND_NAME = /<command-name>\/?([^<\n]+)<\/command-name>/;

/** A skill body loaded by the `Skill` tool: its first line is the skill's own
 *  directory, whose last segment is the name. The typed path writes no such
 *  line — see `docs/reference/cli_state/claude/transcript.md`. */
const SKILL_DIR = /^Base directory for this skill: .*[/\\]([^/\\\s]+)/;

/** Both spellings the CLI uses. Nothing marks these as injected — no `isMeta`,
 *  no tag — so the text is all there is to go on. */
const BREAK = /^\[Request interrupted by user( for tool use)?\]$/;

/** The model id on a turn the CLI wrote in the model's place. */
const SYNTHETIC = '<synthetic>';

/** What a local command's answer is wrapped in on disk. Anchored to both ends of
 *  the trimmed content and with no `m` flag, so the tag has to be the whole of
 *  it rather than something the body merely contains. `[^]*` is greedy and is
 *  what matches across newlines here — `.` would not, and a body that wrapped a
 *  second tag would want the outermost pair anyway. */
const LOCAL_STDOUT = /^<local-command-stdout>([^]*)<\/local-command-stdout>$/;

/**
 * The colour a command printed for a terminal that is not there. The CLI writes
 * SGR escapes into this body — 8 of the 47 non-empty bodies here carry them, the
 * newest on 2.1.220, so it is current behaviour.
 *
 * Stripped here because nothing downstream does: the markdown engine passes
 * control characters through and the sanitizer keeps text, so the reader is left
 * looking at `[1mOpus 5[22m`. Only `m` is matched, and only `m` was ever
 * written — all 115 escapes swept ended in it.
 */
// The control character is the whole point of this pattern — `no-control-regex`
// is here to catch one that arrived by accident, and this one is the target.
// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[[0-9;]*m/g;

/**
 * A slash command's own output, out of the `system` entry that holds it.
 *
 * Structural test, not a vocabulary: the one shape read is
 * `subtype: "local_command"`, so a CLI that adds a command gets drawn the day it
 * ships. **It is the only record on disk** — the same answer arrives on the wire
 * as a `<synthetic>` assistant frame, but the transcript gets no assistant entry
 * for it (2026-08-05, 2.1.220;
 * `docs/reference/cli_state/claude/transcript.md`).
 *
 * Nothing for an answer with no words: `/clear` writes an empty body, and an
 * empty turn says less than no turn does.
 */
function localCommand(entry: Entry): string | undefined {
  if (entry.subtype !== 'local_command' || typeof entry.content !== 'string') {
    return undefined;
  }
  const said = (LOCAL_STDOUT.exec(entry.content.trim())?.[1] ?? '').replace(SGR, '').trim();
  return said || undefined;
}

/**
 * What a user-role entry actually is. The CLI writes several things down as user
 * turns that nobody typed: some noise, some facts worth keeping, and one — a
 * skill loading — the thread should show.
 * Use one decision point to avoid phantom skills from re-invocation notices.
 */
type Origin =
  /** residual marks an unknown injected shape that a later entry can identify. */
  | { as: 'drop'; note?: { w: number; h: number }; command?: string; residual?: boolean }
  | { as: 'mark'; mark: Marker['mark']; skill?: string }
  /** An authored peer message. Unwrap per send; prompt-nav must skip it. */
  | { as: 'authored' };

function origin(isMeta: unknown, text: string): Origin | undefined {
  if (BREAK.test(text)) {
    return { as: 'mark', mark: 'break' };
  }
  // Not gated on `isMeta`: we wrote this one, and the CLI files it as an
  // ordinary user turn with no flag at all (probe, 2026-08-19). An entry that
  // batched it with something a person typed does not match here and is a
  // prompt, which it is — the walk still unwraps the one send that is not.
  const said = delivered(text);
  if (said.role !== 'user' || said.from !== undefined) {
    return { as: 'authored' };
  }
  // Gated on `isMeta`, so an ordinary prompt never runs it: every skill body on
  // this machine carries the flag, and a turn that merely quotes the line is a
  // turn somebody typed.
  if (isMeta) {
    const named = SKILL_DIR.exec(text);
    if (named?.[1]) {
      return { as: 'mark', mark: 'skill', skill: named[1] };
    }
  }
  if (INJECTED.test(text)) {
    const note = IMAGE_NOTE.exec(text);
    return {
      as: 'drop',
      note: note ? { w: Number(note[1]), h: Number(note[2]) } : undefined,
      command: COMMAND_NAME.exec(text)?.[1]
    };
  }
  // Injected, but in a shape with no prefix to match on: an expanded slash
  // command, a re-invocation notice, an output style. Dropped like the rest —
  // naming it a skill on the strength of `isMeta` alone would invent a chip for
  // every shape a later CLI adds.
  if (isMeta) {
    return { as: 'drop', residual: true };
  }
  return undefined;
}

/**
 * One thing somebody sent, out of an entry that may hold several. A message
 * typed at a busy session waits on stdin and the CLI hands the pile to the next
 * turn as one text block each — three sends land as one entry with three blocks
 * (2026-07-27, 2.1.220). Kept separate so `ui/views.ts`'s outbox can match a
 * held entry against the send that retired it.
 */
type Send = { text: string; images: ImageRef[] };

/** What a call returned, before it has been matched to the call. */
type Returned = { output?: string; failed?: boolean; ask?: AnsweredAsk };

/**
 * A result's words, cut. Both shapes the CLI writes: a string (2504 of 2531) and
 * a block list (27), of which only the `text` parts are words — the rest are
 * `tool_reference` and the odd `image`.
 *
 * Shared with `tee.ts`, which reads the same block off the wire: one ceiling for
 * both sources, so a call's row does not change length when the dock swaps which
 * of the two it is drawing.
 */
export function outputOf(content: unknown): string | undefined {
  const said =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? (content as { type?: unknown; text?: unknown }[])
            .filter((b) => b?.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text as string)
            .join('\n')
        : '';
  return cutOutput(said);
}

function textOf(
  content: unknown,
  uuid: unknown,
  cwd: unknown,
  /**
   * Prompts use the prose parser with images off. Do not rewrite their literal
   * image syntax to remove a picture the reader was never shown.
   */
  rendered = false
): {
  text: string;
  blocks: Block[];
  results: Map<string, Returned>;
  files: string[];
  sizes: Record<string, Written>;
  images: ImageRef[];
  sends: Send[];
} {
  if (typeof content === 'string') {
    return {
      text: content,
      blocks: content ? [{ text: content }] : [],
      results: new Map(),
      files: [],
      sizes: {},
      images: [],
      sends: [{ text: content, images: [] }]
    };
  }
  if (!Array.isArray(content)) {
    return {
      text: '',
      blocks: [],
      results: new Map(),
      files: [],
      sizes: {},
      images: [],
      sends: []
    };
  }
  const parts: Block[] = [];
  const results = new Map<string, Returned>();
  const files: string[] = [];
  const sizes: Record<string, Written> = {};
  const images: ImageRef[] = [];
  const sends: Send[] = [];
  const blocks = content as {
    type?: unknown;
    text?: unknown;
    thinking?: unknown;
    signature?: unknown;
    name?: unknown;
    id?: unknown;
    input?: WriteInput;
    tool_use_id?: unknown;
    is_error?: unknown;
    content?: unknown;
  }[];
  for (let at = 0; at < blocks.length; at++) {
    const block = blocks[at];
    // Narration is prose too, only summarised by the server: see `narration.ts`.
    const narrated = block ? narrationText(block) : undefined;
    const said = block?.type === 'text' && typeof block.text === 'string' ? block.text : narrated;
    if (said !== undefined) {
      // `text` is matched against the words the composer sent and read for the
      // tags the CLI injects, both of which want the edges gone. A block is
      // what gets drawn, and keeps them: the composer sends what was typed
      // (`webview/composer.ts` trims the end only), so an indented first line
      // is the message's own shape rather than slack to tidy up.
      sends.push({ text: said.trim(), images: [] });
      // Out of the drawn copy only, exactly as an attachment path leaves a
      // prompt: `text` above is what an echo is matched against, and the CLI
      // wrote the image into the words it recorded.
      const { prose, refs } = rendered
        ? proseImages(said, uuid, at, cwd)
        : { prose: said, refs: [] };
      images.push(...refs);
      // An empty run is not a block: the CLI writes one whenever a turn opens
      // with a tool call, and a row of nothing above it would be that. A turn
      // whose whole prose was one image lands here too, and draws its chip
      // with no empty row above it.
      if (prose.trim()) {
        parts.push(narrated ? { text: prose, summarized: true } : { text: prose });
      }
    } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
      parts.push({
        call: {
          id: typeof block.id === 'string' ? block.id : '',
          name: block.name,
          input: scrubbedInput(block.input)
        }
      });
      // Off `block.input`, which is still whole — `inputOf` above has already
      // scrubbed its copy, and that copy is all anything downstream ever sees.
      noteWrite(files, sizes, block.name, block.input, typeof cwd === 'string' ? cwd : undefined);
    } else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      // Never the same entry as the call it answers — the call rides an
      // assistant entry and this rides the next user one — so this only ever
      // stocks the map `walk` carries backwards. See `pairing` there.
      results.set(block.tool_use_id, {
        output: outputOf(block.content),
        failed: block.is_error === true
      });
    } else if (block?.type === 'image' && typeof uuid === 'string') {
      const ref = { id: `t|${uuid}|${at}` };
      images.push(ref);
      // Whatever this was pasted into: a send's own blocks stay together and
      // its words come first, so the open send is the one it belongs to. An
      // image with no words above it is a send of its own.
      const open = sends[sends.length - 1];
      if (open) {
        open.images.push(ref);
      } else {
        sends.push({ text: '', images: [ref] });
      }
    }
  }
  return {
    text: sends
      .map((s) => s.text)
      .join('\n')
      .trim(),
    blocks: parts,
    results,
    files,
    sizes,
    images,
    sends
  };
}

/**
 * Recent exchanges, oldest first; omit tool results and subagent traffic.
 * For failed reads, see parse()'s last-good rule.
 */
export async function readRecent(file: string): Promise<Recent> {
  return (await parse(file)).recent;
}

/**
 * The thread **and** every message id the same read saw — the CLI's half of the
 * comparison that decides which source the dock draws (`core/record.ts`'s
 * `drawable`).
 *
 * **One call, not two, and that is a correctness point rather than a saving.**
 * An earlier draft answered the ids from a second `parse` beside `readRecent`'s.
 * `parse` counts a failed `stat` against `HOLD_MISSES` on every call, so two
 * calls per poll climbed the counter by two and let go of a held reading after
 * ~6s where the constant's own note says ~9s — a transient burst spanning two
 * polls took the thread off screen where it previously would not have. The two
 * calls also straddled an `await`, so on a busy session the file could move
 * between them and the second did a full `widen` + `walk` again.
 *
 * The set is not a field on `Recent`: that is the product thread's shape and
 * brand-neutral, and a message id is this CLI's spelling of a thing that the
 * dock never draws.
 *
 * An unreadable or missing file answers an empty set, which is what "not found",
 * "empty" and "failed" have always been at this boundary. There is then no
 * evidence either way, and `drawable` draws the record rather than nothing.
 */
export async function readWitnessed(
  file: string
): Promise<{ recent: Recent; witnessed: ReadonlySet<string> }> {
  const parsed = await parse(file);
  return { recent: parsed.recent, witnessed: parsed.witnessed };
}

/**
 * `readWitnessed` for a reader that reads once and keeps what it read — a
 * resumed session's recovery (`core/thread.ts`). A file that is not there is
 * no history, as at the poll; **one that is there and cannot be read throws**,
 * where `parse` answers its last reading or nothing and the next poll repairs
 * that. A recovery has no next poll, so an empty answer would stand for the
 * session's life — and an empty witness set licenses our record whole.
 * Uncached, and leaves `parse`'s cache and miss count alone.
 */
export async function recoverWitnessed(file: string): Promise<{
  recent: Recent;
  witnessed: ReadonlySet<string>;
  order: readonly Witness[];
}> {
  try {
    await fs.stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { ...nothing(), order: [] };
    throw error;
  }
  const read = await widen(file);
  if (!read) throw new Error(`could not read ${path.basename(file)}`);
  return read;
}

/**
 * What a card says about a session, out of the transcript: the model that
 * answered, the effort it answered at, the context that answer cost, and the
 * title.
 *
 * Not an estimate standing in for the statusline dump — it is the dump's own
 * source, read a step earlier. Verified against a live session at one instant:
 * `total_input_tokens` 109989 = `usage` 2 + 1352 + 108635, and the dump's 11% is
 * that over its stated window.
 *
 * `tokens` is a count, never a share: `context_window_size` is stated nowhere in
 * the transcript, and guessing 200k would print `55%` for a session at 11% of a
 * million. `modelId` is what makes the share reachable — `context.windowFor`
 * keys on the id, so a size comes from a model that has been seen.
 */
export type Stats = {
  model?: string;
  /** The id as written, `[1m]` and all: the key a window size is known by. */
  modelId?: string;
  effort?: string;
  tokens?: number;
  /** A stated name outranks the titler's guess; see titleSource. */
  title?: string;
  /** Which entry `title` came from, in the CLI's own word for it. `custom-title`
   *  is a name stated by `--name` or `/rename`; `ai-title` is the titler's
   *  guess. A caller that turns this into a card's `nameSource` needs the
   *  difference: the first is a statement, the second is not. */
  titleSource?: 'custom-title' | 'ai-title';
  /** The permission mode, from the newest human turn that states one, or from
   *  the CLI's periodic snapshot when no turn in the tail does. The CLI's own
   *  word — `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions` — and
   *  passed through unmapped, so a mode we have never seen still arrives.
   *
   *  Either way this reading lags: the snapshot is written every 30s-2.5min
   *  rather than per change, and a turn states the mode only when a human types
   *  — see `docs/reference/cli_state/claude/transcript.md`. */
  permissionMode?: string;
  /** Where the session stood at its newest entry. Every entry carries it, and
   *  it is the only record that follows a session moved by anything other than
   *  a shell `cd` — the pid file's `cwd` does not, and a session that draws no
   *  status bar writes no dump to state it either. */
  cwd?: string;
};

/**
 * How much of the end to read for it. Small: the last assistant entry is what is
 * wanted, and only a final turn that pasted a megabyte of image sits further
 * back. Missing it costs a card its specs line for one turn, so nothing widens.
 */
const STATS_TAIL = 128 * 1024;

/**
 * How far back a *human turn* is chased when that tail held only a snapshot of
 * the mode. Wider because a human turn is rare by nature — a session left to run
 * writes megabytes of tool output between two prompts — and because a snapshot
 * alone is the reading that has been seen to be wrong.
 */
const MODE_TAIL = 1024 * 1024;

/**
 * The mode stated by the newest human turn within `MODE_TAIL`, or nothing. A
 * second read of a file already read, which is what preferring the honest record
 * over the near one costs. Sidechain turns state a subagent's mode, so they are
 * skipped as everywhere else here.
 */
async function readTurnMode(file: string): Promise<string | undefined> {
  const { lines } = await tail(file, MODE_TAIL);
  return scanBack(lines, '"permissionMode"', (entry) =>
    entry.type === 'user' && !entry.isSidechain && typeof entry.permissionMode === 'string'
      ? entry.permissionMode
      : undefined
  );
}

/**
 * When somebody last sent this session something, in epoch ms.
 *
 * Here rather than in its caller (`core/claude/checklist.ts`) because "what counts as a
 * prompt" is settled in this file and is not obvious: `type: "user"` is the CLI's
 * word for a tool result as much as for a person typing, and covers skill bodies,
 * expanded slash commands and interruption notices too. `origin()` is the one
 * place that knows the difference.
 *
 * A tool result is excluded by having no words at all — cheaper than matching on
 * `toolUseResult`, and it stays true if the CLI renames that field.
 *
 * Escalates like `readTurnMode` and for its reason, but pays the narrow read
 * first: the common case is a session spoken to recently.
 */
export async function readLastPromptAt(file: string): Promise<number | undefined> {
  const near = await promptAt(file, STATS_TAIL);
  return near.at !== undefined || near.whole ? near.at : (await promptAt(file, MODE_TAIL)).at;
}

async function promptAt(
  file: string,
  want: number
): Promise<{ at: number | undefined; whole: boolean }> {
  const { lines, whole } = await tail(file, want);
  const at = scanBack(lines, '"user"', (entry) => {
    if (entry.type !== 'user' || entry.isSidechain) {
      return undefined;
    }
    const { text, sends } = textOf(entry.message?.content, entry.uuid, entry.cwd);
    // No words: a tool result, or an entry carrying only an image the CLI has
    // not described. Neither is somebody asking for something.
    if (!text || origin(entry.isMeta, text) !== undefined) {
      return undefined;
    }
    // A delivery is one entry of a block per message, and only a message
    // nobody wrapped is the person's: peers and a converged wait asked nothing.
    const theirs = sends.some((send) => {
      const said = delivered(send.text);
      return said.role === 'user' && said.from === undefined && said.text.trim() !== '';
    });
    return theirs ? stampedAt(entry.timestamp) : undefined;
  });
  return { at, whole };
}

/**
 * The newest answer's stats and the newest title.
 *
 * Cached on `size:mtimeMs` like `parse()`, for a sharper reason: this runs for
 * **every** card, every poll, in every window, where the thread's read runs for
 * one. It was uncached on the reading that the read is a page-cache hit — true,
 * and not where the time went. Measured 2026-08-04 over eight sessions: `stat`
 * 0.6ms, whole call 16ms. The bytes are free and decoding them is not, so the
 * stamp saves the `toString`, the `split` and the parse of every candidate line.
 *
 * A failed read is neither remembered nor allowed to unseat what is — see
 * `parse()` for the rule, and `tail`'s `ok` for what tells the two apart. Handed
 * out as held, on the same do-not-write terms.
 *
 * Sidechains are skipped: a subagent's context is not the session's. One pass for
 * both fields, running past the newest answer rather than returning at it,
 * because an `ai-title` entry sits wherever the CLI last retitled.
 */
export async function readStats(file: string): Promise<Stats | undefined> {
  let stamp: string;
  try {
    const { size, mtimeMs } = await fs.stat(file);
    stamp = `${size}:${mtimeMs}`;
  } catch {
    // `parse()`'s rule, and read at the point of failure for its reason.
    return statsCache.get(file)?.stats;
  }

  const hit = statsCache.get(file);
  if (hit?.stamp === stamp) {
    return hit.stats;
  }

  const { stats, ok } = await scanStats(file);
  if (!ok) {
    return statsCache.get(file)?.stats;
  }
  statsCache.set(file, { stamp, stats });
  return stats;
}

/** One entry per drawn transcript, for the panel's lifetime. */
const statsCache = new Map<string, { stamp: string; stats: Stats | undefined }>();

/** Keep ok separate so a failed read cannot be cached as an empty result. */
async function scanStats(file: string): Promise<{ stats: Stats | undefined; ok: boolean }> {
  const { lines, ok } = await tail(file, STATS_TAIL);
  const stats: Stats = {};
  let answered = false;
  /** Hold the snapshot mode until no human turn states one; see below. */
  let snapshotMode: string | undefined;
  /**
   * The titler's guess, held back the way `snapshotMode` is: it is the answer
   * only once the pass has proved no stated name sits behind it.
   *
   * A newest-wins scan cannot arbitrate these, because the CLI restamps *both*
   * as the conversation turns and writes `ai-title` last — so a session
   * somebody renamed goes on reading as the guess it was renamed away from,
   * which is what `conversations.ts` already says about the same two entries.
   * `stats.title` is therefore set only by a `custom-title`, and finding one
   * ends the search: a stated name outranks every guess, at any distance.
   *
   * The cost is that a session nobody named scans the whole tail rather than
   * stopping at its newest `ai-title`. Cheap, and paid deliberately: by then
   * every other field is found, so the loop is one `includes` per line over a
   * 128 KiB buffer already in memory, and no line is parsed. Stopping a fixed
   * number of lines after the guess was the alternative and it does not hold —
   * measured 2026-08-25 over this machine's 1940 transcripts stating a title,
   * 88 carry both entries, and of the 44 whose `ai-title` is newest the
   * `custom-title` is one line back in 43 and **21 lines back** in the last.
   */
  let generated: string | undefined;
  const done = () => answered && stats.title !== undefined && stats.permissionMode !== undefined;
  for (let i = lines.length - 1; i >= 0 && !done(); i--) {
    const line = lines[i] ?? '';
    // Cheap reject first: most lines are tool results, and parsing one of them
    // is parsing a megabyte to learn it was never a candidate. Each part of it
    // stops mattering once that part has been found.
    const candidate =
      (!answered && line.includes('"usage"')) ||
      (stats.title === undefined && line.includes('"customTitle"')) ||
      (generated === undefined && line.includes('"aiTitle"')) ||
      (stats.permissionMode === undefined && line.includes('"permissionMode"'));
    if (!candidate) {
      continue;
    }
    const entry = parsed(line);
    if (entry === undefined) {
      continue;
    }
    // Where the session stands, off whichever entry this pass already had a
    // reason to open — so it costs nothing, and never parses a megabyte of tool
    // output to learn a directory. A sidechain's is a subagent's, which for a
    // worktree-isolated one is not the session's at all.
    if (stats.cwd === undefined && !entry.isSidechain && typeof entry.cwd === 'string') {
      stats.cwd = entry.cwd;
    }
    // Two records state the mode; the human turn wins however the file orders
    // them — the source is the test, not position. Observed on 2.1.220: a
    // session resumed under `--dangerously-skip-permissions` keeps writing
    // `permission-mode: auto` while its every turn says `bypassPermissions`.
    // The snapshot is what the CLI stored, the turn is what it acted under.
    //
    // The snapshot still earns its read: it is all a session with no prompt near
    // the end of the tail has, and all a session one turn in has at all.
    if (stats.permissionMode === undefined && typeof entry?.permissionMode === 'string') {
      if (entry.type === 'user' && !entry.isSidechain) {
        stats.permissionMode = entry.permissionMode;
      } else if (entry.type === 'permission-mode' && snapshotMode === undefined) {
        snapshotMode = entry.permissionMode;
      }
    }
    // Scanning backwards, the first one seen is the newest, and the CLI rewrites
    // both as the conversation turns. An empty one is no title.
    if (entry?.type === 'ai-title') {
      if (generated === undefined && typeof entry.aiTitle === 'string' && entry.aiTitle) {
        generated = entry.aiTitle;
      }
      continue;
    }
    if (entry?.type === 'custom-title') {
      if (typeof entry.customTitle === 'string' && entry.customTitle) {
        stats.title = entry.customTitle;
        stats.titleSource = 'custom-title';
      }
      continue;
    }
    // A turn the CLI wrote in the model's place names no model and answered at
    // no effort. Left in, `modelName` would pass `<synthetic>` through unchanged
    // and a card would print it as the model that answered.
    if (
      answered ||
      entry?.type !== 'assistant' ||
      entry.isSidechain ||
      entry.message?.model === SYNTHETIC
    ) {
      continue;
    }
    // The three the dump adds up as `total_input_tokens`, and not the output
    // tokens, which the CLI counts against the window separately. A figure
    // that is missing or is not one counts as nothing, so a usage block the
    // CLI wrote down in some other shape still reads as far as it goes.
    const usage = entry.message?.usage;
    const tokens =
      (Number(usage?.input_tokens) || 0) +
      (Number(usage?.cache_creation_input_tokens) || 0) +
      (Number(usage?.cache_read_input_tokens) || 0);
    const id: unknown = entry.message?.model;
    stats.model = modelName(id);
    stats.modelId = typeof id === 'string' ? id : undefined;
    stats.effort = typeof entry.effort === 'string' ? entry.effort : undefined;
    stats.tokens = tokens || undefined;
    answered = true;
  }
  // A snapshot and no turn is exactly the reading that has been seen to be a
  // resumed session's stale one, so it is worth one wider read before settling
  // for it. Nothing to chase when the file states no mode at all: a session
  // whose every mode record is further back than 128KB does not exist — the CLI
  // writes one every couple of minutes.
  if (stats.permissionMode === undefined && snapshotMode !== undefined) {
    stats.permissionMode = (await readTurnMode(file)) ?? snapshotMode;
  }
  // The guess gets what no stated name claimed, which is most sessions: the
  // titler names every conversation and only a `--name` or a `/rename` writes
  // the other entry.
  if (stats.title === undefined && generated !== undefined) {
    stats.title = generated;
    stats.titleSource = 'ai-title';
  }
  const found =
    answered ||
    stats.title !== undefined ||
    stats.permissionMode !== undefined ||
    stats.cwd !== undefined;
  return { stats: found ? stats : undefined, ok };
}

/**
 * A model id as the dump would have displayed it: `claude-opus-5` -> `Opus 5`,
 * `claude-haiku-4-5-20251001` -> `Haiku 4.5`. Any other shape is shown as it is —
 * a card saying `claude-3-5-sonnet` is honest where a guess is not.
 *
 * The `[1m]` goes: the window is shown beside the percentage already.
 */
function modelName(id: unknown): string | undefined {
  if (typeof id !== 'string' || !id) {
    return undefined;
  }
  const [, family = '', version = ''] =
    /^claude-(fable|opus|sonnet|haiku)-(\d+(?:-\d+)?)(?:-\d{8})?(?:\[1m\])?$/.exec(id) ?? [];
  if (!family) {
    return id;
  }
  return family.charAt(0).toUpperCase() + family.slice(1) + ' ' + version.replace(/-/g, '.');
}

/**
 * Remove the Skill call already represented by a chip. Do this after the walk:
 * the backward scan has not read the invoking turn when it creates the chip.
 */
function unduplicateSkill(exchanges: Exchange[]): void {
  for (let i = 0; i < exchanges.length; i++) {
    const chip = exchanges[i];
    if (!chip || !isMarker(chip) || chip.mark !== 'skill') {
      continue;
    }
    let at = i + 1;
    for (let next = exchanges[at]; next && isMarker(next); next = exchanges[at]) {
      at++;
    }
    const caller = exchanges[at];
    if (!caller || isMarker(caller) || !caller.blocks) {
      continue;
    }
    const found = caller.blocks.findIndex((b) => 'call' in b && b.call.name === 'Skill');
    if (found < 0) {
      continue;
    }
    caller.blocks.splice(found, 1);
    if (!caller.blocks.length) {
      delete caller.blocks;
    }
  }
}

/**
 * `MAX_TURNS` measured against *this* reader, 2026-08-04 over the 1799
 * transcripts here — and the measurement says what the cap is *not*: on the ten
 * largest it binds on nothing, 100 and 400 both averaging 23.8 turns, because
 * those files are large from tool payloads and `MAX_TAIL_BYTES` runs out first.
 * It binds in the middle: a 3.3MB prose-heavy session showed 100 turns of 194,
 * now all 194.
 *
 * Free here, because the walk is over lines the tail already read — cold parse
 * over the ten largest was unchanged (61.4ms -> 59.9ms) and the cache retains
 * ~6KB per exchange. Raising it is not what buys more history on this side;
 * `MAX_TAIL_BYTES` is, and it costs a ~300MB transient peak. See
 * `docs/tasks/taskhub_notes.md` §H42.
 */
function walk(lines: string[]): {
  exchanges: Exchange[];
  /** capped means MAX_TURNS stopped the walk with lines left; widening cannot lift it. */
  capped: boolean;
  witnessed: Set<string>;
  order: Witness[];
} {
  const state: WalkState = {
    exchanges: [],
    witnessed: new Set(),
    ends: [],
    noted: [],
    body: undefined,
    authored: 0,
    pairing: new Map()
  };
  let i = lines.length - 1;

  // Deliberately parses every line, however long. A half-megabyte line is often
  // a turn the user typed with an image pasted into it, so skipping on length
  // would take those prompts out of the thread.
  for (; i >= 0 && state.authored < MAX_TURNS; i--) {
    const entry = parsed(lines[i] ?? '');
    if (!entry || entry.isSidechain) continue;

    // A slash command's own answer, which is a turn nothing else here would
    // find: the CLI writes no assistant entry for one at all.
    if (entry.type === 'system') {
      const said = localCommand(entry);
      if (said) {
        state.exchanges.push(localReply(said, stampedAt(entry.timestamp)));
        state.authored++;
      }
      continue;
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;

    const message = projectMessage(entry, entry.type);
    if (message.key !== undefined) {
      if (!state.witnessed.has(message.key)) {
        state.ends.push({ key: message.key, after: state.exchanges.length });
      }
      state.witnessed.add(message.key);
    }
    const ran = pairResults(state.pairing, message.content, entry.toolUseResult);
    const { text, images } = message.content;
    // A user turn with no text is a tool result being fed back, not a prompt —
    // unless it carries an image, which is a prompt of the wordless kind.
    if (!text && !images.length && (message.role === 'user' || !ran)) continue;
    if (message.role === 'user' && consumeUserEntry(state, message, i) === 'consumed') continue;
    state.body = undefined;
    if (mergeTools(state.exchanges, message.content) === 'merged') continue;
    appendSends(state, message);
  }

  const { exchanges, witnessed, ends } = state;
  let sawWarm = false;
  for (const x of [...exchanges].reverse()) {
    if ('mark' in x) continue;
    sawWarm ||= x.role === 'warm';
    if (sawWarm && x.role === 'assistant') x.maintenance = false;
  }
  unduplicateSkill(exchanges);

  // Treat leftover lines as older history without checking for drawable turns;
  // understating it would invent a beginning.
  return {
    exchanges: exchanges.reverse(),
    capped: i >= 0,
    witnessed,
    order: opening(ends, exchanges.length)
  };
}

type WalkState = {
  exchanges: Exchange[];
  /** See `Parsed.witnessed`. Filled from every assistant entry the walk keeps,
   *  turn or no turn — a message of nothing but `thinking` still happened, and
   *  the tee stamps one for it too. `<synthetic>` is the exception, below. */
  witnessed: Set<string>;
  /** Each key where the backward walk first meets it — its message's last
   *  entry — and how many rows it had walked by then. */
  ends: { key: string; after: number }[];
  /** Dimensions from notes met but not yet claimed, in the file's own order. */
  noted: { w: number; h: number }[];
  /**
   * The skill body last met, and the chip it produced if it produced one.
   *
   * A typed `/name` writes two entries — the command, then the body it expanded
   * to — and which names the skill depends on the skill. Either way the command
   * entry sits directly above the body, and meeting it is the only proof the
   * reader typed this. Adjacency is the whole claim.
   */
  body: { at: number; chip?: Marker } | undefined;
  /** Count authored turns, not markers, so skills do not reduce visible conversation. */
  authored: number;
  /**
   * Results met but not yet claimed, by `tool_use_id`. Every result here names
   * one — 2531 of 2531 over 60 transcripts, 2026-07-29 — so pairing is a lookup
   * rather than the label-matching a live adapter needs. Dies with the walk;
   * what is left is results whose calls sat further back than this read went.
   */
  pairing: Map<string, Returned>;
};

type MessageProjection = {
  content: ReturnType<typeof textOf>;
  role: 'user' | 'assistant' | 'cli';
  isMeta: unknown;
  when: number | undefined;
  key: string | undefined;
  skill: string | undefined;
};

function projectMessage(entry: Entry, type: 'user' | 'assistant'): MessageProjection {
  // The model did not write a `<synthetic>` turn — the CLI did, in its place.
  // It is still an author, which is why this is a role and not a kind of non-turn.
  const synthetic = entry.message?.model === SYNTHETIC;
  return {
    content: textOf(entry.message?.content, entry.uuid, entry.cwd, type !== 'user'),
    role: type === 'assistant' && synthetic ? 'cli' : type,
    isMeta: entry.isMeta,
    // What the fold measures a turn's length between. Every entry the CLI
    // writes carries one; a turn missing it is simply never measured.
    when: stampedAt(entry.timestamp),
    key:
      type === 'assistant' && typeof entry.message?.id === 'string' && !synthetic
        ? entry.message.id
        : undefined,
    skill:
      type === 'assistant' && typeof entry.attributionSkill === 'string'
        ? entry.attributionSkill
        : undefined
  };
}

function pairResults(
  pairing: Map<string, Returned>,
  { results, blocks }: MessageProjection['content'],
  toolUseResult: unknown
): boolean {
  // The walk runs backwards, so every result is met before the call it
  // answers. Held by id until that call turns up, and dropped into it there.
  //
  // An answered ask's record rides the entry rather than the block, so it can
  // only be attached where the entry is still in scope — and only when the
  // entry carries exactly one result, since one `toolUseResult` cannot say
  // which of two calls it belongs to. **Measured 2026-08-12: 0 of 89,285 tool-result
  // entries carry more than one block**, so this has never fired; it is one
  // condition against a mis-attribution nothing downstream could detect.
  const record = results.size === 1 ? parseAnswered(toolUseResult) : undefined;
  for (const [id, returned] of results) {
    pairing.set(id, record ? { ...returned, ask: record } : returned);
  }
  let ran = false;
  for (const block of blocks) {
    if (!('call' in block)) {
      continue;
    }
    ran = true;
    const returned = pairing.get(block.call.id);
    if (!returned) {
      // A call whose result the window never reached, or one still running —
      // 2 of 2533 at any moment. Either way it has no output rather than an
      // empty one, which is the difference between "waiting" and "said
      // nothing".
      continue;
    }
    pairing.delete(block.call.id);
    if (returned.output !== undefined) {
      block.call.output = returned.output;
    }
    if (returned.failed) {
      block.call.failed = true;
    }
    if (returned.ask) {
      block.call.ask = returned.ask;
    }
  }
  return ran;
}

function consumeUserEntry(
  state: WalkState,
  message: MessageProjection,
  index: number
): 'consumed' | 'turn' {
  const { text, sends, images } = message.content;
  const what = origin(message.isMeta, text);
  if (what?.as === 'mark') {
    // Assume agent invocation until the adjacent command entry proves it was typed.
    const chip: Marker = { mark: what.mark, skill: what.skill };
    if (what.mark === 'skill') {
      chip.by = 'agent';
      state.body = { at: index, chip };
    }
    state.exchanges.push(chip);
    return 'consumed';
  }
  if (what && what.as !== 'authored') {
    // The CLI's note about an attached image is the only record of how big it
    // was. Dropped from the thread, kept for the chip: it is written after the
    // prompt it belongs to and so met before it, with the whole read of the
    // file in between, which is why this outlives more than one turn.
    if (what.note) {
      state.noted.unshift(what.note);
    }
    // A command entry is the reader's own turn, and the only place its name
    // is written down. A skill body directly below it already has a chip, so
    // that one only learns who asked; anything else — a built-in's answer, a
    // caveat, nothing at all — gets a chip of its own.
    //
    // Not `state.body?.at === index + 1` for both halves: that is the
    // skill-body shape and no other. A built-in's caveat sits *above* the command
    // entry and its answer below, so `/model` and `/clear` were dropped whole
    // (verified on disk 2026-08-07, `sdk-cli`).
    if (what.command) {
      if (state.body?.at === index + 1 && state.body.chip) {
        state.body.chip.by = 'you';
      } else {
        state.exchanges.push({ mark: 'skill', skill: what.command, by: 'you' });
      }
    }
    state.body = what.residual ? { at: index } : undefined;
    return 'consumed';
  }
  // A path the CLI will read as an attachment is an image on this turn too,
  // and the one shape whose bytes are also a file on disk. Attributed per
  // send rather than per entry, so a batched pile does not collect every
  // picture anybody named onto whichever of them is drawn first.
  for (const send of sends) {
    for (const file of imagePathsIn(send.text)) {
      const ref = { ...state.noted.shift(), id: `p|${file}` };
      images.push(ref);
      send.images.push(ref);
    }
  }
  state.noted.length = 0;
  return 'turn';
}

function mergeTools(
  exchanges: Exchange[],
  { text, images, blocks, files, sizes }: MessageProjection['content']
): 'merged' | 'separate' {
  // Merge tool-only turns to give folds a contiguous run. Keep image turns
  // separate, however wordless, or the picture would be lost.
  const previous = exchanges[exchanges.length - 1];
  if (
    !text &&
    !images.length &&
    previous &&
    !isMarker(previous) &&
    previous.role === 'assistant' &&
    !previous.text
  ) {
    // Prepend older blocks; keep at as the newest entry's finish time.
    if (blocks.length) {
      previous.blocks = [...blocks, ...(previous.blocks ?? [])];
    }
    // The files go where their tools go, or the 77.6% of writing turns that
    // are exactly this shape — one wordless entry per call — would lose every
    // path as the entries fold together. Deduped again on the way in: the
    // merge is what brings two entries writing one file into one turn.
    if (files.length) {
      previous.files = [...new Set([...files, ...(previous.files ?? [])])];
    }
    for (const [file, written] of Object.entries(sizes)) {
      previous.sizes ??= {};
      addWritten(previous.sizes, file, written);
    }
    return 'merged';
  }

  return 'separate';
}

function appendSends(state: WalkState, message: MessageProjection): void {
  const { role, skill } = message;
  const { text, images, sends, blocks, files, sizes } = message.content;
  // Split batched user sends; keep model blocks as one answer. Push newest first.
  const batch = role === 'user' && sends.length > 1;
  const turns: Send[] = batch ? sends : [{ text, images }];
  for (let at = turns.length - 1; at >= 0; at--) {
    const turn = turns[at];
    if (!turn) {
      continue;
    }
    // Per send rather than per entry, because a batch is where the two kinds
    // meet: a message we delivered ahead of a row the reader was holding
    // arrives as one entry with a send each, and only one of them has an
    // author to name.
    // A resolved wait and a warming ping are `user` entries on disk — each
    // entered the CLI as a prompt like any other — and nobody composed
    // either, so each overrides the entry's role and takes no `from`.
    const said = role === 'user' ? delivered(turn.text) : undefined;
    const unwrapped =
      said && (said.role !== 'user' || said.from !== undefined) ? said.text : undefined;
    state.exchanges.push({
      role: said?.role ?? role,
      text: unwrapped ?? turn.text,
      from: said?.from,
      // A batch turn takes its own words, not the entry's combined blocks.
      blocks: unwrapped
        ? [{ text: unwrapped }]
        : batch
          ? turn.text
            ? [{ text: turn.text }]
            : undefined
          : blocks.length
            ? blocks
            : undefined,
      at: message.when,
      // Attribute files to the first turn, reached last in this backward walk.
      files: at === 0 && files.length ? files : undefined,
      sizes: at === 0 && Object.keys(sizes).length ? sizes : undefined,
      images: turn.images.length ? turn.images : undefined,
      skill
    });
    state.authored++;
  }
}

/**
 * The key names an assistant message, so its exchange is every row after the
 * message before it, up to its own last: the prompt it answers among them.
 */
function opening(ends: readonly { key: string; after: number }[], rows: number): Witness[] {
  const forward = [...ends].reverse();
  return forward.map(({ key }, at) => ({ key, from: rows - (forward[at - 1]?.after ?? rows) }));
}

/**
 * The bytes behind an `ImageRef` this CLI's own file is holding, as a data URL
 * — `CliAdapter.readImage`. Runs on a click and never on a poll, which is what
 * makes the widest tail and a second walk affordable; both walks skip on a
 * substring before parsing.
 *
 * `t|<uuid>|<block>` is the scheme this answers and no other module mints: an
 * image pasted into the CLI's own TUI rides inside the turn, as a block beside
 * the words, addressed by the entry's `uuid` and its place in the block list —
 * stable for an append-only file, and by nothing else, so an entry the CLI
 * wrote without a `uuid` yields no ref at all rather than one that cannot be
 * resolved later. `p|` is answered too, for the bytes of a file this CLI read
 * back and re-encoded; `f|` and `r|` are `refFile` and `attachmentFile`'s,
 * resolve off disk, and never reach here.
 *
 * The media type comes from the transcript, never the path: the CLI re-encodes
 * as it reads, and a `.png` on disk is written down as `image/jpeg` often enough
 * that trusting the extension would mislabel it.
 */
export async function readImage(file: string, id: string): Promise<string | undefined> {
  const [kind, ...rest] = id.split('|');
  const { lines } = await tail(file, MAX_TAIL_BYTES);

  if (kind === 't') {
    const uuid = rest[0] ?? '';
    const at = Number(rest[1]);
    return scanBack(lines, uuid, (entry) =>
      entry.uuid === uuid ? urlOf(blocksOf(entry)[at]) : undefined
    );
  }

  if (kind !== 'p') return undefined;
  // The path names a file the CLI read, so its bytes are whatever that `Read`
  // returned — found by matching the call, then the result that answered it.
  const wanted = rest.join('|');
  return scanBack(lines, wanted, (entry, i) => {
    const call = blocksOf(entry).find(
      (b) => b.type === 'tool_use' && b.input?.file_path === wanted
    );
    const callId = call?.id;
    if (typeof callId !== 'string') return undefined;
    // Forwards from the call, since a result is written after the call it
    // answers — the one scan in this file that does not run backwards.
    for (let j = i + 1; j < lines.length; j++) {
      const answer = lines[j] ?? '';
      if (!answer.includes(callId)) continue;
      const result = blocksOf(parsed(answer)).find((b) => b.tool_use_id === callId);
      const url = (Array.isArray(result?.content) ? result.content : []).map(urlOf).find(Boolean);
      if (url) return url;
    }
    return undefined;
  });
}

/** External fields stay unknown; each reader must narrow them before use. */
type Entry = {
  type?: unknown;
  /** Only read on a `system` entry, where it says which kind it is. */
  subtype?: unknown;
  /** A `system` entry's own words, which live here rather than under `message`
   *  — the CLI writes no `message` on one at all. */
  content?: unknown;
  uuid?: unknown;
  cwd?: unknown;
  timestamp?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  permissionMode?: unknown;
  aiTitle?: unknown;
  /** A `custom-title` entry's name — what `--name` was given, or what `/rename`
   *  last set. `conversations.ts` reads its own copy of this. */
  customTitle?: unknown;
  effort?: unknown;
  attributionSkill?: unknown;
  /** What the tool returned, structured — beside `message.content`'s rendering
   *  of the same thing for the model. Every tool result carries one; only an
   *  `AskUserQuestion`'s parses as a record (`core/claude/asks.ts`). */
  toolUseResult?: unknown;
  message?: {
    content?: unknown;
    model?: unknown;
    /** The API's own id for the message. Present on 5175 of 5175 assistant
     *  entries here, and shared by the two entries the CLI splits a message
     *  that spoke and then called a tool across. See `Parsed.witnessed`. */
    id?: unknown;
    /** The CLI's own spellings, and the three the dump adds up. */
    usage?: {
      input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
      cache_read_input_tokens?: unknown;
    };
  };
};
type RawBlock = {
  type?: unknown;
  id?: unknown;
  input?: { file_path?: unknown };
  tool_use_id?: unknown;
  content?: unknown;
  source?: { data?: unknown; media_type?: unknown };
};

/**
 * An entry's own stamp as epoch ms, or nothing — which is what a turn the CLI
 * stamped with something other than a time reads as, the same as one it stamped
 * with nothing. Only a string is tried: `Date.parse` of anything else is the
 * host's guess about a shape no CLI has written.
 */
function stampedAt(value: unknown): number | undefined {
  const at = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(at) ? at : undefined;
}

function parsed(line: string): Entry | undefined {
  try {
    return JSON.parse(line) as Entry;
  } catch {
    return undefined;
  }
}

/**
 * The newest entry, scanning back from the end of a tail, that states `needle`
 * and that `pick` can read something out of. Nothing when none does.
 *
 * The `includes` prefilter is the whole shape and not tidiness: most lines in a
 * transcript are tool results, and parsing one of those is parsing a megabyte
 * to learn it was never a candidate. `pick` returning nothing keeps the scan
 * going, so a line that carries the word without meaning it — a needle quoted
 * inside somebody's prompt — costs a parse and no more.
 *
 * `readStats` is deliberately not written on this: it reads three fields at
 * once off whichever lines any of them might be on, and stops when it has them
 * all rather than at the first thing it can use.
 */
function scanBack<T>(
  lines: string[],
  needle: string,
  pick: (entry: Entry, index: number) => T | undefined
): T | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (!line.includes(needle)) {
      continue;
    }
    const entry = parsed(line);
    if (!entry) {
      continue;
    }
    const found = pick(entry, i);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function blocksOf(entry: Entry | undefined): RawBlock[] {
  const content = entry?.message?.content;
  return Array.isArray(content) ? (content as RawBlock[]) : [];
}

function urlOf(block: RawBlock | undefined): string | undefined {
  const source = block?.type === 'image' ? block.source : undefined;
  return typeof source?.data === 'string' && typeof source?.media_type === 'string'
    ? `data:${source.media_type};base64,${source.data}`
    : undefined;
}
