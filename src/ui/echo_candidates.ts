import { withoutImageMarkers } from '../core/markers';
type EchoExchange =
  { mark: string; by?: 'you' | 'agent'; skill?: string } | { role: string; text: string };

export type EchoCandidate = { key: string; text?: string; skill?: string };

/** Retain the existing observation window while the displayed page is smaller. */
export function evidence(exchanges: readonly EchoExchange[]): EchoEvidence[] {
  return exchanges.flatMap((exchange): EchoEvidence[] =>
    'mark' in exchange
      ? exchange.by === 'you' && exchange.skill
        ? [{ skill: exchange.skill }]
        : []
      : exchange.role === 'user'
        ? [{ text: exchange.text }]
        : []
  );
}

export function candidates(thread: ThreadView): EchoCandidate[] {
  return [
    ...(thread.echoEvidence ?? evidence(thread.exchanges)),
    ...(thread.queued ?? []).map((row) => ({ text: row.text })),
    ...(thread.sending ?? []).map((row) => ({ text: row.text }))
  ].map((entry) =>
    'skill' in entry
      ? { key: `skill:${entry.skill}`, skill: entry.skill }
      : { key: `text:${withoutImageMarkers(entry.text).trim()}`, text: entry.text }
  );
}
