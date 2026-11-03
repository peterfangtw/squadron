import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Notice, TableCell } from '../../core/bridge/model';
import * as render from '../../core/slack/render';

const OWNER = 'T0SQUAD01:U0OWNER01';

type Block = Record<string, unknown>;

function blocks(chunk: render.Chunk | undefined): readonly Block[] {
  assert.ok(chunk);
  return chunk.blocks;
}

function markdownOf(chunk: render.Chunk | undefined): string {
  const block = blocks(chunk).find((b) => b.type === 'markdown');
  assert.ok(block, 'the chunk has a markdown block');
  return block.text as string;
}

/** Every fence line in `text`: an opener carries an info string or none, so
 *  the count alone says whether they pair up. */
function fenceLines(text: string): number {
  return text.split('\n').filter((line) => /^ {0,3}(`{3,}|~{3,})/.test(line)).length;
}

/** Paragraphs of prose until `length`, each a few hundred characters. */
function prose(length: number, seed = 'p'): string {
  const paragraphs: string[] = [];
  for (let n = 0; paragraphs.join('\n\n').length < length; n++) {
    paragraphs.push(`${seed}${n} ${'word '.repeat(60).trim()}`);
  }
  return paragraphs.join('\n\n');
}

describe('renderNotice', () => {
  const asked: Notice = {
    kind: 'permission',
    mention: OWNER,
    head: 'squadron · fix the build',
    body: 'Waiting for permission: Bash\n\nIt wants to run a command.',
    code: 'rm -rf out && npm run compile',
    buttons: [
      { label: 'Deny', payload: 'k3x9.a', tone: 'danger' },
      { label: 'End', payload: 'k3x9.b', tone: 'danger' }
    ]
  };

  it('puts the mention in the push text and in the head block', () => {
    const [chunk] = render.renderNotice(asked);
    assert.ok(chunk);
    assert.ok(chunk.text.startsWith('<@U0OWNER01> '), chunk.text);
    const [head] = blocks(chunk);
    assert.equal(head?.type, 'section');
    assert.deepEqual(head?.text, {
      type: 'mrkdwn',
      text: '<@U0OWNER01> squadron · fix the build'
    });
  });

  it('escapes a head, so markup in a session name is text', () => {
    const [chunk] = render.renderNotice({
      kind: 'finished',
      head: '<script> & <!channel>',
      body: 'ok'
    });
    const head = blocks(chunk)[0]?.text as { text: string };
    assert.equal(head.text, '&lt;script&gt; &amp; &lt;!channel&gt;');
    assert.ok(chunk?.text.startsWith('&lt;script&gt; &amp; &lt;!channel&gt;'), chunk?.text);
  });

  it('mentions nobody for a sender id it cannot read as a Slack user', () => {
    const [chunk] = render.renderNotice({ kind: 'finished', mention: 'T1:<!channel>', body: 'ok' });
    assert.ok(!chunk?.text.includes('<'), chunk?.text);
    assert.ok(!JSON.stringify(chunk?.blocks).includes('<!'));
  });

  it('keeps the push text to 150 characters: mention, head, the first line', () => {
    const [chunk] = render.renderNotice({
      ...asked,
      body: `${'long '.repeat(80)}\nsecond line`
    });
    assert.ok(chunk);
    assert.ok(!chunk.text.includes('second line'));
    assert.ok(chunk.text.replace('<@U0OWNER01> ', '').length <= 150, chunk.text);
    assert.ok(chunk.text.endsWith('…'));
  });

  it('lays a notice out as head, body, the code line, then its buttons', () => {
    const [chunk, ...more] = render.renderNotice(asked);
    assert.deepEqual(more, []);
    assert.deepEqual(
      blocks(chunk).map((b) => b.type),
      ['section', 'markdown', 'rich_text', 'actions']
    );
    const code = blocks(chunk)[2];
    assert.deepEqual(code?.elements, [
      {
        type: 'rich_text_preformatted',
        elements: [{ type: 'text', text: 'rm -rf out && npm run compile' }]
      }
    ]);
  });

  it('names each button by its place, cuts a long label, and reds a danger tone', () => {
    const [chunk] = render.renderNotice({
      kind: 'picker',
      body: 'Where?',
      buttons: [
        { label: 'x'.repeat(80), payload: 'k1.a' },
        { label: 'End', payload: 'k1.b', tone: 'danger' }
      ]
    });
    const actions = blocks(chunk).at(-1);
    assert.equal(actions?.type, 'actions');
    assert.deepEqual(actions?.elements, [
      {
        type: 'button',
        action_id: 'sq.0',
        text: { type: 'plain_text', text: `${'x'.repeat(74)}…`, emoji: true },
        value: 'k1.a'
      },
      {
        type: 'button',
        action_id: 'sq.1',
        text: { type: 'plain_text', text: 'End', emoji: true },
        value: 'k1.b',
        style: 'danger'
      }
    ]);
  });

  it("neutralises Slack's control tokens everywhere in the body, code included", () => {
    const body = [
      'Tell <!channel> & <@U0OTHER01> that a < b.',
      '',
      'Inline `<!here> & co` stays.',
      '',
      '```sh',
      'echo "<!channel>" && exit',
      '```'
    ].join('\n');
    const text = markdownOf(render.renderNotice({ kind: 'finished', body })[0]);
    assert.equal(
      text,
      [
        'Tell &lt;!channel> &amp; &lt;@U0OTHER01> that a &lt; b.',
        '',
        'Inline `&lt;!here> &amp; co` stays.',
        '',
        '```sh',
        'echo "&lt;!channel>" &amp;&amp; exit',
        '```'
      ].join('\n')
    );
  });

  // Each reads as code to a guard that pairs backticks line by line, and as
  // prose to CommonMark (markdown-it).
  for (const [what, body] of [
    ['an escaped backtick', 'see \\`<!channel>\\` now'],
    ['a code span across a line break', 'a `x\ny` <!channel> `z`'],
    ['a fence inside a list item', '- step\n  ```\n<!channel>\n```']
  ] as const) {
    it(`sends no raw < from a body with ${what}`, () => {
      const text = markdownOf(render.renderNotice({ kind: 'finished', body })[0]);
      assert.ok(!text.includes('<'), text);
      assert.ok(text.includes('&lt;!channel>'), text);
    });
  }

  it('pushes no control token from any chunk, whatever code it was in', () => {
    const line = '<!channel> <@U123456> this is a log line';
    const fenced = ['Build log:', '', '```', ...Array<string>(600).fill(line), '```'].join('\n');
    const spans = Array<string>(600).fill('Ping `<!here>` and <!channel> & go.').join('\n');
    for (const body of [fenced, spans]) {
      const chunks = render.renderNotice({ kind: 'finished', body });
      assert.ok(chunks.length > 1, 'the body spans chunks');
      chunks.forEach((chunk, i) => {
        assert.ok(!/</.test(chunk.text), `chunk ${i} pushes text only: ${chunk.text}`);
        assert.ok(chunk.text !== '', `chunk ${i} pushes something`);
        let fence = false;
        for (const block of blocks(chunk)) {
          assert.equal(block.type, 'markdown');
          for (const row of (block.text as string).split('\n')) {
            if (/^```/.test(row)) {
              fence = !fence;
            } else if (!fence) {
              assert.ok(!/<[!@]/.test(row.replace(/`[^`]*`/g, '')), `chunk ${i}: ${row}`);
            }
          }
        }
      });
    }
    const [, second] = render.renderNotice({ kind: 'finished', body: fenced });
    assert.equal(second?.text, '&lt;!channel&gt; &lt;@U123456&gt; this is a log line');
    const [, next] = render.renderNotice({ kind: 'finished', body: spans });
    assert.equal(next?.text, 'Ping `&lt;!here&gt;` and &lt;!channel&gt; &amp; go.');
  });

  it('splits a long body into chunks, head on the first and buttons on the last', () => {
    const chunks = render.renderNotice({ ...asked, body: prose(25_000) });
    assert.equal(chunks.length, 3);
    assert.deepEqual(
      chunks.map((chunk) => blocks(chunk).map((b) => b.type)),
      [['section', 'markdown'], ['markdown'], ['markdown', 'rich_text', 'actions']]
    );
    for (const chunk of chunks) assert.ok(markdownOf(chunk).length <= render.CHUNK_MAX);
    assert.ok(!chunks[1]?.text.includes('<@'), 'a later chunk pushes no mention');
  });

  it('moves a code line too long for its block into the body, whole', () => {
    const code = `echo ${'a'.repeat(render.CODE_MAX)} \`\`\`x`;
    const [chunk] = render.renderNotice({ kind: 'permission', body: 'May I?', code });
    assert.deepEqual(
      blocks(chunk).map((b) => b.type),
      ['markdown']
    );
    const text = markdownOf(chunk);
    assert.ok(text.includes(code), 'the code arrives whole');
    assert.ok(text.startsWith('May I?\n\n````\n'), 'in a fence longer than any it holds');
    assert.ok(text.endsWith('\n````'));
  });
});

