#!/usr/bin/env node
/**
 * Keeping `src/core/catalog.ts` honest against the CLIs that are actually
 * installed.
 *
 * The catalog is rows we maintain rather than a list we ask for, which buys the
 * three things `list_models` cannot do — reach a model the CLI stopped
 * advertising, state a spelling a workflow file can name on another machine,
 * and control how a row reads — and costs the one thing it did for free:
 * noticing when the CLI's answer moves. This is that noticing, run by hand.
 *
 * **Per brand, because the brands differ.** Claude's `list_models` is a
 * *subset* of what its binary runs (`docs/reference/cli_state/models.md` § *The
 * gap: listed ⊂ runnable*), so it can only ever report
 * drift and never generate the catalog — an unlisted row has to be confirmed by
 * running it. Grok's `grok models` has no such gap, so for Grok this really is
 * a generator. Imposing Claude's limitation on Grok was a drafting error and is
 * not repeated here.
 *
 * **Nothing here runs in `npm run check`.** Every command needs a CLI binary,
 * which CI does not have, and `--probe` spends real model calls.
 *
 * Usage:
 *   npm run models:claude                  drift, both directions
 *   npm run models:claude -- --probe <id>  run one id, print what it reports
 *   npm run models:grok                    regenerate Grok's rows
 */
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const OUT = path.join(import.meta.dirname, '..', 'out');

const { CLAUDE_MODELS, GROK_MODELS } = await import(
  pathToFileURL(path.join(OUT, 'core', 'catalog.js')).href
);
const { listModels } = await import(
  pathToFileURL(path.join(OUT, 'core', 'claude', 'models.js')).href
);
const { claudeBinary } = await import(pathToFileURL(path.join(OUT, 'core', 'bin.js')).href);

const argv = process.argv.slice(2);
const brand = argv[0];
const probeAt = argv.indexOf('--probe');

/** Exit 1 on drift, so this can be a gate somewhere later without rewriting. */
let drifted = false;

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

/**
 * One id, run for a single turn. The **only** thing that can confirm a row the
 * CLI does not list: `result.modelUsage` states the canonical id and the real
 * context window, neither of which is guessable from the name — 4.7 is a
 * million and 4.6 is two hundred thousand.
 *
 * Costs one model call. That is why it is a flag and not part of the sweep.
 */
async function probeClaude(id) {
  const { stdout } = await run(
    'claude',
    ['--print', '--output-format', 'json', '--model', id, 'hi'],
    { maxBuffer: 8 * 1024 * 1024 }
  );
  const usage = JSON.parse(stdout).modelUsage ?? {};
  const entries = Object.entries(usage);
  if (!entries.length) throw new Error(`${id}: ran, but reported no modelUsage`);
  // **By key, never `[0]`.** One `--print` run can report more than one model —
  // a compaction or a summarising pass bills its own — and taking the first
  // entry would print another model's window under this id's heading. The
  // checklist in `models.md` says to copy `contextWindow` straight out of here
  // while insisting the window is never guessed, so a silently mismatched entry
  // is exactly the one-way door this catalog is most exposed to.
  //
  // The key is not always the flag: `claude-opus-5[1m]` reports under the
  // suffixed spelling, `claude-fable-5[1m]` under the bare one (probed
  // 2026-08-27, 2.1.241). So the bare form is accepted as a match, and anything
  // less certain than that is reported rather than resolved.
  const bare = id.replace(/\[[^\]]*\]$/, '');
  const hit = entries.find(([key]) => key === id) ?? entries.find(([key]) => key === bare);
  if (!hit) {
    throw new Error(
      `${id}: ran, but modelUsage names only ${entries.map(([key]) => key).join(', ')} — ` +
        `read the window by hand rather than trusting a guess`
    );
  }
  if (entries.length > 1) {
    say(`note: this run billed ${entries.length} models; reading the entry for ${hit[0]}.`);
  }
  const [key, row] = hit;
  return {
    flag: key,
    canonical: row.canonicalModel,
    contextWindow: row.contextWindow,
    maxOutput: row.maxOutputTokens
  };
}

/**
 * Both directions, which is the whole point: a row we have that the CLI has
 * dropped is not the same problem as a model the CLI grew that we have not
 * added, and reporting only one of them is how a catalog rots.
 *
 * Neither direction is a failure on its own. A row missing from `list_models`
 * is *expected* for everything marked `legacy` — that gap is why the catalog
 * exists — so the report separates the rows that were already known to be
 * unlisted from the ones that just fell out of it.
 */
