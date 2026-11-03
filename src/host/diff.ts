/**
 * The diff behind a turn's counts: its baseline, beside the live file.
 *
 * Only what needs `vscode` is here. The before-image itself is
 * `core/git_show.ts` and the ref read the watch turns on is `core/git.ts`'s
 * `shaAt`, both where they can be tested — this file is the content provider,
 * the staleness watch, and the one command call.
 *
 * Host observations are in `docs/tasks/TASK_done_change_size.md` §Notes.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { fileIdentity, readCheckout, readTree, shaAt, type Ref } from '../core/git';
import { showAtHead, showAtTree } from '../core/git_show';

/** Ours alone, and read-only by virtue of being a content provider's. */
const SCHEME = 'squadron-before';

/**
 * The right-hand side when the file has gone: the same path, marked, answering
 * empty. `vscode.diff` against a *missing* file resolves without throwing and
 * then paints "The editor could not be opened because the file was not found"
 * over both panes — observed, after a probe that read return values had
 * recorded it as a success. An empty right side is the true statement instead:
 * every line removed, which is what happened to the file.
 */
const GONE = 'gone';

/** How often an open diff asks whether HEAD has moved under it. Matched to the
 *  panel's own poll, since that is the cadence the rest of the board is right
 *  to. Nothing runs while no diff is open — see `watch`. */
const HEAD_POLL_MS = 3000;

/**
 * The before-image's URI for a file.
 *
 * **Built here, never taken off the wire.** The webview sends a path; a URI
 * parsed from a string would honour `command:` and `vscode:` (the standing
 * argument at `panel.ts`'s `openTicket`), so this goes through `Uri.file` and
 * only then changes the scheme.
 *
 * **The path keeps the real basename and extension**, which is a hard
 * requirement rather than a nicety: VS Code infers the language from the URI
 * path, so `squadron-before:/package.json` highlights as JSON and
 * `…/package` as plaintext. Observed both ways.
 */
function beforeUri(file: string): vscode.Uri {
  return vscode.Uri.file(file).with({ scheme: SCHEME });
}

/** Back to the filesystem path the URI was built from, whatever the platform
 *  spells it (`Uri.file('C:\\a')` has path `/c:/a`, and only `fsPath` undoes it). */
function fileOf(uri: vscode.Uri): string {
  return uri.with({ scheme: 'file' }).fsPath;
}

async function missing(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return false;
  } catch {
    return true;
  }
}

/**
 * The before-image, and the one thing that can make it wrong.
 *
 * A diff tab is not restored across a window reload — observed: two open
 * `squadron-before:` tabs, and the next activation saw none and was asked for
 * no content. Baseline content can therefore live with this registration.
 */
class BeforeImages implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly baselines = new Map<string, string>();

  /** Which ref each open document's answer depends on, resolved once per
   *  document rather than per tick. `undefined` is "nothing to watch". */
  private readonly refs = new Map<string, Ref | undefined>();
  /** That ref's sha as of the last look. */
  private readonly heads = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;

  async select(file: string, base?: string): Promise<vscode.Uri> {
    const head = beforeUri(file);
    if (typeof base !== 'string' || !/^[0-9a-f]{40,64}$/.test(base)) return head;
    const uri = head.with({ query: base });
    const key = uri.toString();
    if (this.baselines.has(key)) return uri;
    const tree = await readTree(path.dirname(file));
    if (!tree) return head;
    const content = await showAtTree(tree.treeRoot, base, fileIdentity(tree.treeRoot, file));
    if (content === undefined) return head;
    this.baselines.set(key, content);
    return uri;
  }

  release(uri: vscode.Uri): void {
    if (!vscode.workspace.textDocuments.some((doc) => doc.uri.toString() === uri.toString())) {
      this.baselines.delete(uri.toString());
    }
  }

  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (uri.query === GONE) return Promise.resolve('');
    if (uri.query) return Promise.resolve(this.baselines.get(uri.toString()) ?? '');
    return showAtHead(fileOf(uri));
  }

  /**
   * Re-read on a commit, and only while someone is looking.
   *
   * Not on the panel's poll: that is one `git show` per open tab per 3s for a
   * file that has usually not moved — the cost `core/git.ts` rejects in
   * writing. And not free either, which an earlier draft had wrong: `parseHead`
   * returns the *branch name* for an attached HEAD, so a commit on the same
   * branch changes nothing the poll already reads. Detecting a move is one more
   * read — 41 bytes of `refs/heads/<branch>` — and it is spent only while an
   * `squadron-before:` document is open. Steady state is zero.
   *
   * The editor does re-read when this fires, for a document already open —
   * observed, twice.
   */
  private watch(): vscode.Disposable {
    const tick = () => void this.sweep();
    const check = () => {
      const open = this.open();
      if (open.length > 0 && !this.timer) {
        this.timer = setInterval(tick, HEAD_POLL_MS);
      }
      // The baseline is taken as a document opens rather than at the next tick,
      // and for *every* document rather than only the one that started the
      // timer. Lazily, a commit made before a tab's first tick becomes that
      // tab's baseline and the move it should have been is never seen — the
      // diff then sits stale for as long as it is open, which is the failure
      // this watch exists to prevent. Guarding the tick on timer *start* left
      // the second tab open at a time with exactly that bug.
      if (open.some((uri) => !this.heads.has(uri.toString()))) {
        tick();
      }
      if (open.length === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
        this.refs.clear();
        this.heads.clear();
      }
    };
    return vscode.Disposable.from(
      vscode.workspace.onDidOpenTextDocument(check),
      vscode.workspace.onDidCloseTextDocument(check),
      { dispose: () => this.timer && clearInterval(this.timer) }
    );
  }

  private open(): vscode.Uri[] {
    return vscode.workspace.textDocuments
      .map((doc) => doc.uri)
      .filter((uri) => uri.scheme === SCHEME && uri.query === '');
  }

  private async sweep(): Promise<void> {
    for (const uri of this.open()) {
      const key = uri.toString();
      if (!this.refs.has(key)) {
        this.refs.set(key, await refOf(fileOf(uri)));
      }
      const ref = this.refs.get(key);
      if (!ref) {
        continue;
      }
      const sha = await shaAt(ref);
      if (sha === undefined) {
        continue;
      }
      const was = this.heads.get(key);
      this.heads.set(key, sha);
      if (was !== undefined && was !== sha) {
        this.changed.fire(uri);
      }
    }
  }

  register(): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this),
      this.watch(),
      this.changed,
      // Language changes also close/reopen a document while its URI stays live.
      vscode.workspace.onDidCloseTextDocument((doc) => this.release(doc.uri)),
      { dispose: () => this.baselines.clear() }
    );
  }
}

