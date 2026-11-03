import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PASTES_DIR } from './paths';
import { DAY_MS, pruneOlderThan } from './prune';

/**
 * An image pasted into the composer, on its way to a session.
 *
 * The CLI takes an image from a message only one way we can reach: text that
 * parses as a path to an image file. Its own paste handler splits what was
 * pasted, tests each token for an image extension, and reads the file itself —
 * so the panel writes the bytes down, sends the path, and the CLI attaches the
 * real thing. `docs/reference/cli_state/claude/retired.md` has the record.
 *
 * Deliberately free of `vscode`, because the two rules that matter — which
 * extension a media type earns, and which text the CLI will treat as a paste of
 * an image — are exactly the ones a silent drop would hide.
 */

/**
 * The media types the CLI will take, mapped to the extension it looks for. The
 * gate is the extension: a `.png` holding something else is dropped after the
 * read, with a warning we would never see, so an unsupported type must be
 * refused before it is written rather than renamed and hoped over.
 */
const EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp']
]);

export function extForMedia(mediaType: string): string | undefined {
  return EXTENSIONS.get(mediaType.toLowerCase());
}

/**
 * The same table read the other way, for a file being shown rather than
 * written. Off the one map, so a type this refuses to write can never be a type
 * something else claims to have read. `jpeg` folds onto `jpg` because the map
 * holds the extension the CLI looks for, not every spelling a file may use.
 */
const MEDIA = new Map([...EXTENSIONS].map(([media, ext]) => [ext, media]));

export function mediaForExt(ext: string): string | undefined {
  const key = ext.toLowerCase().replace(/^\./, '');
  return MEDIA.get(key === 'jpeg' ? 'jpg' : key);
}

/**
 * The CLI's own rule for "this pasted text carries an image", mirrored: it
 * splits on newlines and ahead of each absolute path, then tests every token
 * for an image extension.
 *
 * Worth having as its own rule rather than a flag from the composer, because
 * the CLI keys off the text, not off where it came from — a hand-typed path in
 * an ordinary message attaches an image too, and needs the same delayed submit.
 */
export function imagePathsIn(text: string): string[] {
  return text
    .split(/\n| (?=\/|[A-Za-z]:\\)/)
    .map((token) => token.trim())
    .filter((token) => /\.(png|jpe?g|gif|webp)$/i.test(token));
}

/**
 * Writes a composer image and answers with its absolute path, which is what the
 * message carries. Undefined for a type the CLI would not take, a data URL that
 * does not parse, or a write that failed — every one of which the caller turns
 * into a refusal, because a message sent without its image reads as an answer
 * to a question nobody can see.
 */
export async function writePastedImage(image: {
  mediaType: string;
  dataUrl: string;
}): Promise<string | undefined> {
  const ext = extForMedia(image.mediaType);
  const base64 = image.dataUrl.slice(image.dataUrl.indexOf(',') + 1);
  if (!ext || !image.dataUrl.startsWith('data:') || !base64) {
    return undefined;
  }
  const file = path.join(PASTES_DIR, `${randomUUID()}.${ext}`);
  try {
    await fs.mkdir(PASTES_DIR, { recursive: true });
    await fs.writeFile(file, Buffer.from(base64, 'base64'));
    return file;
  } catch {
    return undefined;
  }
}

/**
 * Drops what the last day left behind. A day is generous: the CLI reads the
 * file as it attaches and the bytes land in the transcript as base64, so ours
 * is dead the moment the message is sent, and one that is never sent is a paste
 * the user dropped. Note it is the transcript that keeps it and not a file —
 * the CLI-side `image-cache` this once claimed does not exist.
 */
export async function prunePastes(): Promise<void> {
  await pruneOlderThan(PASTES_DIR, DAY_MS);
}
