/**
 * What the `@` menu draws for a query, and what a pick becomes: the pure half
 * of `mentions.ts`, with no DOM.
 *
 * Every spelling a mention sends lives here, which is why this is a leaf a unit
 * test can reach: the model flags are the text `PRD_shipped_at_mention_menu.md`
 * §10 measured across three CLIs, and the skill phrase is `expansionFor`'s one
 * copy.
 *
 * **Models are the catalog's, and only the catalog's.** Every row, its order,
 * name, window, efforts and legacy flag come from the `ModelView`s the caller
 * passes, which are `PanelState.models`. Nothing here holds a model list, a
 * short name or an abbreviation of its own, and `value`, `brand`, `window` and
 * an effort's `value` are copied into the expansion as given, never parsed.
 */

import { findRefs, refLabel } from '../core/session_ref';
import * as ticketRefs from '../core/ticket_ref';
import { disjoint } from '../core/tokens';
import { ctxLabel } from './dom';
import { expansionFor, skillPhrases, WORD } from './skilltext';

export type MentionKind = 'model' | 'skill' | 'session' | 'ticket';

/** What one box offers. A kind left out is not offered. */
export type MentionSources = {
  tickets?: readonly TicketView[];
  models?: readonly ModelView[];
  skills?: readonly string[];
  sessions?: readonly CardView[];
};

/** A pick, as the caller stores it: `label` is the pill, `expansion` what the
 *  session receives. */
export type Mention = { kind: MentionKind; label: string; expansion: string };

/**
 * A pick remembered for Recent: who it was, never what it said. Name, efforts
 * and default are read off the current row every time it is drawn, so a
 * catalog that renamed a model since is the one Recent shows.
 */
export type RecentId =
  | { kind: 'model'; brand: string; value: string; window?: number; effort?: string }
  | { kind: 'skill'; name: string }
  | { kind: 'session'; pid: number }
  | { kind: 'ticket'; key: string; url: string };

/** What pressing a row does: narrow to a kind, or take a mention. `follow` is
 *  the model whose efforts are offered next. */
export type Act =
  { scope: MentionKind } | { mention: Mention; recent: RecentId; follow?: ModelView };

export type Row = {
  /** The kind square's colour. */
  kind: MentionKind;
  name: string;
  meta?: string;
  /** Draws `›`: pressing it opens a further step. */
  more?: true;
  gated?: true;
  act: Act;
};

/** A heading between groups, or the breadcrumb of a narrowed list. */
export type Head = { head: string; crumb?: true };

export type Line = Row | Head;

/**
 * Which list is up. The highlight goes back to the first row whenever this
 * changes, and survives typing while it does not.
 */
export type Mode = 'kinds' | 'search' | MentionKind | 'effort';

/** Every kind declares recognition, picker name, appearance and copy policy. */
export const MENTIONS: Readonly<
  Record<
    MentionKind,
    {
      title: string;
      className: string;
      clipboard: 'expansion' | 'link';
      find: (text: string, skills: readonly string[]) => MentionHit[];
    }
  >
> = {
  model: {
    title: 'Models',
    className: 'model',
    clipboard: 'expansion',
    find: (text) => findModels(text).map((hit) => ({ kind: 'model', ...hit }))
  },
  skill: { title: 'Skills', className: 'skill', clipboard: 'expansion', find: findSkills },
  session: {
    title: 'Sessions',
    className: 'ref',
    clipboard: 'expansion',
    find: (text) => findRefs(text).map((hit) => ({ kind: 'session', ...hit }))
  },
  ticket: {
    title: 'Tickets',
    className: 'ticket',
    clipboard: 'link',
    find: (text) => ticketRefs.findTickets(text).map((hit) => ({ kind: 'ticket', ...hit }))
  }
};
export const KINDS = Object.keys(MENTIONS) as MentionKind[];

/** How many Recent keeps. */
const RECENT = 3;

/** The text a kind row writes into the box, which the reader can also type. */
export const scopeText = (kind: MentionKind): string => `@${kind}:`;

