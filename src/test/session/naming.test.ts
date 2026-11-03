import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bestName, rungOf, sourceOf } from '../../core/naming';

describe('rungOf', () => {
  it('reads both words for a guess as the one claim they are', () => {
    // `ai-title` is what discover calls a title it read out of a transcript and
    // `generated` is what live.ts publishes for one it asked for. Same claim.
    assert.equal(rungOf('ai-title'), 'generated');
    assert.equal(rungOf('generated'), 'generated');
  });

  it('reads the two words a CLI writes', () => {
    assert.equal(rungOf('derived'), 'derived');
    assert.equal(rungOf('user'), 'given');
  });

  it('reads an absent source as a name somebody gave', () => {
    // The CLI's own convention, which `sourceOf` writes back out: a derived name
    // spells the source out, an explicit one omits it.
    assert.equal(rungOf(undefined), 'given');
  });

  it('reads a word it has never seen as a statement, not a guess', () => {
    // The safe direction, and the one discover's own guard already takes: a CLI
    // that invents a third spelling for "somebody typed this" must not have it
    // read as something we may overwrite.
    assert.equal(rungOf('typed-by-a-human'), 'given');
  });
});

describe('sourceOf', () => {
  it('publishes nothing for the two rungs nobody guessed', () => {
    assert.equal(sourceOf('stated'), undefined);
    assert.equal(sourceOf('given'), undefined);
  });

  it('publishes its own word for the three that are readings', () => {
    assert.equal(sourceOf('generated'), 'generated');
    assert.equal(sourceOf('prompt'), 'prompt');
    assert.equal(sourceOf('derived'), 'derived');
  });
});

describe('bestName', () => {
  it('takes the highest rung, whatever order the caller listed them in', () => {
    const best = bestName([
      { name: 'app-3f', rung: 'derived' },
      { name: 'Own the stated name', rung: 'stated' },
      { name: 'Fix the fold', rung: 'generated' }
    ]);
    assert.deepEqual(best, { name: 'Own the stated name', rung: 'stated' });
  });

  it('ranks a title the CLI wrote above the prompt it was spawned with', () => {
    // The rule this module exists for. The crop says what the work is until
    // whichever CLI this is has had a turn to say it better.
    const best = bestName([
      { name: 'Fix the fold', rung: 'generated' },
      { name: 'fix the fold so a rename is not undo…', rung: 'prompt' }
    ]);
    assert.equal(best?.name, 'Fix the fold');
  });

  it('ranks a name somebody gave above a title the CLI wrote', () => {
    const best = bestName([
      { name: 'nightly', rung: 'given' },
      { name: 'Fix the fold', rung: 'generated' }
    ]);
    assert.equal(best?.name, 'nightly');
  });

  it('gives a tie to the last, so a newer reading of one rung wins', () => {
    // Two `given` names: the one this window spawned under, and the one a
    // `/rename` in the CLI's own UI has since written into the session file.
    const best = bestName([
      { name: 'nightly', rung: 'given' },
      { name: 'renamed in the terminal', rung: 'given' }
    ]);
    assert.equal(best?.name, 'renamed in the terminal');
  });

  it('skips a blank name rather than ranking it', () => {
    // Every source here has been seen to answer with an empty string, and a
    // card falls through to the next rung rather than showing a gap.
    const best = bestName([
      { name: '', rung: 'given' },
      { name: 'app-3f', rung: 'derived' }
    ]);
    assert.equal(best?.name, 'app-3f');
  });

  it('answers nothing when nothing names anything', () => {
    assert.equal(
      bestName([
        { name: undefined, rung: 'given' },
        { name: '', rung: 'stated' }
      ]),
      undefined
    );
  });
});
