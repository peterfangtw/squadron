/**
 * Every `squadron-*` verb an agent is handed, by its bare name, whether it
 * writes, and the line the Agents drawer prints for it. One list for the CLI
 * gate, the window's refusals and the drawer. Imports nothing, so the webview
 * bundles it. `core/paths.ts` `SHIM_NAMES` stays the install list; a test
 * holds the two and `scripts/esbuild.mjs` to the same names.
 */

export interface Verb {
  readonly name: string;
  /** Acts on a session, a run or Remote, so Orchestration gates it. */
  readonly write: boolean;
  readonly what: string;
}

export const VERBS = [
  {
    name: 'list',
    write: false,
    what: 'See every session on this machine, its status and transcript.'
  },
  { name: 'models', write: false, what: 'See which models a new session can start on.' },
  {
    name: 'send',
    write: true,
    what: 'Message a session. A busy one holds it until its turn ends.'
  },
  {
    name: 'answer',
    write: true,
    what: 'Answer a question another session is blocked on. Never a permission.'
  },
  { name: 'spawn', write: true, what: 'Start a new session with its own card and hand it a task.' },
  { name: 'end', write: true, what: 'End a session, and the sessions it started.' },
  { name: 'rename', write: true, what: 'Rename its own card, or any card.' },
  {
    name: 'warm',
    write: true,
    what: 'Turn Warm on or off for a card. Warm’s window and lifetime apply.'
  },
  { name: 'wait', write: true, what: 'Be told once when named sessions are done.' },
  { name: 'step', write: true, what: 'Follow a workflow one step at a time.' },
  {
    name: 'routine',
    write: true,
    what: 'Mark its associated routine run done after finishing the task.'
  },
  { name: 'attach', write: true, what: 'Post a file into its Remote conversation.' },
  { name: 'fetch-file', write: true, what: 'Download a file a Remote message carried.' }
] as const satisfies readonly Verb[];

export type VerbName = (typeof VERBS)[number]['name'];
export type WriteVerb = Extract<(typeof VERBS)[number], { write: true }>['name'];

/** What every write verb, and the window's own checks, say while Orchestration is off. */
export const ORCHESTRATION_OFF =
  'Session verbs are off. Turn on Orchestration in Agents on the hub.';

export function isWriteVerb(name: string): name is WriteVerb {
  return VERBS.some((v) => v.name === name && v.write);
}