describe('a table notice', () => {
  const COLUMNS = [
    { title: 'Repo folder', wrap: true as const },
    { title: 'Session title', wrap: true as const },
    { title: 'Status' },
    { title: 'PID' },
    { title: 'Slack link' },
    { title: 'Time ago' },
    { title: 'Warm' }
  ];
  const CAPTION = 'Snapshot at 2026-10-13 14:05 UTC+8';

  function row(pid: number, title = `s${pid}`): readonly TableCell[] {
    return ['app', title, 'idle', String(pid), '—', '2m ago', 'true'];
  }

  function listOf(rows: readonly (readonly TableCell[])[]): Notice {
    return {
      kind: 'list',
      body: `${CAPTION}\n\nthe fallback`,
      table: { caption: CAPTION, columns: COLUMNS, rows }
    };
  }

  type Cell = { type: string; text?: string; elements?: unknown };
  type Table = { type: 'table'; column_settings: unknown; rows: Cell[][] };

  function tableOf(chunk: render.Chunk | undefined): Table {
    const block = blocks(chunk).find((b) => b.type === 'table');
    assert.ok(block, 'the chunk has a table block');
    return block as unknown as Table;
  }

  /** What a person reads in a cell: its raw text, or the link's text and URL. */
  function read(cell: Cell): string {
    if (cell.type === 'raw_text') return cell.text ?? '';
    return JSON.stringify(cell.elements);
  }

  function cellChars(table: Table): number {
    return table.rows.flat().reduce((sum, cell) => sum + read(cell).length, 0);
  }

  it('draws a native table under the snapshot time, header first, link clickable', () => {
    const chunks = render.renderNotice(
      listOf([
        [
          'app',
          '<!channel> *bold* a<b',
          'busy',
          '10',
          { link: 'https://x/1', text: 'open' },
          '2m ago',
          'true'
        ]
      ])
    );
    assert.equal(chunks.length, 1);
    const [caption, table] = blocks(chunks[0]);
    assert.deepEqual(caption, { type: 'markdown', text: CAPTION });
    assert.equal(table?.type, 'table');
    assert.deepEqual((table as unknown as Table).column_settings, [
      { is_wrapped: true },
      { is_wrapped: true },
      { is_wrapped: false },
      { is_wrapped: false },
      { is_wrapped: false },
      { is_wrapped: false },
      { is_wrapped: false }
    ]);
    const [head, body] = (table as unknown as Table).rows;
    assert.deepEqual(
      head,
      COLUMNS.map((c) => ({ type: 'raw_text', text: c.title }))
    );
    assert.deepEqual(
      body?.[1],
      { type: 'raw_text', text: '<!channel> *bold* a<b' },
      'raw text is never markup'
    );
    assert.deepEqual(body?.[4], {
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [{ type: 'link', url: 'https://x/1', text: 'open' }]
        }
      ]
    });
    assert.match(chunks[0]?.text ?? '', /^Snapshot at 2026-10-13 14:05 UTC\+8/);
  });

  it('splits at 100 rows a message, header and snapshot time on every part, no row lost', () => {
    const rows = Array.from({ length: 250 }, (_, i) => row(i + 1));
    const chunks = render.renderNotice(listOf(rows));
    assert.equal(chunks.length, 3);
    const pids: string[] = [];
    for (const chunk of chunks) {
      const table = tableOf(chunk);
      assert.ok(table.rows.length <= 100, `${table.rows.length} rows`);
      assert.equal(read(table.rows[0]?.[0] ?? { type: 'raw_text' }), 'Repo folder');
      assert.deepEqual(blocks(chunk)[0], { type: 'markdown', text: CAPTION });
      assert.match(chunk.text, /Snapshot at/);
      pids.push(...table.rows.slice(1).map((r) => read(r[3] ?? { type: 'raw_text' })));
    }
    assert.deepEqual(
      pids,
      rows.map((r) => r[3])
    );
  });

  it('splits before 10,000 characters of cells, and bounds one huge cell so its row fits', () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => row(i + 1, 't'.repeat(900))),
      row(31, 'x'.repeat(50_000))
    ];
    const chunks = render.renderNotice(listOf(rows));
    const pids: string[] = [];
    for (const chunk of chunks) {
      const table = tableOf(chunk);
      assert.ok(cellChars(table) <= 10_000, `${cellChars(table)} cell characters`);
      pids.push(...table.rows.slice(1).map((r) => read(r[3] ?? { type: 'raw_text' })));
    }
    assert.deepEqual(
      pids,
      rows.map((r) => r[3])
    );
    const last = tableOf(chunks.at(-1)).rows.at(-1);
    assert.match(read(last?.[1] ?? { type: 'raw_text' }), /^x+…$/);
  });
});

