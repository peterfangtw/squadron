import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  candidateRunners,
  commandHash,
  detectRunner,
  devHostRunner,
  resolveRunners,
  substitute
} from '../../core/devservers/runners';

/**
 * The flags here are the measured ones (task file, 2026-07-26). A test that
 * asserted a plausible flag instead would pass while the server came up
 * somewhere else.
 */

describe('detectRunner', () => {
  it('takes the one candidate script a package has', () => {
    const runner = detectRunner({ scripts: { dev: 'vite', build: 'vite build' } });
    assert.equal(runner?.id, 'dev');
    assert.equal(runner?.label, 'npm run dev');
  });

  it('resolves two candidates to nothing rather than picking one', () => {
    assert.equal(detectRunner({ scripts: { dev: 'vite', start: 'node server.js' } }), undefined);
  });

  it('resolves a package with no candidate at all to nothing', () => {
    assert.equal(detectRunner({ scripts: { build: 'tsc' } }), undefined);
    assert.equal(detectRunner(undefined), undefined);
  });

  it('gives Vite the flag it was measured to honour', () => {
    const runner = detectRunner({ scripts: { dev: 'vite' }, devDependencies: { vite: '^7.3.1' } });
    assert.equal(runner?.command, 'npm run dev -- --port ${port}');
    assert.equal(runner?.guessed, undefined);
    assert.equal(runner?.defaultPort, 5173);
  });

  it('gives Next the flag it was measured to honour', () => {
    const runner = detectRunner({ scripts: { dev: 'next dev' }, dependencies: { next: '16.2.4' } });
    assert.equal(runner?.command, 'npm run dev -- -p ${port}');
    assert.equal(runner?.defaultPort, 3000);
  });

  it('gives Astro the flag it was measured to honour', () => {
    const runner = detectRunner({
      scripts: { dev: 'astro dev' },
      dependencies: { astro: '^5.0.0' }
    });
    assert.equal(runner?.command, 'npm run dev -- --port ${port}');
    assert.equal(runner?.guessed, undefined);
    assert.equal(runner?.defaultPort, 4321);
  });

  it('gives Wrangler the flag it was measured to honour', () => {
    const runner = detectRunner({
      scripts: { dev: 'wrangler dev' },
      devDependencies: { wrangler: '^4.63.0' }
    });
    assert.equal(runner?.command, 'npm run dev -- --port ${port}');
    assert.equal(runner?.defaultPort, 8787);
  });

  it('takes one flag when a package carries two measured signals', () => {
    // acme-web's `apps/site`, observed 2026-08-04: built by astro,
    // deployed by wrangler. Both were measured to take the same flag.
    const runner = detectRunner({
      scripts: { dev: 'astro dev' },
      dependencies: { astro: '^5.0.0', wrangler: '^4.63.0' }
    });
    assert.equal(runner?.command, 'npm run dev -- --port ${port}');
    // The port follows the flag: whichever toolchain's flag was taken.
    assert.equal(runner?.defaultPort, 4321);
  });

  it('leaves an unknown toolchain on PORT alone, and says it is a guess', () => {
    const runner = detectRunner({ scripts: { dev: 'node server.js' } });
    assert.equal(runner?.command, 'npm run dev');
    assert.equal(runner?.guessed, true);
    // A flag never measured carries no port worth acting on either.
    assert.equal(runner?.defaultPort, undefined);
  });
});

describe('candidateRunners', () => {
  it('keeps the scripts detection refused to choose between', () => {
    // `tracker`, read 2026-08-12: `dev: next dev -p 3001` and `start: next start`.
    // A person picks in a second; detection cannot, and threw the list away.
    const runners = candidateRunners({
      scripts: { dev: 'next dev -p 3001', start: 'next start', build: 'next build' },
      dependencies: { next: '16.2.4' }
    });
    assert.deepEqual(
      runners.map((runner) => runner.id),
      ['dev', 'start']
    );
    // Built exactly as `detectRunner` builds the unambiguous one: the ambiguity
    // is about which script, never about how a port reaches it.
    assert.equal(runners[0]?.command, 'npm run dev -- -p ${port}');
    assert.equal(runners[0]?.defaultPort, 3000);
  });

  it('offers nothing where detection had an answer', () => {
    assert.deepEqual(candidateRunners({ scripts: { dev: 'vite', build: 'vite build' } }), []);
  });

  it('offers nothing where there was never a candidate', () => {
    // This repo: `compile`, `watch`, `lint`, `test`, and no dev server at all.
    assert.deepEqual(candidateRunners({ scripts: { compile: 'tsc -b .', lint: 'eslint .' } }), []);
    assert.deepEqual(candidateRunners(undefined), []);
  });
});

