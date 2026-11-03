/**
 * What a card says about a session's permission mode, in one shape for every
 * brand.
 *
 * The reading is neutral and the vocabulary behind it is not: Claude says
 * `bypassPermissions`, Grok `always-approve`, and Codex says it in two words at
 * once — an approval policy and a sandbox, either of which withholds what the
 * other grants. Each brand maps its own words
 * (`CliAdapter.permissionView`), and only this shape travels above the seam.
 *
 * A file of its own rather than `core/adapter.ts`'s, because the three brand
 * adapters need `asStated` as a **value**: that module imports each of them for
 * the registry, so importing anything but a type back out of it is the cycle
 * their headers warn about.
 */

export type PermissionView = {
  /** Ours, not the CLI's. One board shows three brands, and a reader comparing
   *  two cards should not have to know that two words mean one thing. */
  label: string;
  /** Work is held pending a reader. Claude's `plan` is the only one today. */
  holds: boolean;
  /** Nothing is asked before it is done — the colour the strip warns in. */
  bypass: boolean;
};

/**
 * A mode we have no word for, shown as the CLI named it rather than dropped:
 * an unknown word is still a word the reader can go and look up.
 *
 * Every brand's table ends here, so `undefined` out of one of them means *say
 * nothing* and never *nothing to say*.
 */
export function asStated(mode: string): PermissionView {
  return { label: mode, holds: false, bypass: false };
}