/** Sessions a pick can name: only a card with a reference to send. */
const namable = (cards: readonly CardView[] | undefined): CardView[] =>
  (cards ?? []).filter((card) => card.ref);

/** Every row a kind has, older models included. */
function all(sources: MentionSources, kind: MentionKind): number {
  if (kind === 'model') return sources.models?.length ?? 0;
  if (kind === 'skill') return sources.skills?.length ?? 0;
  if (kind === 'ticket') return ticketRows(sources.tickets).length;
  return namable(sources.sessions).length;
}

/** The kinds this box offers that have anything to offer. */
export function offered(sources: MentionSources): MentionKind[] {
  return KINDS.filter((kind) => all(sources, kind) > 0);
}

/**
 * What the menu draws for the text after the `@`.
 *
 * - One kind offered: its rows, filtered, with no kind step and no heading —
 *   the editor's skills-only menu, exactly as it was.
 * - `@model:` and friends, for an offered kind: that kind alone, under a
 *   breadcrumb. A scope word for a kind the box does not offer is a query like
 *   any other, so a skill named `model:tune` is still found there.
 * - Bare `@`: the kinds with their counts, then Recent.
 * - Anything else: kinds whose name starts with it, then matches grouped by
 *   kind in the sources' own order.
 *
 * Older models appear only once something is typed.
 */
export function linesFor(
  sources: MentionSources,
  query: string,
  recent: readonly RecentId[]
): { mode: Mode; lines: Line[] } {
  const kinds = offered(sources);
  const scope = /^(\w+):(.*)$/s.exec(query);
  const scoped = scope && kinds.includes(scope[1] as MentionKind) ? scope : null;
  if (kinds.length === 1 && !scoped) {
    const [only] = kinds as [MentionKind];
    return { mode: 'search', lines: rowsOf(sources, only, query) };
  }
  if (scoped) {
    const kind = scoped[1] as MentionKind;
    const rows = rowsOf(sources, kind, scoped[2] ?? '');
    return {
      mode: kind,
      lines: rows.length ? [{ head: MENTIONS[kind].title, crumb: true }, ...rows] : []
    };
  }
  if (!query) {
    const lines: Line[] = kinds.map((kind) => kindRow(sources, kind));
    const back = recent.flatMap((id) => resolve(sources, id) ?? []);
    if (back.length) lines.push({ head: 'Recent' }, ...back);
    return { mode: 'kinds', lines };
  }
  const wanted = query.toLowerCase();
  const lines: Line[] = kinds
    .filter((kind) => MENTIONS[kind].title.toLowerCase().startsWith(wanted))
    .map((kind) => kindRow(sources, kind));
  for (const kind of kinds) {
    const rows = rowsOf(sources, kind, query);
    if (rows.length) lines.push({ head: MENTIONS[kind].title }, ...rows);
  }
  return { mode: 'search', lines };
}

/**
 * The effort step for a model just picked: its default first, then the
 * row's own efforts in the row's order. Empty for a row with no efforts.
 * A description on an effort stays on the catalog row; the line paints the value.
 */
export function effortLines(model: ModelView, models: readonly ModelView[], query = ''): Line[] {
  if (!model.efforts?.length) return [];
  const stem = stemOf(model, models);
  const recent = (effort?: string): RecentId => ({
    ...modelId(model),
    ...(effort ? { effort } : {})
  });
  const rows: Row[] = [
    {
      kind: 'model',
      name: 'default',
      ...(model.defaultEffort ? { meta: model.defaultEffort } : {}),
      act: { mention: modelMention(model, models), recent: recent() }
    },
    ...model.efforts.map((effort): Row => ({
      kind: 'model',
      name: effort.value,
      act: { mention: modelMention(model, models, effort.value), recent: recent(effort.value) }
    }))
  ];
  const wanted = query.toLowerCase();
  const matching = rows.filter((row) => row.name.toLowerCase().startsWith(wanted));
  return matching.length
    ? [{ head: `${MENTIONS.model.title} › ${stem} › effort`, crumb: true }, ...matching]
    : [];
}