describe('resolveRunners', () => {
  const named = [{ id: 'api', label: 'API', command: 'cargo run -- --port ${port}' }];

  it('prefers what the reader wrote down over what detection found', () => {
    const runners = resolveRunners(
      '/repo',
      { commands: { '/repo': named } },
      { scripts: { dev: 'vite' } }
    );
    assert.deepEqual(runners, named);
  });

  it('falls back to detection when nothing is written down for this cwd', () => {
    const runners = resolveRunners(
      '/repo',
      { commands: { '/other': named } },
      { scripts: { dev: 'vite' } }
    );
    assert.equal(runners[0]?.id, 'dev');
  });

  it('offers nothing when detection is turned off', () => {
    assert.deepEqual(resolveRunners('/repo', { detect: false }, { scripts: { dev: 'vite' } }), []);
  });

  it('silences the dev host too when detection is off', () => {
    // The setting says whether to read `package.json` at all, and the dev host
    // is a read of `engines` — so it cannot outlive the switch that stops it.
    assert.deepEqual(
      resolveRunners(
        '/repo',
        { detect: false, ideCli: '/bin/code' },
        { engines: { vscode: '^1.95.0' } }
      ),
      []
    );
  });

  it('offers nothing for a directory with no package.json', () => {
    assert.deepEqual(resolveRunners('/repo', {}, undefined), []);
  });
});

describe('devHostRunner', () => {
  const ext = { scripts: { compile: 'tsc' }, engines: { vscode: '^1.95.0' } };

  it('offers a port-less runner for an extension', () => {
    const runner = devHostRunner('/repo', ext, '/Applications/IDE/bin/code');
    assert.equal(runner?.portless, true);
    // Compile folded in: `tsc` and `esbuild` are separate tools here, so a dev
    // host booted without the second one runs whatever was in dist/ last.
    assert.equal(
      runner?.command,
      'npm run compile && "/Applications/IDE/bin/code" --extensionDevelopmentPath="/repo"'
    );
  });

  it('keeps its legacy unescaped double quotes, which a quote or $ in a path breaks', () => {
    // A known defect, pinned rather than fixed while its spelling moves (W7.4).
    assert.equal(
      devHostRunner('/repo/a $b "c"', ext, "/Applications/I D E/it's/code")?.command,
      `npm run compile && "/Applications/I D E/it's/code" --extensionDevelopmentPath="/repo/a $b "c""`
    );
  });

  it('offers nothing for a directory that is not an extension', () => {
    assert.equal(devHostRunner('/repo', { scripts: { dev: 'vite' } }, '/bin/code'), undefined);
  });

  it('offers nothing when the host’s own launcher could not be found', () => {
    assert.equal(devHostRunner('/repo', ext, undefined), undefined);
  });

  it('rides alongside a dev server rather than competing with it', () => {
    const runners = resolveRunners(
      '/repo',
      { ideCli: '/bin/code' },
      { ...ext, scripts: { dev: 'vite', compile: 'tsc' }, devDependencies: { vite: '^7' } }
    );
    assert.deepEqual(
      runners.map((r) => r.id),
      ['dev', 'devhost']
    );
  });
});

describe('what settings are trusted for', () => {
  /**
   * `squadron.run.commands` is contributed as a bare `object`, so nothing
   * between `settings.json` and here checks a thing — it is a parse of a file
   * another program wrote, and the string form is the edit to expect.
   */
  it('takes no runner from a value that is not an array of them', () => {
    const settings = (commands: unknown) =>
      resolveRunners('/repo', { commands } as never, undefined);

    // Spread, this became twelve one-character runners with a Run button each.
    assert.deepEqual(settings({ '/repo': 'npm run dev' }), []);
    assert.deepEqual(settings({ '/repo': { command: 'npm run dev' } }), []);
    assert.deepEqual(settings({ '/repo': null }), []);
  });

  /**
   * An entry with no `command` renders, opens the picker, writes a `starting`
   * record and then throws inside `substitute` — amber for five seconds and
   * then gone, with nothing said, every time it is clicked.
   */
  it('drops an entry missing the field that runs, and keeps its siblings', () => {
    const runners = resolveRunners(
      '/repo',
      {
        commands: {
          '/repo': [
            { id: 'api', label: 'API' },
            { id: 'web', label: 'Web', command: 'npm run web' }
          ] as never
        }
      },
      undefined
    );
    assert.deepEqual(
      runners.map((r) => r.id),
      ['web']
    );
  });

  it('falls back to detection when every named entry is malformed', () => {
    const runners = resolveRunners(
      '/repo',
      { commands: { '/repo': [{ label: 'no id or command' }] as never } },
      { scripts: { dev: 'vite' } }
    );
    assert.equal(runners[0]?.id, 'dev');
  });
});

describe('substitute', () => {
  it('puts the port everywhere the command asks for it', () => {
    assert.equal(substitute('npm run dev -- --port ${port}', 4322), 'npm run dev -- --port 4322');
    assert.equal(substitute('serve ${port} ${port}', 80), 'serve 80 80');
  });

  it('leaves a portless command alone', () => {
    assert.equal(
      substitute('npm run compile && code --extensionDevelopmentPath=.', undefined),
      'npm run compile && code --extensionDevelopmentPath=.'
    );
  });
});

describe('commandHash', () => {
  it('agrees with itself and disagrees with anything else', () => {
    assert.equal(commandHash('npm run dev'), commandHash('npm run dev'));
    assert.notEqual(commandHash('npm run dev'), commandHash('pnpm dev'));
  });

  /** The whole point: same id, same label, different command in each window. */
  it('separates a named command from the detected one it shadows', () => {
    assert.notEqual(commandHash('pnpm dev --port ${port}'), commandHash('npm run dev'));
  });

  it('carries no part of the command into what it publishes', () => {
    const hash = commandHash('npm run dev -- --secret token');
    assert.match(hash, /^[0-9a-f]{16}$/);
  });
});