async function claudeDrift() {
  const found = await claudeBinary();
  if (!found.ok) {
    say(found.reason);
    process.exitCode = 1;
    return;
  }
  const listed = await listModels(found.program, process.cwd());
  if (!listed.length) {
    say('list_models answered nothing. Is `claude` on PATH and signed in?');
    process.exitCode = 1;
    return;
  }
  const advertised = new Set(listed.flatMap((row) => [row.value, row.id].filter(Boolean)));
  // Every spelling the catalog answers to, not just `value`. Without
  // `readings` this reports drift for a row whose spellings simply differ:
  // `list_models` resolves Haiku to the dated `claude-haiku-4-5-20251001`,
  // which is in that row's readings and in no `value` anywhere. Reconciling
  // the three spellings is the field's whole job, here as much as at the tick.
  const ours = new Set(
    CLAUDE_MODELS.flatMap((row) => [row.value, row.id, ...row.readings].filter(Boolean))
  );
  const spellingsOf = (row) => [row.value, row.id, ...row.readings].filter(Boolean);

  say(`list_models answered ${listed.length} rows; the catalog carries ${CLAUDE_MODELS.length}.`);
  say();

  // Ours → theirs. A `legacy` row absent from the list is the arrangement
  // working, not drift; a *current* row that has fallen out of it is news.
  const fellOut = CLAUDE_MODELS.filter(
    (row) => !row.legacy && !spellingsOf(row).some((name) => advertised.has(name))
  );
  if (fellOut.length) {
    drifted = true;
    say('Current rows the CLI no longer advertises — mark them `legacy` or drop them:');
    for (const row of fellOut) say(`  - ${row.value}`);
    say();
  }

  const stillGone = CLAUDE_MODELS.filter(
    (row) => row.legacy && spellingsOf(row).some((name) => advertised.has(name))
  );
  if (stillGone.length) {
    drifted = true;
    say('Rows marked `legacy` that the CLI advertises again — drop the `legacy` flag:');
    for (const row of stillGone) say(`  - ${row.value}`);
    say();
  }

  // Theirs → ours, in **two** buckets, because collapsing them hides the more
  // interesting one. A row whose advertised `value` we do not carry but whose
  // `resolvedModel` we do is not a missing model — it is a request-side
  // spelling we answer under a different flag. Matching on `id` as well as
  // `value` in one filter excused every such row: `claude-fable-5[1m]` is
  // advertised, resolves to `claude-fable-5`, and was reported as covered. That
  // is the mechanism this command exists to provide, so it says both.
  const model = (row) => (row.id && row.id !== row.value ? `${row.value}  (${row.id})` : row.value);
  const unknown = listed.filter((row) => !ours.has(row.value) && !ours.has(row.id));
  if (unknown.length) {
    drifted = true;
    say('Models the CLI offers that the catalog has no row for:');
    for (const row of unknown) say(`  - ${model(row)}`);
    say('  Probe each before adding it: npm run models:claude -- --probe <id>');
    say();
  }

  // The narrow, interesting half: an advertised value carrying a context suffix
  // that the CLI itself resolves away. Anything whose *resolved* spelling keeps
  // the suffix and is not a value we carry has already been reported above as a
  // real gap, which is what a new `claude-sonnet-5[1m]` would be.
  //
  // Aliases are deliberately not reported. `opus`, `sonnet` and `haiku` are
  // advertised forever and the catalog answers them with full ids on purpose —
  // a workflow file names a model and runs on another machine. A command that
  // prints three permanent lines every run is one nobody reads.
  // A **proxy** for the `modelUsage` key, which is the real rule and which this
  // command cannot see without spending a turn. They agree on every row
  // measured on 2.1.241; a model whose `resolvedModel` dropped a suffix its key
  // kept would be filed as informational when it deserves a row. Probe before
  // deciding, which is what the note below tells the reader to do.
  const suffixed = (name) => /\[[^\]]*\]$/.test(name ?? '');
  const erased = listed.filter(
    (row) => !ours.has(row.value) && suffixed(row.value) && !suffixed(row.id) && ours.has(row.id)
  );
  if (erased.length) {
    say('Advertised suffixes the CLI resolves away, answered here by the bare flag:');
    for (const row of erased) say(`  - ${model(row)}`);
    say('  Informational, not drift. `[1m]` is how a caller *requests* 1M, so a');
    say('  suffix earns its own row only where the bare value does not already');
    say('  reach that window — `claude-opus-5[1m]` does, `claude-fable-5[1m]`');
    say('  and `claude-opus-5-5[1m]` do not. Surviving into the `modelUsage`');
    say('  key is the evidence, never the rule: cli_state/models.md');
    say('  § *The three spellings*. `base()` resolves a typed suffix either way.');
    say();
  }

  if (!drifted) {
    say(
      erased.length
        ? 'No drift. Every current row is advertised; the spelling above is a decision, not a gap.'
        : 'No drift. Every current row is advertised, and nothing is unaccounted for.'
    );
  }
  say('Unlisted-but-runnable rows are not checked here — only running them proves those.');
  say('Run src/test/live_session/model_catalog.md before a release.');
  if (drifted) process.exitCode = 1;
}

