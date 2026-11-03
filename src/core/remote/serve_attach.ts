/**
 * The holder's arm for `attach` (M3): an agent's file into its root's
 * conversation. In `core/` for `serve_owned.ts`'s reason — the two-window test
 * runs the code a real holder runs — and handed every effect through
 * `AttachPort`, which `host/extension.ts` builds over `RemoteHost`.
 *
 * The holder checks again whatever the shim checked, because a raw request
 * file reaches it without the shim, and it is the process that reads the
 * file. Its answer is the one that counts.
 */

import * as path from 'path';
import * as platform from '../platform';
import type { Fault, Opened } from '../platform/private_files';
import { ReadRefusal } from '../platform/private_files';
import type { Attached, Attachment, SessionAddr } from '../bridge/model';
import * as words from '../bridge/words';
import type { Reply, Request } from '../coordination/requests';
import * as attach from './attach';
import type { Target } from './board';

export type AttachPort = {
  /** This window holds Remote and its engine is built. */
  holds(): boolean;
  /** One for the window's life. */
  guard: attach.AttachGuard;
  /** The session on a pass run now, and the messenger's `maxBytes`. */
  target(addr: SessionAddr): Promise<Target>;
  attach(addr: SessionAddr, attachment: Attachment): Promise<Attached>;
  /** Never sent, wherever a root reaches: Squadron's state, the host's user data. */
  deny: readonly string[];
};

export type AttachRequest = Extract<Request, { kind: 'attach' }>;

export async function serveAttach(request: AttachRequest, port: AttachPort): Promise<Reply> {
  if (!port.holds()) return { ok: false, reason: words.OFF_HERE };
  // The session the request names, not `from`: a sender that forged `from`
  // would otherwise start a fresh budget with every request.
  const admitted = port.guard.admit(`${request.pid}:${request.startedAt}`, Date.now());
  if (!admitted.ok) return admitted;
  let counts = false;
  try {
    const sent = await send(request, port);
    counts = sent.counts;
    return sent.reply;
  } finally {
    if (counts) port.guard.posted(admitted.slot, Date.now());
    else port.guard.release(admitted.slot);
  }
}

/** Everything after admission, and whether it took a slot for good. */
async function send(
  request: AttachRequest,
  port: AttachPort
): Promise<{ reply: Reply; counts: boolean }> {
  const refused = (reply: Reply) => ({ reply, counts: false });
  const caption = attach.checkCaption(request.caption);
  if (!caption.ok) return refused(caption);

  const addr = {
    pid: request.pid,
    startedAt: request.startedAt,
    windowId: request.sessionWindowId
  };
  const target = await port.target(addr);
  if (!target.ok) return refused(target);
  // A consistency check, not authentication: the holder cannot tell which
  // process wrote a request, and any process of this user can write one
  // naming both (M2 Key Decisions: Remote's guard is not a security boundary).
  if (target.session.sessionId !== request.from) {
    return refused({
      ok: false,
      reason: `${request.from} is not the session at pid ${request.pid}; a session sends only to its own conversation`
    });
  }

  const cap = Math.min(attach.ATTACH_MAX_BYTES, target.maxBytes);
  const file = await attach.inspectFile(request.path, target.session.cwd, cap);
  if (!file.ok) return refused(file);
  const roots = await attach.attachRoots(target.session.cwd);
  const deny = await attach.attachDeny(roots, port.deny);
  const allowed = attach.checkPath(file, roots, deny);
  if (!allowed.ok) return refused(allowed);

  const checked = await readChecked(file, { roots, deny }, cap);
  if (!checked.ok) return refused(checked);
  try {
    // The name the agent gave, not the realpath's, so a link keeps its own.
    const name = path.basename(request.path);
    const posted = await port.attach(addr, {
      bytes: checked.bytes,
      name,
      mime: attach.mimeOf(name),
      ...(caption.caption === undefined ? {} : { caption: caption.caption })
    });
    if (posted.ok) return { reply: { ok: true }, counts: true };
    // It may be in the conversation: counted, and answered so that the shim
    // says so rather than inviting a second copy.
    if (posted.unsure)
      return { reply: { ok: false, reason: posted.reason, unsure: true }, counts: true };
    return refused({ ok: false, reason: posted.reason });
  } catch (error) {
    return refused({ ok: false, reason: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * The bytes that were checked, held in memory, so the bytes sent are those
 * bytes: a log that grows during the upload cannot contradict the length the
 * messenger was promised, and nothing at any path is read after this. The
 * descriptor is opened without following a link and held to the attachment
 * rule (`platform.privateFiles`), and `bind` ties it to a path that passes the
 * checks after the open. Then: not empty, at most `cap` bytes however much it
 * grows while it is read.
 */
export async function readChecked(
  file: attach.Inspected,
  area: attach.Area,
  cap: number
): Promise<{ ok: true; bytes: Buffer } | attach.Refused> {
  const real = file.real;
  const opened = await platform.privateFiles.open(real, 'attachment');
  if (!opened.supported) return { ok: false, reason: opened.reason };
  if (opened.status !== 'ok') return { ok: false, reason: refusal(opened.fault, file) };
  const handle = opened.value;
  try {
    const bound = await bind(file, handle, area, cap);
    if (!bound.ok) return bound;
    const size = handle.size;
    if (size > cap) return { ok: false, reason: attach.tooLarge(real, size, cap) };
    // One byte past the size the descriptor stated, so a file that grew after
    // it shows, and no more: never the cap's 10 MiB for a small file.
    const buffer = Buffer.alloc(size + 1);
    let read = 0;
    try {
      while (read < buffer.length) {
        const bytesRead = await handle.read(buffer, read, buffer.length - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
    } catch (error) {
      return {
        ok: false,
        reason:
          error instanceof ReadRefusal && error.fault === 'changed'
            ? `${file.given} changed while it was being read; send it again`
            : words.UNREADABLE
      };
    }
    if (read > size) {
      return { ok: false, reason: `${file.given} changed while it was being read; send it again` };
    }
    if (read === 0) return { ok: false, reason: `${real} is empty` };
    return { ok: true, bytes: buffer.subarray(0, read) };
  } finally {
    await handle.close();
  }
}

/** What the reader is told for a descriptor the attachment rule refused. */
function refusal(fault: Fault, file: attach.Inspected): string {
  switch (fault) {
    case 'not-regular':
      return `${file.real} is not a regular file`;
    case 'foreign':
      return `${file.given} belongs to another user`;
    default:
      return words.UNREADABLE;
  }
}

/**
 * Whether the descriptor is the file the checks pass for now. `O_NOFOLLOW`
 * guards the last component only, so a parent directory swapped for a link
 * before the open would hand over the link's file: the given path is
 * realpathed again after the open and checked against the roots and the deny
 * list, and the inode at that realpath must be the descriptor's. A swap still
 * in place fails the checks; one undone after the open fails the inode. Node
 * has no `openat`, so a swap timed between this realpath and its `lstat` still
 * wins — a guard, not a sandbox.
 */
async function bind(
  file: attach.Inspected,
  opened: Opened,
  area: attach.Area,
  cap: number
): Promise<{ ok: true } | attach.Refused> {
  const again = await attach.inspectFile(file.given, path.dirname(file.given), cap);
  if (!again.ok) return again;
  const allowed = attach.checkPath(again, area.roots, area.deny);
  if (!allowed.ok) return allowed;
  if (!(await opened.bound(again.real))) {
    return { ok: false, reason: `${file.given} changed while it was being read; send it again` };
  }
  return { ok: true };
}