let beforeImages: BeforeImages | undefined;

/**
 * Which ref a file's before-image follows, or nothing to follow.
 *
 * `refs/heads` is shared across a repository's working trees, so a linked
 * worktree's branch is under the *main* checkout's `.git` — which is what
 * `readCheckout` reports as `repoRoot`. Where a repository has no main checkout
 * to report, `repoRoot` is its git directory and `shaAt` reads it as one, so a
 * bare repo's worktree and a submodule are watched like anything else.
 *
 * **A detached HEAD is not watched.** Its sha lives in a `HEAD` file whose
 * location differs between the main checkout and a linked worktree's admin
 * directory, and `readCheckout` does not report either. The cost of leaving it
 * is a diff that goes stale until it is reopened, on a checkout state a session
 * is rarely in; the cost of covering it is a second path resolution for that
 * case alone. Written down rather than silently absent.
 */
async function refOf(file: string): Promise<Ref | undefined> {
  const checkout = await readCheckout(path.dirname(file));
  if (!checkout?.branch || checkout.detached) {
    return undefined;
  }
  return { repoRoot: checkout.repoRoot, branch: checkout.branch };
}

/**
 * Registered at activation, and the only thing this module exports to it.
 *
 * Built here rather than held as a module-level instance: a field initializer
 * calling `new vscode.EventEmitter()` runs at *import* time, and `dist/` is
 * loaded with nothing but a `vscode` stub to prove it imports cleanly
 * (`bundle.test.ts`). Nothing needs this before `activate()` anyway — the
 * disposable owns the only instance.
 */
export function registerBeforeImages(): vscode.Disposable {
  const provider = new BeforeImages();
  beforeImages = provider;
  return vscode.Disposable.from(provider.register(), {
    dispose: () => {
      if (beforeImages === provider) beforeImages = undefined;
    }
  });
}

/**
 * A file a turn wrote, against its baseline or HEAD when unavailable.
 *
 * **`Beside`, settled by observation.** With the panel focused, it opened a
 * *sibling* group next to the panel rather than splitting the panel's own
 * column — the fear that argued for passing no column at all, which is what
 * `openWritten` does.
 */
export async function openDiff(file: string, base?: string): Promise<void> {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return;
  const provider = beforeImages;
  const before = provider ? await provider.select(file, base) : beforeUri(file);
  const name = path.basename(file);
  const gone = await missing(file);
  const claim = before.query ? 'since this turn started' : gone ? 'at HEAD' : 'since HEAD';
  try {
    await vscode.commands.executeCommand(
      'vscode.diff',
      before,
      gone ? before.with({ query: GONE }) : vscode.Uri.file(file),
      `${name} — ${claim}${gone ? ' (deleted)' : ''}`,
      { viewColumn: vscode.ViewColumn.Beside }
    );
  } catch (error) {
    provider?.release(before);
    throw error;
  }
}
