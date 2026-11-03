import type { TurnOutcome } from './events';
import type { LiveState, QueuedMessage } from './live';

export type MessagePhase = 'queued' | 'processing' | 'done' | 'unsuccessful' | 'unknown';

export type MessageTerminalFact = {
  correlation: string;
  phase: 'done' | 'unsuccessful';
  dismissed?: true;
};

export type MessageFact = { correlation: string; phase: MessagePhase; dismissed?: true };

export const MESSAGE_FACTS_KEPT = 256;

export function isCorrelation(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && (code < 127 || code > 159);
    })
  );
}

export function readMessageFacts(value: unknown): readonly MessageFact[] | undefined {
  if (!Array.isArray(value) || value.length > MESSAGE_FACTS_KEPT) return undefined;
  const facts: MessageFact[] = [];
  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== 'object') return undefined;
    const fact = entry as Partial<MessageFact>;
    if (!isCorrelation(fact.correlation) || !isPhase(fact.phase) || seen.has(fact.correlation))
      return undefined;
    seen.add(fact.correlation);
    if (fact.dismissed !== undefined && (fact.dismissed !== true || fact.phase !== 'unsuccessful'))
      return undefined;
    facts.push({
      correlation: fact.correlation,
      phase: fact.phase,
      ...(fact.dismissed ? { dismissed: true } : {})
    });
  }
  return facts;
}

export function correlations(message: QueuedMessage | undefined): readonly string[] {
  if (!message || message.warm || message.command) return [];
  return [
    ...new Set(
      (message.parts ?? [message]).flatMap((part) =>
        isCorrelation(part.correlation) ? [part.correlation] : []
      )
    )
  ];
}

export function phaseOf(outcome: TurnOutcome | undefined): MessagePhase {
  return outcome === 'done' ? 'done' : outcome === undefined ? 'unknown' : 'unsuccessful';
}

export function update(
  state: LiveState,
  tokens: readonly string[],
  phase: MessagePhase,
  dismissed?: true
): LiveState {
  if (tokens.length === 0) return state;
  const facts = [...(state.messageFacts ?? [])];
  const finality = new Map<string, MessageTerminalFact>();
  for (const fact of [...(state.messageFinality ?? []), ...facts]) {
    if (terminal(fact) && (!finality.has(fact.correlation) || fact.dismissed))
      finality.set(fact.correlation, fact);
  }
  let changed = false;
  for (const correlation of tokens) {
    const index = facts.findIndex((fact) => fact.correlation === correlation);
    const old = facts[index];
    if (dismissed && old?.phase === 'unsuccessful' && !old.dismissed) {
      const fact: MessageTerminalFact = { ...old, phase: 'unsuccessful', dismissed: true };
      facts[index] = fact;
      finality.set(correlation, fact);
      changed = true;
      continue;
    }
    if (old?.phase === phase || old?.phase === 'done' || old?.phase === 'unsuccessful') continue;
    const fact = finality.get(correlation) ?? {
      correlation,
      phase,
      ...(dismissed ? { dismissed } : {})
    };
    if (terminal(fact)) finality.set(correlation, fact);
    if (index === -1) facts.push(fact);
    else facts[index] = fact;
    changed = true;
  }
  if (!changed) return state;
  while (facts.length > MESSAGE_FACTS_KEPT) {
    const terminal = facts.findIndex(
      (fact) => fact.phase === 'done' || fact.phase === 'unsuccessful'
    );
    facts.splice(terminal === -1 ? 0 : terminal, 1);
  }
  const protectedTokens = new Set(state.messageTurn ?? []);
  const recent = [...finality.values()]
    .filter((fact) => !protectedTokens.has(fact.correlation))
    .slice(-MESSAGE_FACTS_KEPT);
  const messageFinality = [...finality.values()].filter(
    (fact) => protectedTokens.has(fact.correlation) || recent.includes(fact)
  );
  return { ...state, messageFacts: facts, messageFinality };
}

export function abandon(state: LiveState): LiveState {
  return update(
    state,
    [
      ...new Set([
        ...(state.messageFacts ?? []).map((fact) => fact.correlation),
        ...(state.messageTurn ?? []),
        ...correlations(state.inFlight),
        ...state.queued.flatMap(correlations)
      ])
    ],
    'unsuccessful'
  );
}

/** Native ownership pins terminal outcomes until that ownership is evicted. */
export class MessageTurns {
  private readonly turns = new Map<string, readonly string[]>();
  private readonly finality = new Map<string, MessageTerminalFact>();

  remember(id: string, message: QueuedMessage): void {
    const tokens = correlations(message);
    if (tokens.length === 0) return;
    this.turns.set(id, tokens);
    while (this.turns.size > MESSAGE_FACTS_KEPT) {
      const oldest = this.turns.keys().next().value;
      if (oldest === undefined) break;
      this.turns.delete(oldest);
    }
  }

  apply(previous: LiveState, next: LiveState): LiveState {
    for (const state of [previous, next]) {
      for (const fact of [...(state.messageFinality ?? []), ...(state.messageFacts ?? [])]) {
        if (terminal(fact) && (!this.finality.has(fact.correlation) || fact.dismissed))
          this.finality.set(fact.correlation, fact);
      }
    }
    let changed = false;
    const facts = next.messageFacts?.map((fact) => {
      const final = this.finality.get(fact.correlation);
      if (!final || final.phase === fact.phase) return fact;
      changed = true;
      return final;
    });
    const pinned = new Set([...this.turns.values()].flat());
    for (const token of next.messageTurn ?? []) pinned.add(token);
    const unpinned = [...this.finality.keys()].filter((token) => !pinned.has(token));
    for (const token of unpinned.slice(0, -MESSAGE_FACTS_KEPT)) this.finality.delete(token);
    if (!changed || !facts) return next;
    return {
      ...next,
      messageFacts: facts,
      messageFinality: next.messageFinality?.map(
        (fact) => this.finality.get(fact.correlation) ?? fact
      )
    };
  }

  settle(state: LiveState, id: string, outcome?: TurnOutcome): LiveState {
    const tokens = this.turns.get(id);
    if (!tokens) return state;
    this.apply(state, state);
    const phases = new Map<MessagePhase, string[]>();
    for (const token of tokens) {
      const fact = this.finality.get(token) ?? { correlation: token, phase: phaseOf(outcome) };
      if (terminal(fact)) this.finality.set(token, fact);
      const group = phases.get(fact.phase) ?? [];
      group.push(token);
      phases.set(fact.phase, group);
    }
    let next = state;
    for (const [phase, group] of phases) next = update(next, group, phase);
    return this.apply(state, next);
  }
}

function terminal(fact: MessageFact): fact is MessageTerminalFact {
  return fact.phase === 'done' || fact.phase === 'unsuccessful';
}

function isPhase(value: unknown): value is MessagePhase {
  return (
    value === 'queued' ||
    value === 'processing' ||
    value === 'done' ||
    value === 'unsuccessful' ||
    value === 'unknown'
  );
}