/**
 * The mention a stored expansion is: the one `findMentions` hit spanning it
 * whole. Undefined for anything this module did not write. A skill is read
 * with its own name as the list, since a stored expansion has no skill list
 * beside it.
 */
export function mentionOf(expansion: string): MentionHit | undefined {
  const skill = /^the (.+) skill$/s.exec(expansion)?.[1];
  const [hit] = findMentions(expansion, skill === undefined ? [] : [skill]);
  return hit?.text === expansion ? hit : undefined;
}

/** Which kind a stored expansion is, for painting its pill. */
export const kindOf = (expansion: string): MentionKind | undefined => mentionOf(expansion)?.kind;

/**
 * What a mention is drawn as: a card's name now (`name`, where the surface can
 * say it), a skill's name, a model's stem and effort.
 */
export function labelOf(
  hit: MentionHit,
  name: (pid: number) => string | undefined = () => undefined
): string {
  if (hit.kind === 'session') return refLabel(hit.pid, name(hit.pid));
  if (hit.kind === 'skill') return `@${hit.name}`;
  if (hit.kind === 'ticket') return `@${hit.identifier}`;
  return `@${hit.stem}${hit.effort ? ` · ${hit.effort}` : ''}`;
}

/** The row offered now for a remembered model, if it is still offered. */
export function modelOf(models: readonly ModelView[], id: RecentId): ModelView | undefined {
  return models.find((model) => sameId(modelId(model), id));
}

/**
 * The row in `lines` that does what `act` did. A drawn row can outlive the
 * sources it was drawn from — a push lands between the paint and the press —
 * so a pick is taken from the current rows, never from the button's own.
 */
export function rowFor(lines: readonly Line[], act: Act): Row | undefined {
  return lines.find((line): line is Row => 'act' in line && sameAct(line.act, act));
}

/** Recent with `id` in front: one entry per identity, newest first. */
export function remember(recent: readonly RecentId[], id: RecentId): RecentId[] {
  return [id, ...recent.filter((old) => !sameId(old, id))].slice(0, RECENT);
}

/* Below here: how a source becomes a row. */

function kindRow(sources: MentionSources, kind: MentionKind): Row {
  const count = kind === 'model' ? current(sources.models).length : all(sources, kind);
  return {
    kind,
    name: MENTIONS[kind].title,
    meta: String(count),
    more: true,
    act: { scope: kind }
  };
}

const current = (models: readonly ModelView[] | undefined): ModelView[] =>
  (models ?? []).filter((model) => !model.legacy);

function rowsOf(sources: MentionSources, kind: MentionKind, query: string): Row[] {
  const wanted = query.toLowerCase();
  const has = (field: string | undefined): boolean =>
    field !== undefined && field.toLowerCase().includes(wanted);
  if (kind === 'model') {
    const models = sources.models ?? [];
    // The picker's own three fields (`modelItems`), so a word that finds a
    // model there finds it here.
    return (query ? models : current(models))
      .filter((model) => has(model.name) || has(model.id) || has(model.brandLabel))
      .map((model) => modelRow(model, models));
  }
  if (kind === 'skill') return (sources.skills ?? []).filter(has).map(skillRow);
  if (kind === 'ticket')
    return ticketRows(sources.tickets).filter((row) => has(row.name) || has(row.meta));
  return namable(sources.sessions)
    .filter((card) => has(card.name))
    .map(sessionRow);
}

function ticketRows(tickets: readonly TicketView[] | undefined): Row[] {
  return (tickets ?? []).flatMap((ticket) => {
    const expansion = ticketRefs.ticketRef(ticket.identifier, ticket.url);
    return expansion
      ? [
          {
            kind: 'ticket' as const,
            name: ticket.identifier,
            meta: ticket.title,
            act: {
              mention: { kind: 'ticket' as const, label: `@${ticket.identifier}`, expansion },
              recent: { kind: 'ticket' as const, key: ticket.key, url: ticket.url }
            }
          }
        ]
      : [];
  });
}

