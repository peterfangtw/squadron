/**
 * Codex's permission mode, which is two of them.
 *
 * `approvalPolicy` says when a reader is asked; the sandbox says what may be
 * done without asking. Either withholds what the other grants, and the C0
 * probe caught the pair disagreeing: `fixtures/codex-app-server-0.151.0/
 * resume.json` opened on `approvalPolicy: "never"` with sandbox
 * `workspaceWrite` — never asks, still cannot write outside the workspace.
 * Reading the policy alone would paint that card as bypassing, which is the one
 * reading a card must never get wrong.
 *
 * So the two travel through `LiveState.permissionMode` as one word,
 * `policy+sandbox`, and this file is the only place either is spelled.
 *
 * The app-server has two spellings of the sandbox and they are not the same:
 * `openParams` asks in kebab (`danger-full-access`) and 0.151.0 answers in
 * camel (`start.json`: `{ type: "workspaceWrite" }`). Both are its own, so
 * `sandboxType` reads either and this file keeps one word — a card must not
 * read differently depending on which half of the exchange it heard.
 */

import { asStated, type PermissionView } from '../permissions';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The request spellings, as the words the responses come back in. */
const SANDBOXES: Record<string, string> = {
  'read-only': 'readOnly',
  'workspace-write': 'workspaceWrite',
  'danger-full-access': 'dangerFullAccess'
};

/**
 * The sandbox out of a `thread/start` result's `sandbox` or a
 * `thread/settings/updated`'s `sandboxPolicy` — one field of two names, both
 * carrying `{ type, … }` with the restrictions of the type beside it.
 *
 * A plain string is the kebab one we asked with, coming back off a server that
 * echoed the request rather than restating its own settings.
 */
export function sandboxType(value: unknown): string | undefined {
  const type = typeof value === 'string' ? value : isRecord(value) ? value.type : undefined;
  if (typeof type !== 'string' || !type) return undefined;
  return SANDBOXES[type] ?? type;
}

/** The two readings as one, or nothing when the CLI stated no policy. */
export function permissionWord(policy?: string, sandbox?: string): string | undefined {
  if (!policy) return undefined;
  return sandbox ? `${policy}+${sandbox}` : policy;
}

/**
 * What the thread `openParams` composed will report, before it has reported it.
 *
 * Mirrors that function deliberately rather than deriving from it: it speaks
 * the request's kebab, and a card wants the word the CLI will answer with, so
 * that the first paint and the one after `thread/started` are the same word.
 */
export function startMode(skipPermissions: boolean): string {
  return skipPermissions ? 'never+dangerFullAccess' : 'on-request+workspaceWrite';
}

/**
 * The pair as the strip reads it.
 *
 * Ordered by which half is the stronger fact. An unsandboxed thread is the
 * headline whatever the policy says — `bypass` when it also never asks, and
 * `full access` when a reader is still in the loop for what the sandbox no
 * longer stops. Below those the sandbox holds, so `never` is unattended work
 * inside a boundary — `auto`, the same word Claude's own unattended mode uses.
 */
export function permissionView(mode: string): PermissionView | undefined {
  const [policy = '', sandbox = ''] = mode.split('+');
  if (sandbox === 'dangerFullAccess') {
    return policy === 'never'
      ? { label: 'bypass', holds: false, bypass: true }
      : { label: 'full access', holds: false, bypass: false };
  }
  if (sandbox === 'readOnly') return { label: 'read only', holds: false, bypass: false };
  if (policy === 'never') return { label: 'auto', holds: false, bypass: false };
  // The start every panel `+` makes, and the one the CLI defaults to: a word
  // here would be on nearly every Codex card and would say nothing.
  if (policy === 'on-request' && (sandbox === 'workspaceWrite' || !sandbox)) return undefined;
  // A policy we have no reading for, under the ordinary sandbox: the policy is
  // the whole of the news, and `on-failure+workspaceWrite` on a card is two
  // words where one is true.
  return asStated(sandbox === 'workspaceWrite' || !sandbox ? policy : mode);
}
