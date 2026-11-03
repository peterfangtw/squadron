import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStatus } from '../../core/model';
import { CascadeRow, asTyped, cascadeList, checkoutLabel, endDetail, shorten } from '../../ui/text';

describe('checkoutLabel', () => {
  it('names ordinary native Windows checkouts and preserves legacy roots', () => {
    for (const [cwd, want] of [
      ['C:\\work\\App\\.worktrees\\ENG-42', 'ENG-42'],
      ['c:/work/App\\packages/Web/', 'Web'],
      ['\\\\srv\\share\\App', 'App'],
      ['/work/literal\\name', 'literal\\name'],
      ['/', undefined],
      ['C:/', 'C:'],
      ['C:\\', 'C:\\'],
      ['\\\\srv\\share', '\\\\srv\\share'],
      ['\\\\srv\\share\\', '\\\\srv\\share\\'],
      ['//srv/share', 'share'],
      ['//srv/share/', 'share'],
      ['C:', 'C:'],
      ['relative\\name', 'relative\\name'],
      ['\\\\?\\C:\\work\\App', '\\\\?\\C:\\work\\App']
    ] as const)
      assert.equal(checkoutLabel('/other', cwd), want, cwd);
  });
  it('says nothing about the folder that was asked about', () => {
    assert.equal(checkoutLabel('/dev/app', '/dev/app'), undefined);
  });

  it('names the checkout rather than the path to it', () => {
    // The whole reason it is not the relative path: this repo's worktrees live
    // at `.worktrees/<name>`, so every one of them would read as the ten
    // characters they share and clip where the name begins.
    assert.equal(checkoutLabel('/dev/app', '/dev/app/.worktrees/eng-1641'), 'eng-1641');
    assert.equal(checkoutLabel('/dev/app', '/dev/app/apps/web'), 'web');
    // Upward and sideways read the same way, since only the name discriminates.
    assert.equal(checkoutLabel('/dev/app/apps/web', '/dev/app'), 'app');
  });
});

describe('asTyped', () => {
  it('keeps every space a line was typed with', () => {
    // The three things CommonMark would have done with these instead: six
    // spaces open an indented code block, an indented line under a paragraph
    // is folded into it, and a run of dashes is a thematic break.
    const typed = '------\n      __\n123\n            89';
    assert.equal(asTyped(typed), `<p class="raw">${typed}</p>`);
  });

  it('escapes the markup a message might carry', () => {
    assert.equal(
      asTyped('<img src=x onerror=alert(1)> a && b'),
      '<p class="raw">&lt;img src=x onerror=alert(1)&gt; a &amp;&amp; b</p>'
    );
  });

  it('escapes the ampersand before it can build an entity', () => {
    // `&lt;` typed by hand stays four characters on screen. Replacing `<`
    // first and `&` after would turn this into a literal `<`.
    assert.equal(asTyped('&lt;b&gt;'), '<p class="raw">&amp;lt;b&amp;gt;</p>');
  });
});

describe('shorten', () => {
  it('abbreviates native home boundaries without folding component case or raw suffixes', () => {
    const home = os.homedir();
    assert.equal(shorten(home + path.sep + 'work\\App'), '~' + path.sep + 'work\\App');
    assert.equal(shorten(home.replaceAll('\\', '/') + '/work\\App'), '~/work\\App');
    assert.equal(shorten(home + '2\\App'), home + '2\\App');
    const otherCase = home.replace(/[A-Za-z](?=[^:]*$)/, (c) =>
      c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()
    );
    assert.notEqual(otherCase, home);
    assert.equal(shorten(otherCase + path.sep + 'App'), otherCase + path.sep + 'App');
    if (/^[A-Za-z]:/.test(home)) {
      const otherDriveCase = home[0]?.toLowerCase() + home.slice(1);
      assert.equal(shorten(otherDriveCase.replaceAll('\\', '/') + '/App'), '~/App');
    }
    assert.equal(shorten('D:\\work\\App'), 'D:\\work\\App');
    assert.equal(shorten('\\\\srv\\share\\App'), '\\\\srv\\share\\App');
  });
  it('contracts the home directory to a tilde', () => {
    const home = os.homedir();
    assert.equal(shorten(home), '~');
    assert.equal(shorten(home + '/work/app'), '~/work/app');
  });

  it('leaves paths outside home, and names the empty one', () => {
    assert.equal(shorten('/opt/thing'), '/opt/thing');
    assert.equal(shorten(''), '(unknown)');
  });

  it('does not contract a sibling that merely shares the prefix', () => {
    assert.equal(shorten(os.homedir() + 'x/y'), os.homedir() + 'x/y');
  });
});

