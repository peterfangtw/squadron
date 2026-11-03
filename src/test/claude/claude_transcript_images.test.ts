import * as assert from 'node:assert/strict';

import * as path from 'node:path';

import { before, describe, it } from 'node:test';

import {
  assistant,
  home,
  setup,
  source,
  transcript,
  turnsIn,
  user,
  write
} from './claude_transcript_helpers';

before(setup);

describe('readImage', () => {
  it('returns the bytes of an image pasted into the turn', async () => {
    const file = await write('ri-inline', [
      { ...user([{ type: 'text', text: 'hi' }, source('image/png', 'AAAA')]), uuid: 'u-9' }
    ]);
    assert.equal(await transcript.readImage(file, 't|u-9|1'), 'data:image/png;base64,AAAA');
  });

  it('follows a path through the read that answered it', async () => {
    // The chain the CLI leaves behind: the call names the file, the result
    // carries the bytes, and only the `tool_use_id` ties the two together.
    const file = await write('ri-path', [
      user('look\n/tmp/a.png'),
      assistant([
        { type: 'tool_use', name: 'Read', id: 'tu-1', input: { file_path: '/tmp/a.png' } }
      ]),
      user([{ type: 'tool_result', tool_use_id: 'tu-1', content: [source('image/jpeg', 'BBBB')] }])
    ]);
    // The media type is the transcript's, not the extension's: a `.png` read by
    // the CLI is written down as jpeg often enough that guessing would lie.
    assert.equal(await transcript.readImage(file, 'p|/tmp/a.png'), 'data:image/jpeg;base64,BBBB');
  });

  it('yields nothing for a ref the transcript no longer reaches', async () => {
    const file = await write('ri-miss', [user('nothing here')]);
    assert.equal(await transcript.readImage(file, 'p|/tmp/gone.png'), undefined);
    assert.equal(await transcript.readImage(file, 't|nope|0'), undefined);
    assert.equal(await transcript.readImage(file, 'zzz'), undefined);
  });

  it('yields nothing for a transcript that is not there', async () => {
    assert.equal(await transcript.readImage(path.join(home, 'nope.jsonl'), 't|u|0'), undefined);
  });
});

