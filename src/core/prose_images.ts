/**
 * Markdown images in a turn's prose: named as refs the chip fetches, not
 * drawn as `<img>`. The panel serves `img-src data:` and nothing else, so an
 * image reaching the markdown engine is a broken picture whatever it points
 * at.
 *
 * Both brand readers call this. Claude's entry carries a uuid and a cwd;
 * Grok's file does not, and each caller supplies the stand-ins.
 */

import * as path from 'path';
import { mediaForExt } from './pastes';

/**
 * Markdown image syntax, `![alt](dest)`, and only where the destination is
 * unambiguous: a bare run with no whitespace or parens in it, or one wrapped in
 * angle brackets, with an optional title after it. Anything else is left for
 * the prose to carry — a space in a bare destination is not a destination
 * CommonMark accepts either, so the line a reader sees is the line as written.
 *
 * Every part stops at a newline, so an unclosed `(` cannot swallow the
 * paragraphs under it, and no two adjacent parts share a character class, so
 * there is nothing to backtrack over. **Measured 2026-08-15**: an earlier draft
 * whose tail was `[^)\s]+[^)]*` took 462 ms on a 32 KB run carrying no closing
 * paren — on text `readRecent` re-parses on every 3 s poll.
 *
 * `(?<!\\)` because an escaped `\![a](x)` is CommonMark for a link, which is
 * the one case where the author said outright that this is not an image.
 *
 * The alt run is capped rather than open. **Measured 2026-08-15**: uncapped, a
 * 128 KB line of `![` with no `]` costs 3.9 s — not backtracking inside one
 * match but the scan restarting at every `![`, which excluding the newline only
 * bounds when the text has newlines in it. 200 characters is far past any alt
 * text written on purpose, and a longer one is left to the prose.
 */
const IMAGE_MD =
  /(?<!\\)!\[([^\]\n]{0,200})\]\([ \t]*(?:<([^>\n]*)>|([^\s()<>]+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*\)/g;

/**
 * Where markdown says the words are not prose: a fence of either kind, closed
 * or not, and an inline span. A turn showing image syntax rather than using it
 * is nearly always fencing it, and a sample lost is worse than a picture
 * missed.
 *
 * **Not the four-space form.** It reads as a code block only at the top level;
 * under a list item the same indent is that item's continuation, which is where
 * an image in a bulleted list of renders actually sits. Guarding it cost more
 * images than it saved samples, so an indented sample is the case this does not
 * hold — see `proseImages` for the rest of that set.
 *
 * No `m` flag: `$` has to mean the end of the turn here, and under `m` it would
 * mean the end of a line, which would end an unclosed fence at its first
 * newline and defeat the whole rule.
 */
const CODE_MD = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g;

/** A destination as it was written, for a link put back in the prose. Angle
 *  brackets earn their place only when something in it would break without. */
function asWritten(dest: string): string {
  return /[\s()]/.test(dest) ? `<${dest}>` : dest;
}

/**
 * The file a markdown image points at, or nothing when the dock could not draw
 * it anyway: a scheme (`https:`, `data:`, `file:`) is not a file we read, and an
 * extension outside the CLI's own table is a type `onDisk` refuses.
 *
 * Two characters at least before the colon, so a Windows drive letter stays a
 * path. No scheme in use is one character, and `imagePathsIn` already reads
 * `C:\` as a path — one spelling of that rule per repo.
 *
 * Relative about as often as a written `file_path` is, and resolved the same
 * way — the entry it was written on is the only place its directory survives.
 */
function pointedAt(target: string, cwd: unknown): string | undefined {
  let said = target;
  try {
    said = decodeURIComponent(target);
  } catch {
    // A stray `%` is not an escape. The raw text is still a path worth trying.
  }
  if (/^[a-z][a-z0-9+.-]+:/i.test(said) || !mediaForExt(path.extname(said))) {
    return undefined;
  }
  if (path.isAbsolute(said)) {
    return said;
  }
  // A relative dest with no *absolute* cwd would `path.resolve` against the
  // host's process cwd and mint a chip that opens some other file. Leave it
  // a link. A relative `cwd` is the same trap (`path.resolve('tmp', 'a.png')`).
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    return undefined;
  }
  return path.resolve(cwd, said);
}

/**
 * A run of prose with its images named beside it rather than drawn inside it.
 *
 * Every image this recognises leaves as one of two things: a ref, which the
 * chip fetches on a click, or a plain link. What it does not recognise it
 * does not touch — a reference-style `![a][ref]` still renders as the
 * engine's own broken picture, which is the old bug surviving in a corner
 * rather than a new one.
 *
 * The ref names the entry, the block and the image's place in it, so an agent
 * iterating on one temp file — overwriting `/tmp/shot.png` and showing it again
 * — is two images rather than one the webview's cache would answer twice.
 */
export function proseImages(
  said: string,
  uuid: unknown,
  block: number,
  cwd: unknown
): { prose: string; refs: ImageRef[] } {
  const quoted = [...said.matchAll(CODE_MD)].map((m) => [m.index, m.index + m[0].length]);
  const refs: ImageRef[] = [];
  const prose = said.replace(
    IMAGE_MD,
    (
      whole: string,
      alt: string,
      angled: string | undefined,
      bare: string | undefined,
      at: number,
      all: string
    ) => {
      if (quoted.some(([from, to]) => at >= (from ?? 0) && at < (to ?? 0))) {
        return whole;
      }
      const dest = angled ?? bare ?? '';
      const file = pointedAt(dest, cwd);
      if (!file) {
        // An empty alt is common in generated prose, and a link with no words
        // is a link nobody can see — less than the broken picture this
        // replaces. The destination stands in for it.
        return `[${alt || dest}](${asWritten(dest)})`;
      }
      refs.push({
        id: `f|${typeof uuid === 'string' ? uuid : ''}|${block}.${refs.length}|${file}`
      });
      // A badge — an image that is the whole of a link's text. Taking it away
      // leaves `[](href)`, which draws nothing at all, so the words stand in
      // for the picture and the chip carries the picture itself.
      const linked =
        all[at - 1] === '[' && all.slice(at + whole.length, at + whole.length + 2) === '](';
      return linked ? alt || dest : '';
    }
  );
  return {
    // What an image was the whole of: a bullet with nothing left on it, which
    // would otherwise draw as a row of empty markers above the chips.
    prose: refs.length ? prose.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]*$/gm, '') : prose,
    refs
  };
}