function modelRow(model: ModelView, models: readonly ModelView[]): Row {
  const meta = [
    model.window === undefined ? undefined : ctxLabel(model.window),
    model.brandLabel
  ].filter((part) => part !== undefined);
  return {
    kind: 'model',
    name: stemOf(model, models),
    ...(meta.length ? { meta: meta.join(' · ') } : {}),
    ...(model.efforts?.length ? { more: true as const } : {}),
    ...(model.gated ? { gated: true as const } : {}),
    act: {
      mention: modelMention(model, models),
      recent: modelId(model),
      ...(model.efforts?.length ? { follow: model } : {})
    }
  };
}

function skillRow(name: string): Row {
  return {
    kind: 'skill',
    name,
    act: {
      mention: { kind: 'skill', label: `@${name}`, expansion: expansionFor(name) },
      recent: { kind: 'skill', name }
    }
  };
}

function sessionRow(card: CardView): Row {
  return {
    kind: 'session',
    name: card.name,
    meta: `${card.status} · ${card.pid}`,
    act: {
      mention: { kind: 'session', label: refLabel(card.pid, card.name), expansion: card.ref ?? '' },
      recent: { kind: 'session', pid: card.pid }
    }
  };
}

/**
 * The name a model goes by in a pill: its own, plus the window when another
 * offered row shares its `value` — the only time the window tells two apart.
 */
function stemOf(model: ModelView, models: readonly ModelView[]): string {
  const twin = models.some((other) => other !== model && other.value === model.value);
  return twin && model.window !== undefined
    ? `${model.name} ${ctxLabel(model.window)}`
    : model.name;
}

/**
 * The spelling `squadron-spawn` takes, measured to carry through on three
 * CLIs (PRD §10). `--context` only when the row states a window: an unknown
 * live model has none, and inventing one would be a second source. No
 * `--effort` at the default, which is what an omitted effort opens at.
 */
function modelMention(model: ModelView, models: readonly ModelView[], effort?: string): Mention {
  const stem = stemOf(model, models);
  const flags = [
    `--brand ${model.brand}`,
    `--model-id ${model.value}`,
    ...(model.window === undefined ? [] : [`--context ${model.window}`]),
    ...(effort ? [`--effort ${effort}`] : [])
  ].join(' ');
  return {
    kind: 'model',
    label: `@${stem}${effort ? ` · ${effort}` : ''}`,
    expansion: `a peer on ${stem}${effort ? ` at ${effort} effort` : ''} (squadron-spawn ${flags})`
  };
}

/**
 * `modelMention`'s expansion as it writes it: the flags in its order, closed
 * at the first `)`, never across a line break. `--model` too, which turns
 * written before the flag became `--model-id` still carry. The stem ends where
 * ` at <effort> effort (` or ` (squadron-spawn` begins, so a windowed stem
 * (`Sonnet 5.5 200k`) reads back whole. Opens on a skill phrase's boundary
 * (`WORD`), so `Ka peer on …` is prose.
 */
const MODEL = new RegExp(
  String.raw`(?<!${WORD.source})a peer on ([^\n()]+?)(?: at ([^\s()]+) effort)? \(squadron-spawn --brand [^\s()]+ --model(?:-id)? [^\s()]+(?: --context \d+)?(?: --effort [^\s()]+)?\)`,
  'gu'
);

/** Every model pick's expansion in `text`, left to right, the way `findRefs`
 *  reads references. */
function findModels(text: string): { at: number; text: string; stem: string; effort?: string }[] {
  return [...text.matchAll(MODEL)].map((m) => ({
    at: m.index,
    text: m[0],
    stem: m[1] ?? '',
    ...(m[2] ? { effort: m[2] } : {})
  }));
}

/** One mention found in prose: where, its characters, and what its kind
 *  knows of it. */
