import { sameSessionStart, type Session } from './model';

/** Kind and published owner only. Neither grants a caller permission to act. */
export type SessionControlFacts =
  | { canControl: false; reason: 'background' }
  | {
      canControl: true;
      owner:
        | { kind: 'window'; windowId: string }
        | { kind: 'unclaimed'; reason: 'unpublished' | 'owner-missing' };
    };

/** Dropping malformed metadata would let legacy aliases restore actionability. */
export type ControlReading = SessionControlFacts | { canControl: false; reason: 'invalid' };

export type SessionAddress = { pid: number; startedAt: number; windowId: string };
export type TargetFailure = 'background' | 'unpublished' | 'owner-missing' | 'invalid' | 'exited';
export type TargetResolution =
  | {
      ok: true;
      session: Session;
      address: SessionAddress;
      reachability: 'confirmed' | 'unconfirmed';
    }
  | { ok: false; reason: TargetFailure };

export type TargetContext = {
  claims?: readonly { id: string }[];
  published?: ReadonlyMap<number, { session: Pick<Session, 'pid' | 'startedAt'>; exit?: unknown }>;
};

const INVALID = { canControl: false, reason: 'invalid' } as const;

/** Only the known fields survive decoding; identifiers are bounded before copying. */
export function readControlFacts(value: unknown): ControlReading {
  if (!object(value)) return INVALID;
  if (value.canControl === false) {
    return value.reason === 'background' && value.owner === undefined
      ? { canControl: false, reason: 'background' }
      : INVALID;
  }
  if (value.canControl !== true || value.reason !== undefined || !object(value.owner)) {
    return INVALID;
  }
  const owner = value.owner;
  if (owner.kind === 'window' && windowId(owner.windowId) && owner.reason === undefined) {
    return { canControl: true, owner: { kind: 'window', windowId: owner.windowId } };
  }
  if (
    owner.kind === 'unclaimed' &&
    (owner.reason === 'unpublished' || owner.reason === 'owner-missing') &&
    owner.windowId === undefined
  ) {
    return { canControl: true, owner: { kind: 'unclaimed', reason: owner.reason } };
  }
  return INVALID;
}

/** The only compatibility interpretation of source/background/windowId. */
export function controlOf(session: Session): ControlReading {
  if ('control' in session) {
    const control = readControlFacts(session.control);
    if (!control.canControl) {
      return control.reason === 'background' && session.source === 'owned' && !session.background
        ? INVALID
        : control;
    }
    if (session.background) return INVALID;
    if (control.owner.kind === 'window') {
      if (session.windowId !== undefined && session.windowId !== control.owner.windowId) {
        return INVALID;
      }
    } else if (control.owner.reason === 'owner-missing' && windowId(session.windowId)) {
      return INVALID;
    }
    return control;
  }
  if (session.background) return { canControl: false, reason: 'background' };
  if (session.source === 'owned') {
    return windowId(session.windowId)
      ? { canControl: true, owner: { kind: 'window', windowId: session.windowId } }
      : { canControl: true, owner: { kind: 'unclaimed', reason: 'owner-missing' } };
  }
  return { canControl: true, owner: { kind: 'unclaimed', reason: 'unpublished' } };
}

/** An advisory address; the receiving registry and start check remain authoritative. */
export function resolveTarget(session: Session, context: TargetContext = {}): TargetResolution {
  const control = controlOf(session);
  if (!control.canControl) return { ok: false, reason: control.reason };
  if (control.owner.kind === 'unclaimed') return { ok: false, reason: control.owner.reason };
  if (!Number.isInteger(session.pid) || session.pid <= 0 || !Number.isFinite(session.startedAt)) {
    return { ok: false, reason: 'invalid' };
  }
  const record = context.published?.get(session.pid);
  if (
    record?.session.pid === session.pid &&
    sameSessionStart(record.session.startedAt, session.startedAt) &&
    record.exit !== undefined
  ) {
    return { ok: false, reason: 'exited' };
  }
  const address = {
    pid: session.pid,
    startedAt: session.startedAt,
    windowId: control.owner.windowId
  };
  return {
    ok: true,
    session,
    address,
    reachability: context.claims?.some((claim) => claim.id === address.windowId)
      ? 'confirmed'
      : 'unconfirmed'
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function windowId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1024 && value.trim().length > 0;
}