describe('an image a turn pointed at in its prose', () => {
  /** The shape the ref carries: the entry that named it, the block it sat in,
   *  and the file. The first two are what keep two renders of one temp file
   *  from sharing an id — see `TASK_done_dock_markdown_images.md`. */
  const said = (t: string, cwd = '/repo') => ({
    type: 'assistant',
    uuid: 'u1',
    cwd,
    message: { content: [{ type: 'text', text: t }] }
  });
  const shown = async (name: string, entry: unknown) =>
    (await turnsIn(await write(name, [entry])))[0];

  it('turns an absolute path into a ref and takes the syntax out of the prose', async () => {
    const turn = await shown('md-abs', said('here it is:\n\n![render](/tmp/a.png)\n\ndone'));
    assert.deepEqual(turn?.images, [{ id: 'f|u1|0.0|/tmp/a.png' }]);
    const drawn = (turn?.blocks ?? []).flatMap((b) => ('text' in b ? [b.text] : []));
    assert.equal(drawn.length, 1);
    assert.doesNotMatch(drawn[0] ?? '', /!\[|a\.png/);
    assert.match(drawn[0] ?? '', /here it is:/);
    assert.match(drawn[0] ?? '', /done/);
  });

  it('resolves a relative path against the cwd the entry was written in', async () => {
    const cwd = path.resolve('/repo/docs');
    const turn = await shown('md-rel', said('![shot](out/b.png)', cwd));
    assert.deepEqual(turn?.images, [{ id: `f|u1|0.0|${path.join(cwd, 'out', 'b.png')}` }]);
  });

  it('leaves the prose empty rather than drawing a block of nothing', async () => {
    const turn = await shown('md-only', said('![shot](/tmp/c.png)'));
    assert.deepEqual(turn?.images, [{ id: 'f|u1|0.0|/tmp/c.png' }]);
    assert.equal((turn?.blocks ?? []).length, 0);
  });

  it('numbers the ref by the block the image sat in', async () => {
    const turn = await shown('md-block', {
      type: 'assistant',
      uuid: 'u2',
      cwd: '/repo',
      message: {
        content: [
          { type: 'text', text: 'first' },
          { type: 'tool_use', name: 'Bash' },
          { type: 'text', text: '![after](/tmp/d.png)' }
        ]
      }
    });
    assert.deepEqual(turn?.images, [{ id: 'f|u2|2.0|/tmp/d.png' }]);
  });

  it('demotes a remote image to a link, so nothing asks the network for it', async () => {
    const turn = await shown('md-remote', said('![web](https://example.com/e.png)'));
    assert.equal(turn?.images, undefined);
    const drawn = (turn?.blocks ?? []).flatMap((b) => ('text' in b ? [b.text] : []));
    assert.equal(drawn[0], '[web](https://example.com/e.png)');
  });

  it('demotes a type nothing here can read, rather than leaving a broken picture', async () => {
    const turn = await shown('md-ext', said('![vector](/tmp/f.svg)'));
    assert.equal(turn?.images, undefined);
    const drawn = (turn?.blocks ?? []).flatMap((b) => ('text' in b ? [b.text] : []));
    assert.equal(drawn[0], '[vector](/tmp/f.svg)');
  });

  it('leaves image syntax a turn was quoting rather than using', async () => {
    const quoted = 'write `![alt](/tmp/g.png)` or:\n\n```md\n![alt](/tmp/h.png)\n```\n';
    const turn = await shown('md-fenced', said(quoted));
    assert.equal(turn?.images, undefined);
    const drawn = (turn?.blocks ?? []).flatMap((b) => ('text' in b ? [b.text] : []));
    assert.equal(drawn[0], quoted);
  });

  it('keeps every image a turn named, in the order it named them', async () => {
    const turn = await shown('md-many', said('![one](/tmp/i.png) and ![two](/tmp/j.jpg)'));
    assert.deepEqual(turn?.images, [{ id: 'f|u1|0.0|/tmp/i.png' }, { id: 'f|u1|0.1|/tmp/j.jpg' }]);
  });

  it('gives two references to one file two ids, so one chip is not both', async () => {
    // The webview keys `opened` and `fetched` by id, so a shared one would open
    // both chips on one click.
    const turn = await shown('md-twice', said('![x](/tmp/x.png) again ![x](/tmp/x.png)'));
    assert.deepEqual(
      (turn?.images ?? []).map((i) => i.id),
      ['f|u1|0.0|/tmp/x.png', 'f|u1|0.1|/tmp/x.png']
    );
  });

  it('leaves a destination holding a space exactly as written', async () => {
    // CommonMark refuses this one too, so the reader still sees the path — and
    // a screenshot's own name is where spaces actually turn up.
    const raw = '![shot](/Users/me/Screen Shot 2026.png)';
    const turn = await shown('md-space', said(raw));
    assert.equal(turn?.images, undefined);
    assert.equal((turn?.blocks ?? []).flatMap((b) => ('text' in b ? [b.text] : []))[0], raw);
  });

  it('takes a spaced destination the writer wrapped in angle brackets', async () => {
    const turn = await shown('md-angle', said('![shot](</Users/me/Screen Shot.png>)'));
    assert.deepEqual(turn?.images, [{ id: 'f|u1|0.0|/Users/me/Screen Shot.png' }]);
  });

  it('reads a percent-encoded space, which is how one is written properly', async () => {
    const turn = await shown('md-pct', said('![shot](/tmp/my%20shot.png)'));
    assert.deepEqual(turn?.images, [{ id: 'f|u1|0.0|/tmp/my shot.png' }]);
  });

  it('never reaches past the line an unclosed paren opened', async () => {
    const raw = 'see ![a](/tmp/foo\n\nA paragraph with a stray ) in it.\n\nMore prose.';
    const turn = await shown('md-unclosed', said(raw));
    assert.equal(turn?.images, undefined);
    const drawn = (turn?.blocks ?? []).flatMap((b) => ('text' in b ? [b.text] : []));
    assert.equal(drawn[0], raw);
  });

  it('reads a long run with no closing paren without stalling on it', async () => {
    // The ambiguous first draft took 462 ms here, on text a live session
    // re-parses every poll. Bounded far above the real figure — this is a
    // guard against quadratic behaviour, not a benchmark.
    const raw = `![a](${'x'.repeat(32 * 1024)}`;
    const began = Date.now();
    await shown('md-backtrack', said(raw));
    // Bounded near the fixed figure, not near the broken one: the regex this
    // replaced took 462 ms here, so a looser ceiling would stay green for it.
    assert.ok(Date.now() - began < 50, 'parse took over 50ms');
  });

  it('takes an indented sample for an image, which is the trade the guard makes', async () => {
    // The four-space form reads as code only at the top level; under a list
    // item the same indent is that item's continuation, and an image in a list
    // of renders is far commoner than a sample nobody fenced. So this one is
    // read as an image on purpose — the cost of the case above it.
    const turn = await shown('md-indented', said('like this:\n\n    ![alt](/tmp/a.png)\n\nend'));
    assert.deepEqual(turn?.images, [{ id: 'f|u1|0.0|/tmp/a.png' }]);
  });

  it('leaves a sample in a tilde fence, and in one never closed', async () => {
    for (const [name, raw] of [
      ['md-tilde', '~~~md\n![alt](/tmp/a.png)\n~~~'],
      ['md-openfence', '```md\n![alt](/tmp/a.png)']
    ] as const) {
      const turn = await shown(name, said(raw));
      assert.equal(turn?.images, undefined, name);
      assert.equal(
        (turn?.blocks ?? []).flatMap((b) => ('text' in b ? [b.text] : []))[0],
        raw,
        name
      );
    }
  });

  it('gives a demoted image with no alt text something to be seen by', async () => {
    const turn = await shown('md-noalt', said('![](https://ci.example.com/a.png)'));
    assert.equal(turn?.images, undefined);
    assert.equal(
      (turn?.blocks ?? []).flatMap((b) => ('text' in b ? [b.text] : []))[0],
      '[https://ci.example.com/a.png](https://ci.example.com/a.png)'
    );
  });

  it('reads a Windows drive letter as a path, not as a scheme', async () => {
    const turn = await shown('md-win', said('![shot](C:\\renders\\shot.png)', '/repo'));
    assert.equal(turn?.images?.length, 1);
    assert.match(turn?.images?.[0]?.id ?? '', /shot\.png$/);
  });

  it('takes an escaped bang for what CommonMark says it is: a link', async () => {
    const turn = await shown('md-escaped', said('literal \\![a](/tmp/a.png)'));
    assert.equal(turn?.images, undefined);
  });

  it('leaves a prompt alone, which no engine renders anyway', async () => {
    // `renderTranscript` hands a user turn to the prose parser, whose image
    // rule is off, so this is literal text on screen and never a broken
    // picture. Rewriting it would delete words a person typed to fix something
    // they were never shown.
    const raw = 'why does ![render](/tmp/u.png) not work?';
    const turn = await shown('md-user', {
      type: 'user',
      uuid: 'u3',
      cwd: '/repo',
      message: { content: [{ type: 'text', text: raw }] }
    });
    assert.equal(turn?.images, undefined);
    assert.equal((turn?.blocks ?? []).flatMap((b) => ('text' in b ? [b.text] : []))[0], raw);
  });

  it('leaves one alone in a batched prompt too, where the blocks are rebuilt', async () => {
    const file = await write('md-batch', [
      {
        type: 'user',
        uuid: 'u4',
        cwd: '/repo',
        message: {
          content: [
            { type: 'text', text: 'first message' },
            { type: 'text', text: 'see ![a](/tmp/a.png)' }
          ]
        }
      }
    ]);
    const turns = await turnsIn(file);
    assert.equal(turns.at(-1)?.images, undefined);
    assert.match(turns.at(-1)?.text ?? '', /!\[a\]\(\/tmp\/a\.png\)/);
  });

  it('takes one indented under a list item, where a render actually sits', async () => {
    const turn = await shown('md-list', said('- results:\n\n    ![render](/tmp/r.png)\n'));
    assert.deepEqual(turn?.images, [{ id: 'f|u1|0.0|/tmp/r.png' }]);
  });

  it('leaves a badge its words, rather than a link nobody can see', async () => {
    const turn = await shown(
      'md-badge',
      said('badge: [![CI](/tmp/b.png)](https://ci.example.com)')
    );
    assert.deepEqual(turn?.images, [{ id: 'f|u1|0.0|/tmp/b.png' }]);
    assert.equal(
      (turn?.blocks ?? []).flatMap((b) => ('text' in b ? [b.text] : []))[0],
      'badge: [CI](https://ci.example.com)'
    );
  });

  it('clears a bullet an image was the whole of', async () => {
    const turn = await shown('md-bullets', said('- ![a](/tmp/a.png)\n- ![b](/tmp/b.png)'));
    assert.equal(turn?.images?.length, 2);
    assert.equal((turn?.blocks ?? []).flatMap((b) => ('text' in b ? [b.text] : [])).length, 0);
  });

  it('ignores a title beside the target', async () => {
    const turn = await shown('md-title', said('![k](/tmp/k.png "the k")'));
    assert.deepEqual(turn?.images, [{ id: 'f|u1|0.0|/tmp/k.png' }]);
  });
});