export type MentionHit = { at: number; text: string } & (
  | { kind: 'session'; pid: number; transcript: string }
  | { kind: 'model'; stem: string; effort?: string }
  | { kind: 'skill'; name: string }
  | ({ kind: 'ticket' } & ticketRefs.TicketRef)
);

/**
 * Every mention in `text`, left to right, never overlapping: the earlier hit
 * wins, and one starting inside it is dropped. A skill is found only by a name
 * in `skills`, so a caller that does not want skills read passes none.
 *
 * A model or skill inside a longer word is prose (`WORD`). A reference opens on
 * its `@` sigil and closes on `]`, so it needs no boundary.
 */
export function findMentions(text: string, skills: readonly string[]): MentionHit[] {
  return disjoint<MentionHit>(KINDS.flatMap((kind) => MENTIONS[kind].find(text, skills)));
}

function findSkills(text: string, skills: readonly string[]): MentionHit[] {
  const named = new Map(skills.map((name) => [expansionFor(name), name]));
  return skillPhrases(text, skills).map((hit) => ({
    kind: 'skill',
    ...hit,
    name: named.get(hit.text) ?? hit.text
  }));
}

/** Each kind's pill class, after the dock's own (`sref`). */
export const PILL_CLASS = Object.fromEntries(
  KINDS.map((kind) => [kind, MENTIONS[kind].className])
) as Record<MentionKind, string>;

export function pillPresentation(
  hit: MentionHit,
  name?: (pid: number) => string | undefined
): { label: string; className: string; expansion: string } {
  return {
    label: labelOf(hit, name),
    className: PILL_CLASS[hit.kind],
    expansion: hit.text
  };
}

const modelId = (model: ModelView): Extract<RecentId, { kind: 'model' }> => ({
  kind: 'model',
  brand: model.brand,
  value: model.value,
  ...(model.window === undefined ? {} : { window: model.window })
});

function sameAct(a: Act, b: Act): boolean {
  if ('scope' in a || 'scope' in b) return 'scope' in a && 'scope' in b && a.scope === b.scope;
  const effort = (id: RecentId) => (id.kind === 'model' ? id.effort : undefined);
  return sameId(a.recent, b.recent) && effort(a.recent) === effort(b.recent);
}

function sameId(a: RecentId, b: RecentId): boolean {
  if (a.kind === 'model' && b.kind === 'model') {
    return a.brand === b.brand && a.value === b.value && a.window === b.window;
  }
  if (a.kind === 'skill' && b.kind === 'skill') return a.name === b.name;
  if (a.kind === 'session' && b.kind === 'session') return a.pid === b.pid;
  if (a.kind === 'ticket' && b.kind === 'ticket') return a.key === b.key && a.url === b.url;
  return false;
}

/**
 * A remembered pick, as the current sources draw it — or nothing, when its
 * row is no longer offered. An effort the row no longer lists falls back to
 * the default.
 */
function resolve(sources: MentionSources, id: RecentId): Row | undefined {
  if (id.kind === 'skill') {
    return sources.skills?.includes(id.name) ? skillRow(id.name) : undefined;
  }
  if (id.kind === 'ticket') {
    const ticket = sources.tickets?.find(
      (ticket) => ticket.key === id.key && ticket.url === id.url
    );
    return ticket ? ticketRows([ticket])[0] : undefined;
  }
  if (id.kind === 'session') {
    const card = namable(sources.sessions).find((c) => c.pid === id.pid);
    return card ? sessionRow(card) : undefined;
  }
  const models = sources.models ?? [];
  const model = models.find((m) => sameId(modelId(m), id));
  if (!model) return undefined;
  const effort = model.efforts?.find((e) => e.value === id.effort)?.value;
  if (!effort) return modelRow(model, models);
  return {
    kind: 'model',
    name: `${stemOf(model, models)} · ${effort}`,
    act: { mention: modelMention(model, models, effort), recent: { ...modelId(model), effort } }
  };
}
