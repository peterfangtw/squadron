import { icon } from './icons';

const GROUPS = [
  [
    ['bold', 'Bold'],
    ['italic', 'Italic'],
    ['strike', 'Strikethrough']
  ],
  [
    ['bulletList', 'Bullet list'],
    ['orderedList', 'Numbered list'],
    ['blockquote', 'Blockquote']
  ],
  [
    ['code', 'Inline code'],
    ['codeBlock', 'Code block']
  ]
] as const;

export type Format = (typeof GROUPS)[number][number][0];

/** The toolbar's controls, in three groups. The first is the tab stop;
 *  `formatbar.ts` moves it. Format names are `Prose`'s. */
export function formatControls(formats?: readonly Format[]): string {
  let first = true;
  const button = ([format, label]: (typeof GROUPS)[number][number]): string => {
    const stop = first ? 0 : -1;
    first = false;
    return (
      `<button type="button" class="format" data-format="${format}" aria-label="${label}" ` +
      `data-tip="${label}" aria-pressed="false" tabindex="${stop}">${icon(format, 16)}</button>`
    );
  };
  return GROUPS.map((group) => group.filter(([format]) => !formats || formats.includes(format)))
    .filter((group) => group.length > 0)
    .map((group) => `<span class="formatgroup">${group.map(button).join('')}</span>`)
    .join('');
}