describe('endDetail', () => {
  it('says only what ending always cost when nothing else is running', () => {
    // The common case, and the one that must read exactly as it always has:
    // ending an idle session is not an event worth an extra sentence.
    assert.equal(
      endDetail(0),
      'Its card goes with it. The transcript is kept, the live session is not.'
    );
  });

  it('states how much else ends, because a subtree can hold anything', () => {
    // A session that booted a development host has a whole IDE window below it;
    // one part-way through an install has that. The count is the difference
    // between a sweep and a surprise.
    assert.match(endDetail(4), /4 processes it started end with it\./);
  });

  it('counts one process as one, not as “1 processes”, and agrees the verb', () => {
    // `will be stopped too` read the same at any count. `end with it` does not,
    // so the singular takes `ends` and this is the case that pins it.
    assert.match(endDetail(1), /1 process it started ends with it\./);
  });
});

describe('cascadeList', () => {
  const row = (name: string, status: SessionStatus, waitingFor?: string): CascadeRow => ({
    name,
    status,
    waitingFor
  });

  it('names three or fewer, one to a line', () => {
    assert.equal(
      cascadeList([row('planner', 'busy'), row('peer', 'idle')]),
      'planner — busy\npeer — idle'
    );
  });

  it('names exactly three, which is where the decision turns', () => {
    // The boundary the whole trade is drawn at: three named, four counted.
    assert.equal(
      cascadeList([row('a', 'busy'), row('b', 'idle'), row('c', 'unknown')]),
      'a — busy\nb — idle\nc — unknown'
    );
  });

  it('prefers what a session is waiting for over the word “waiting”', () => {
    assert.equal(
      cascadeList([row('planner', 'waiting', 'permission prompt')]),
      'planner — permission prompt'
    );
  });

  it('counts past three, because fourteen names is a wall nobody reads', () => {
    const rows = [
      row('a', 'busy'),
      row('b', 'busy'),
      row('c', 'idle'),
      row('d', 'waiting', 'permission prompt')
    ];
    assert.equal(cascadeList(rows), '2 busy, 1 waiting, 1 idle');
  });

  it('never names a bucket with nothing in it', () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`s${i}`, 'busy'));
    assert.equal(cascadeList(rows), '5 busy');
  });

  it('accounts for every session it was given', () => {
    // What the button promises is `n + 1`; what this sentence must add up to is
    // `n`. A status this forgets to bucket would silently shrink the list.
    const rows = Array.from({ length: 14 }, (_, i) =>
      row(`s${i}`, (['busy', 'idle', 'waiting', 'unknown'] as const)[i % 4]!)
    );
    const total = cascadeList(rows)
      .split(', ')
      .reduce((sum, part) => sum + Number(part.split(' ')[0]), 0);
    assert.equal(total, rows.length);
  });

  it('buckets every status the model has', () => {
    // Exhaustive against `SessionStatus` on purpose: a fifth state added later
    // fails here rather than quietly vanishing from a destructive confirm. The
    // keys of an exhaustive record, not a hand-typed list — an array annotated
    // `SessionStatus[]` accepts a subset and would let the fifth one through.
    const each: Record<SessionStatus, true> = {
      busy: true,
      idle: true,
      waiting: true,
      unknown: true
    };
    const all = Object.keys(each) as SessionStatus[];
    const rows = [...all, ...all].map((s, i) => row(`s${i}`, s));
    assert.equal(cascadeList(rows), '2 busy, 2 waiting, 2 idle, 2 unknown');
  });

  it('counts a status it has never heard of rather than dropping it', () => {
    // The sentence is the only account a reader gets of what the button ends,
    // so an unranked status must misorder itself, never disappear. Cast because
    // the type is the point: this is the shape of a CLI vocabulary that grew.
    const rows = [
      row('a', 'busy'),
      row('b', 'busy'),
      row('c', 'idle'),
      row('d', 'paused' as SessionStatus)
    ];
    assert.equal(cascadeList(rows), '2 busy, 1 idle, 1 paused');
  });
});
