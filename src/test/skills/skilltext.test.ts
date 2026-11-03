/**
 * Where a skill is named in prose.
 *
 * A unit test rather than a jsdom paint, because `skillPhrases` is the boundary
 * rule every mention reader keys off: `the design skills` and `soothe design
 * skill` are prose, and a match that ignored that once let a Backspace eat the
 * latter down to `soo`.
 */
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { expansionFor, skillPhrases } from '../../webview/skilltext';

const NAMES = ['design', 'ponytail', 'ponytail-audit', 'caveman:caveman'];
const found = (text: string): string[] => skillPhrases(text, NAMES).map((h) => h.text);

describe('expansionFor', () => {
  it('is the measured spelling, verbatim and namespaced', () => {
    assert.equal(expansionFor('ponytail'), 'the ponytail skill');
    // Never the alias: `the caveman skill` answers in the skill's voice and
    // loads nothing at all, which is worse than failing.
    assert.equal(expansionFor('caveman:caveman'), 'the caveman:caveman skill');
  });
});

describe('skillPhrases', () => {
  it('finds a phrase in ordinary prose', () => {
    assert.deepEqual(found('first apply the ponytail skill, then stop'), ['the ponytail skill']);
  });

  it('finds two, in text order', () => {
    assert.deepEqual(found('the design skill then the ponytail skill'), [
      'the design skill',
      'the ponytail skill'
    ]);
  });

  it('takes the longer of two names sharing a prefix', () => {
    assert.deepEqual(found('use the ponytail-audit skill'), ['the ponytail-audit skill']);
  });

  it('refuses a plural, and a match starting mid-word', () => {
    assert.deepEqual(found('the design skills'), []);
    assert.deepEqual(found('soothe design skill'), []);
  });

  it('refuses a non-ASCII letter either side, which an ASCII class let through', () => {
    // `[A-Za-z0-9]` classified every accented letter as a boundary, so this was
    // the plural bug back again for any prompt that is not pure English.
    assert.deepEqual(found('the design skillé'), []);
    assert.deepEqual(found('the design skillи'), []);
    assert.deepEqual(found('sæthe design skill'), []);
  });

  it('refuses an underscore either side, which reads as one word to a human', () => {
    assert.deepEqual(found('the design skill_v2'), []);
    assert.deepEqual(found('use_the design skill'), []);
  });

  it('refuses a hyphen either side, which joins a compound', () => {
    assert.deepEqual(found('the design skill-set'), []);
    assert.deepEqual(found('re-the design skill'), []);
  });

  it('never stretches over a word the name does not have', () => {
    assert.deepEqual(found('fix the stupid design skill'), []);
  });

  it('is happy at the very start and the very end of the text', () => {
    assert.deepEqual(found('the design skill'), ['the design skill']);
  });

  it('allows punctuation and newlines against the phrase', () => {
    assert.deepEqual(found('(the design skill)'), ['the design skill']);
    assert.deepEqual(found('do this:\nthe design skill\nthen stop'), ['the design skill']);
  });

  it('finds nothing when the machine knows nothing', () => {
    assert.deepEqual(skillPhrases('the design skill', []), []);
  });

  it('leaves a name this machine never reported as prose', () => {
    assert.deepEqual(found('the fictional skill'), []);
  });
});