/**
 * Grok's rows, regenerated. A real generator, because `grok models` is not a
 * subset of anything: it prints what the CLI will run.
 *
 * It does **not** state a context window — that comes off a session's
 * `signals.json` — so the figure already in the catalog is carried across
 * rather than invented, and a model with no row yet is reported for a human to
 * fill in.
 */
async function grokRows() {
  const { stdout } = await run('grok', ['models'], { maxBuffer: 1024 * 1024 });
  // `  * grok-4.7 (default)` / `  - grok-4.6`. The marker is the default, which
  // the catalog does not record — order is what it records, and the default
  // leads.
  const found = [...stdout.matchAll(/^\s*[*-]\s+(\S+)/gm)].map((m) => m[1]);
  if (!found.length) {
    say('`grok models` named nothing. Is `grok` on PATH and signed in?');
    process.exitCode = 1;
    return;
  }
  const known = new Map(GROK_MODELS.map((row) => [row.value, row]));
  say('Paste into GROK_MODELS in src/core/catalog.ts, and date the comment above it:');
  say();
  for (const value of found) {
    const was = known.get(value);
    if (!was) drifted = true;
    // One row per model carrying its windows, since 2026-08-28. Grok has one
    // and reaches it plain (`GROK_MODELS` in src/core/catalog.ts).
    const windows = was?.windows ?? [];
    const first = windows[0];
    say(`  {`);
    say(`    value: '${value}',`);
    say(`    name: '${was?.name ?? value}',`);
    say(`    id: '${value}',`);
    say(`    brand: 'grok',`);
    say(`    readings: ['${value}'],`);
    if (first === undefined) {
      say(`    windows: [`);
      say(`      // UNKNOWN — read contextWindowTokens off a session's signals.json`);
      say(`      { tokens: 0, reach: 'plain' }`);
      say(`    ]`);
    } else {
      const tokens = first.tokens.toLocaleString('en-US').replace(/,/g, '_');
      say(`    windows: [{ tokens: ${tokens}, reach: 'plain' }]`);
    }
    say(`  },`);
  }
  say();
  const gone = GROK_MODELS.filter((row) => !found.includes(row.value));
  if (gone.length) {
    drifted = true;
    say(`The CLI no longer names: ${gone.map((row) => row.value).join(', ')}`);
  }
  const fresh = found.filter((value) => !known.has(value));
  if (fresh.length) {
    say(`New since the catalog was written: ${fresh.join(', ')} — each needs a window.`);
  }
  if (!gone.length && !fresh.length) say('Same models the catalog already carries.');
  // Same contract as `claudeDrift`, which set this and left Grok exiting 0 on a
  // model disappearing — the half of "exit 1 on drift" that was only written down.
  if (drifted) process.exitCode = 1;
}

if (brand === 'claude' && probeAt >= 0) {
  const id = argv[probeAt + 1];
  if (!id) {
    say('--probe needs a model id.');
    process.exitCode = 1;
  } else {
    const found = await probeClaude(id);
    say(`${id} ran.`);
    say(`  modelUsage key : ${found.flag}`);
    say(`  canonicalModel : ${found.canonical}`);
    say(`  contextWindow  : ${found.contextWindow?.toLocaleString('en-US')}`);
    say(`  maxOutputTokens: ${found.maxOutput?.toLocaleString('en-US')}`);
    say();
    say('`readings` needs the spelling a live session states, which this does not');
    say('show. Take it from an assistant frame:');
    say(`  claude --print --output-format stream-json --verbose --model '${id}' hi`);
  }
} else if (brand === 'claude') {
  await claudeDrift();
} else if (brand === 'grok') {
  await grokRows();
} else {
  say('Usage: npm run models:claude [-- --probe <id>] | npm run models:grok');
  process.exitCode = 1;
}