describe('renderSettled', () => {
  it('differs from the unsettled render only in the last block', () => {
    const notice: Notice = {
      kind: 'permission',
      mention: OWNER,
      head: 'squadron · fix the build',
      body: prose(15_000),
      code: 'npm test',
      buttons: [{ label: 'Deny', payload: 'k3x9.a', tone: 'danger' }]
    };
    const before = render.renderNotice(notice).at(-1);
    const after = render.renderSettled({ ...notice, buttons: [], settled: 'Denied' });
    assert.ok(before);
    assert.equal(after.text, before.text);
    assert.deepEqual(after.blocks.slice(0, -1), before.blocks.slice(0, -1));
    assert.equal((before.blocks.at(-1) as Block).type, 'actions');
    assert.deepEqual(after.blocks.at(-1), {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Denied' }]
    });
  });

  it('escapes the settled word', () => {
    const after = render.renderSettled({ kind: 'question', body: 'q', settled: 'A <b> & c' });
    assert.deepEqual(after.blocks.at(-1), {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'A &lt;b&gt; &amp; c' }]
    });
  });
});

describe('splitBody', () => {
  it('keeps a body that fits as one chunk', () => {
    assert.deepEqual(render.splitBody('short', 100), ['short']);
  });

  it('moves the cut back to a blank line before a fence that spans it', () => {
    const before = prose(10_500);
    const fence = [
      '```ts',
      ...Array.from({ length: 40 }, (_, n) => `const line${n} = ${n};`),
      '```'
    ];
    const body = [before, fence.join('\n'), prose(14_500, 'q')].join('\n\n');
    assert.ok(body.length > 25_000);
    const fenceAt = body.indexOf('```ts');
    assert.ok(fenceAt < 11_000 && body.indexOf('\n```\n') > 11_000, 'the fence spans the cut');

    const chunks = render.splitBody(body, 11_000);
    assert.equal(chunks.join(''), body, 'the chunks rejoin to the original');
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 11_000, `${chunk.length}`);
      assert.equal(fenceLines(chunk) % 2, 0, 'fences balance in every chunk');
    }
  });

  it('closes and reopens a fence longer than a chunk', () => {
    const lines = Array.from({ length: 2_000 }, (_, n) => `line ${n} of a long log`);
    const body = ['Here is the log:', '', '~~~text', ...lines, '~~~'].join('\n');
    const chunks = render.splitBody(body, 11_000);
    assert.ok(chunks.length >= 4);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 11_000, `${chunk.length}`);
      assert.equal(fenceLines(chunk) % 2, 0, 'fences balance in every chunk');
    }
    // What the split added is a closer at the end of a chunk and the opener
    // at the start of the next; without them the body is whole and in order.
    const rejoined = chunks
      .map((chunk, i) => {
        const head = i > 0 ? chunk.replace(/^~~~text\n/, '') : chunk;
        return i < chunks.length - 1 ? head.replace(/~~~$/, '') : head;
      })
      .join('');
    assert.equal(rejoined, body);
  });

  it('cuts a line with no break hard, never inside a surrogate pair', () => {
    const body = `${'a'.repeat(99)}😀${'b'.repeat(150)}`;
    const chunks = render.splitBody(body, 100);
    assert.equal(chunks.join(''), body);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 100);
      assert.ok(!/[\uD800-\uDBFF]$/.test(chunk), 'no lone high surrogate at a cut');
    }
  });
});

describe('escapeMrkdwn', () => {
  it('escapes the three characters Slack reads as markup', () => {
    assert.equal(render.escapeMrkdwn('<@U1> & <!here>'), '&lt;@U1&gt; &amp; &lt;!here&gt;');
  });
});
