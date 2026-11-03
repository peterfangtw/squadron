/**
 * Grok `_x.ai/ask_user_question` → product questions, and `Decision` → the
 * `accepted` reply 1.0.4 takes.
 *
 * Observed 2026-08-16: inbound questions use camelCase `multiSelect` (the
 * streaming delta uses `multi_select`); answers are keyed by the full question
 * text — a string for one pick or own words, an array for multi-select.
 * `docs/reference/cli_state/grok/protocol.md`.
 */

import { answerPayload } from '../answers';
import type { Decision } from '../model';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseQuestion(raw: unknown): PendingQuestion | undefined {
  if (!isRecord(raw) || typeof raw.question !== 'string') {
    return undefined;
  }
  const options: QuestionOption[] = [];
  if (Array.isArray(raw.options)) {
    for (const option of raw.options) {
      if (!isRecord(option) || typeof option.label !== 'string') {
        continue;
      }
      options.push({
        label: option.label,
        description: typeof option.description === 'string' ? option.description : undefined,
        preview: typeof option.preview === 'string' ? option.preview : undefined
      });
    }
  }
  if (!options.length) {
    return undefined;
  }
  return {
    question: raw.question,
    header: typeof raw.header === 'string' ? raw.header : undefined,
    multiSelect: raw.multiSelect === true || raw.multi_select === true,
    options
  };
}

/** Product questions, or nothing. One unparseable row drops the whole ask. */
export function parseAsk(params: unknown): PendingQuestion[] {
  if (!isRecord(params) || !Array.isArray(params.questions) || !params.questions.length) {
    return [];
  }
  const out: PendingQuestion[] = [];
  for (const raw of params.questions) {
    const parsed = parseQuestion(raw);
    if (!parsed) {
      return [];
    }
    out.push(parsed);
  }
  return out;
}

/** The JSON-RPC result body 1.0.4 accepts. Absent when this sitting cannot
 *  send the decision (deny / notes-only). */
export function acceptedPayload(
  questions: PendingQuestion[],
  decision: Decision
): { outcome: 'accepted'; answers: Record<string, string | string[]> } | undefined {
  if (!decision.allow) {
    return undefined;
  }
  const answers = answerPayload(questions, decision.picks ?? [], decision.texts ?? []);
  return Object.keys(answers).length ? { outcome: 'accepted', answers } : undefined;
}
