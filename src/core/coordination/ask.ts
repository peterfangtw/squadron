import { Reply, RequestBody, awaitReply, postRequest } from './requests';

/** A window that published a claim and then died still owes us an answer. */
export const UNANSWERED = 'That session’s window did not answer.';

export type AskFailure = 'unwritable' | 'silent' | 'refused' | 'unexpected';

/**
 * What putting a request to another window came to.
 *
 * `kind` is exhaustive on the failure arm, so a sixth verb cannot treat
 * "could not write" and "never answered" as one thing — that collapse is
 * what the shims' exit codes 5 and 4 are built to tell apart.
 *
 * `file` is the path `postRequest` returned, when it returned one. Send's
 * silent copy names `requestIdOf(file)`; unwritable never had a file.
 */
export type AskResult =
  | { ok: true; reply: Reply; file: string }
  | { ok: false; kind: 'unwritable'; reason: string }
  | { ok: false; kind: 'silent'; reason: string; file: string }
  | { ok: false; kind: 'refused' | 'unexpected'; reason: string; reply: Reply; file: string };

type ExitFailure = { kind: AskFailure; reply?: Reply };

export function askExit(failure: ExitFailure | readonly ExitFailure[]): 5 | 4 | 2 {
  const failures: readonly ExitFailure[] = 'kind' in failure ? [failure] : failure;
  if (failures.some((item) => item.kind === 'unwritable' || item.kind === 'unexpected')) return 5;
  if (failures.some((item) => item.kind === 'refused' && !item.reply?.unsure)) return 2;
  return 4;
}

export async function ask(request: RequestBody, timeoutMs?: number): Promise<AskResult> {
  const file = await postRequest(request);
  if (!file) {
    return { ok: false, kind: 'unwritable', reason: 'could not write the request' };
  }
  const reply = await awaitReply(file, timeoutMs);
  if (!reply) {
    return { ok: false, kind: 'silent', reason: UNANSWERED, file };
  }
  if (!reply.ok) {
    // Hosts predating model discovery route this request as a session verb.
    if (request.kind === 'models' && reply.reason === 'This window does not drive that session.') {
      return {
        ok: false,
        kind: 'unexpected',
        reason:
          'the window does not support model discovery; update Squadron and reload that window',
        reply,
        file
      };
    }
    return { ok: false, kind: 'refused', reason: reply.reason ?? 'refused', reply, file };
  }
  return { ok: true, reply, file };
}
