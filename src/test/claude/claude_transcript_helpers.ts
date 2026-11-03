import * as fs from 'node:fs/promises';

import * as path from 'node:path';

import { tempHome } from '../helpers';

export type Transcript = typeof import('../../core/claude/transcript');

export let home: string;

export let transcript: Transcript;

export const write = async (name: string, entries: unknown[]): Promise<string> => {
  const file = path.join(home, `${name}.jsonl`);
  await fs.writeFile(file, entries.map((e) => JSON.stringify(e)).join('\n'));
  return file;
};

/** The tools a turn ran, in order — read off its blocks, which is the only
 *  record of them now that a turn carries no separate name list. */
export const calls = (turn: import('../../core/transcript').Authored | undefined): string[] =>
  (turn?.blocks ?? []).flatMap((b) => ('call' in b ? [b.call.name] : []));

/** Everything the reader kept, markers included. */
export const allIn = async (file: string): Promise<import('../../core/transcript').Exchange[]> =>
  (await transcript.readRecent(file)).exchanges;

/** The turns somebody produced: most of these are about what the reader keeps,
 *  not the cut. A body wrongly kept as a prompt still shows up here, which is
 *  what makes the filter safe. */
export const turnsIn = async (file: string): Promise<import('../../core/transcript').Authored[]> =>
  (await allIn(file)).filter((x): x is import('../../core/transcript').Authored => !('mark' in x));

/** The one answered-ask record in a transcript, wherever the call carrying it
 *  landed — a tool result is not a turn, so its index is not the fixture's. */
export const askIn = async (
  file: string
): Promise<import('../../core/transcript').AnsweredAsk | undefined> => {
  const blocks = (await turnsIn(file)).flatMap((t) => t.blocks ?? []);
  return blocks.flatMap((b) => ('call' in b && b.call.ask ? [b.call.ask] : []))[0];
};

export const user = (content: unknown): { type: string; message: { content: unknown } } => ({
  type: 'user',
  message: { content }
});

export const assistant = (content: unknown): { type: string; message: { content: unknown } } => ({
  type: 'assistant',
  message: { content }
});

export const text = (t: string): { type: string; text: string }[] => [{ type: 'text', text: t }];

export const tool = (name: string): { type: string; name: string }[] => [
  { type: 'tool_use', name }
];

export const source = (
  media: string,
  data: string
): { type: string; source: { media_type: string; data: string } } => ({
  type: 'image',
  source: { media_type: media, data }
});

export const setup = async (): Promise<void> => {
  home = await tempHome();
  transcript = await import('../../core/claude/transcript');
};
