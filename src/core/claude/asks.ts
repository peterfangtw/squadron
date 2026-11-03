/**
 * The questions inside an `AskUserQuestion`, narrowed field by field.
 *
 * The input comes off the session's own pipe as a control request, from a
 * program this repo does not own, so every field is checked and anything
 * unrecognisable degrades to "no question" rather than to a half-rendered one.
 *
 * This file used to read the dialog hook's overlay too — a pending ask written
 * to `~/.claude/statuses/<id>.ask.json` by `PreToolUse`, which was the only way
 * to see a question a session in a terminal was blocked on. Nothing answers one
 * of those from here any more, so nothing reads the overlay.
 *
 * The other half is `parseAnswered`, which reads the same questions back off a
 * transcript once somebody has answered them. Same narrowing, different source:
 * the pipe for one that is still open, `toolUseResult` for one that is not.
 */

import type { AnsweredAsk } from '../transcript';

/**
 * The questions out of one `AskUserQuestion` input; any with no options is
 * dropped, since there is nothing there to pick.
 *
 * Shape comes from the ambient `PendingQuestion` (protocol.d.ts), so the one
 * definition serves discovery, the host, and the webview alike.
 */
export function parseQuestions(input: unknown): PendingQuestion[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const out: PendingQuestion[] = [];
  for (const q of input as {
    question?: unknown;
    header?: unknown;
    multiSelect?: unknown;
    options?: unknown;
  }[]) {
    if (typeof q?.question !== 'string') {
      continue;
    }
    const options = Array.isArray(q.options)
      ? (q.options as { label?: unknown; description?: unknown; preview?: unknown }[])
          .filter(
            (o): o is { label: string; description?: unknown; preview?: unknown } =>
              typeof o?.label === 'string'
          )
          .map((o) => ({
            label: o.label,
            description: typeof o.description === 'string' ? o.description : undefined,
            preview: typeof o.preview === 'string' ? o.preview : undefined
          }))
      : [];
    if (!options.length) {
      continue;
    }
    out.push({
      question: q.question,
      header: typeof q.header === 'string' ? q.header : undefined,
      multiSelect: q.multiSelect === true,
      options
    });
  }
  return out;
}

/**
 * The record on a `toolUseResult`, or nothing if it is not one of these.
 *
 * Every tool result carries this field — a `Read`'s file record, a `Bash`'s
 * output — so this runs against all of them and is expected to yield nothing
 * for most: the shape is the test, never the tool's name.
 *
 * Observed 2026-08-12 over 863 answered asks in `~/.claude/projects`: the keys
 * are `questions`, `answers` and `annotations`, and an **annotation is not only
 * a note** — of 166, 116 carry the CLI's own `preview` echo of the picked
 * option's sample and 50 carry `notes`. Only the note was typed by a reader, so
 * only the note is kept; the preview is already on the option it belongs to.
 *
 * Nothing caps this, here or below: `parseQuestions` narrows a question's
 * *shape* and drops what does not fit it, but counts neither the questions nor
 * their options — the pipe's asks are unbounded the same way, and a dialog
 * drawn from one already carries whatever the CLI sent. What that costs a
 * record it does not cost the pipe is that this rides every thread push, so the
 * survey above is the ceiling to watch rather than a guarantee: the longest
 * preview in those 863 was 854 chars. A record far past that is the reason to
 * cap, and none has turned up.
 */
export function parseAnswered(value: unknown): AnsweredAsk | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const record = value as { questions?: unknown; answers?: unknown; annotations?: unknown };
  const questions = parseQuestions(record.questions);
  // Nothing to draw, or nothing to mark on it. A record whose questions all
  // dropped is not a partial replay, it is not a replay.
  if (!questions.length || record.answers === null || typeof record.answers !== 'object') {
    return undefined;
  }
  const answers: Record<string, string | string[]> = {};
  for (const [key, given] of Object.entries(record.answers as Record<string, unknown>)) {
    if (typeof given === 'string') {
      answers[key] = given;
    } else if (Array.isArray(given)) {
      answers[key] = given.filter((one): one is string => typeof one === 'string');
    }
  }
  const annotations: Record<string, { notes?: string }> = {};
  if (record.annotations !== null && typeof record.annotations === 'object') {
    for (const [key, note] of Object.entries(record.annotations as Record<string, unknown>)) {
      const notes = (note as { notes?: unknown } | null)?.notes;
      if (typeof notes === 'string' && notes) {
        annotations[key] = { notes };
      }
    }
  }
  return { questions, answers, annotations };
}
