import * as fs from 'node:fs/promises';

import * as os from 'node:os';

import * as path from 'node:path';

import { tempHome } from '../helpers';

export const LINES = [
  '{"type":"system","content":"You are Grok."}',
  '{"type":"user","content":[{"type":"text","text":"<user_info>\\nOS Version: macos\\n</user_info>"}]}',
  '{"type":"user","content":[{"type":"text","text":"<system-reminder>\\nSkills are available.\\n</system-reminder>"}],"synthetic_reason":"system_reminder"}',
  '{"type":"user","content":[{"type":"text","text":"<user_query>\\nare u claude\\n</user_query>"}]}',
  '{"type":"reasoning","summary":[{"type":"summary_text","text":"Identity question."}],"encrypted_content":"nope"}',
  '{"type":"assistant","content":"No. I’m Grok, built by xAI."}',
  '{"type":"user","content":[{"type":"text","text":"<user_query>\\nyo\\n</user_query>"}]}',
  '{"type":"assistant","content":"Yo. What’s up?"}',
  '{"type":"assistant","content":"","tool_calls":[{"id":"c1","name":"run_terminal_command","arguments":"{\\"command\\":\\"ls\\"}"}]}',
  '{"type":"tool_result","tool_call_id":"c1","content":"a.ts\\nb.ts\\n"}'
];

/**
 * The same conversation with ordinals on it, plus the two rows that carry one
 * and are not turns. Separate from `LINES` so the cases above keep asserting
 * the shape they were written for.
 */
export const INDEXED = [
  '{"type":"user","content":[{"type":"text","text":"<user_info>\\nOS Version: macos\\n</user_info>"}],"prompt_index":0}',
  '{"type":"user","content":[{"type":"text","text":"<user_query>\\nfirst\\n</user_query>"}],"prompt_index":0}',
  '{"type":"assistant","content":"one"}',
  '{"type":"user","content":[{"type":"text","text":"<system-reminder>\\nnot a turn\\n</system-reminder>"}],"synthetic_reason":"system_reminder","prompt_index":7}',
  '{"type":"user","content":[{"type":"text","text":"<user_query>\\nsecond\\n</user_query>"}],"prompt_index":1}',
  '{"type":"assistant","content":"two"}'
];

export type GrokTranscript = typeof import('../../core/grok/transcript');

export let grokCwdSlug: GrokTranscript['grokCwdSlug'];

export let grokTranscriptPath: GrokTranscript['grokTranscriptPath'];

export let readGrokChrome: GrokTranscript['readGrokChrome'];

export let readGrokTranscript: GrokTranscript['readGrokTranscript'];

export let readSentUserUpdate: GrokTranscript['readSentUserUpdate'];

export let readWitnessed: GrokTranscript['readWitnessed'];

export let file: string;

/** Session-dir layout, so `cwdOf` can recover the cwd Grok rows do not carry. */
export async function fromRows(
  rows: unknown[],
  cwd = path.resolve('/repo')
): Promise<{ file: string; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-md-'));
  const dir = path.join(root, grokCwdSlug(cwd), 'sid');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'chat_history.jsonl');
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return { file, root };
}

export const setup = async (): Promise<void> => {
  await tempHome();
  ({
    grokCwdSlug,
    grokTranscriptPath,
    readGrokChrome,
    readGrokTranscript,
    readSentUserUpdate,
    readWitnessed
  } = await import('../../core/grok/transcript'));
  file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-tr-')), 'chat_history.jsonl');
  await fs.writeFile(file, LINES.join('\n') + '\n');
};

export const dispose = (): Promise<void> =>
  fs.rm(path.dirname(file), { recursive: true, force: true });
