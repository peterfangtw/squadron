import { imagePathsIn } from '../core/pastes';
import type { Authored, Block } from '../core/transcript';

/**
 * One run of a settled turn's prose, as the wire carries it.
 *
 * A `user` turn goes as source text: the webview parses it with the parser it
 * drew the echo with, so the swap keeps its look. The host's engine is a
 * different parser. Every brand's prompt takes this path, by role alone.
 * `user` only — a `cli` turn is the CLI's own markdown, `/context`'s table
 * included, and an assistant's is markdown by construction.
 *
 * The path an attachment travelled as is noise once the picture itself is on
 * screen, so it comes out of the prose and the chip stands in its place. Only
 * out of the *drawn* text: `text` is what the composer's echo matches a sent
 * message against, and the CLI writes those paths down as part of the message.
 * A prompt only. A bare path is an attachment marker in something a person
 * sent, and the sentence itself in prose Claude wrote naming a file it built.
 * Assistant turns carry `images` too, since `core/transcript.ts` reads the
 * ones they point at, so the role is what separates them.
 */
export async function proseBlockView(
  role: Authored['role'],
  hasImages: boolean,
  block: Extract<Block, { text: string }>,
  render: (text: string) => Promise<string>
): Promise<BlockView> {
  if (role === 'user') {
    return { prose: hasImages ? withoutPaths(block.text) : block.text };
  }
  return {
    html: block.text ? await render(block.text) : '',
    ...(block.summarized ? { summarized: true as const } : {})
  };
}

/**
 * The prompt without the attachment paths it carried. Whole lines go, because
 * that is how the CLI takes them — a path has to end its line to attach at all
 * — and a line that held nothing else would otherwise leave a blank one behind.
 */
function withoutPaths(text: string): string {
  const paths = new Set(imagePathsIn(text));
  return text
    .split('\n')
    .filter((line) => !paths.has(line.trim()))
    .join('\n')
    .trim();
}
