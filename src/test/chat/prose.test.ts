import * as assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import type { DOMWindow } from 'jsdom';
import { openPanel } from '../harness';
import type { ProseFormat, ProseFormats, ProseHook, ProseSnapshot } from '../../webview/prose';

/**
 * The prose input on its own, before any box mounts it: what goes in (typing,
 * a paste, markdown from disk) and what comes out (the delivery bytes, and the
 * nodes and marks the reader sees). `TASK_done_prose_input.md`, Step 3.
 *
 * The editor lives in the panel's realm, a separate module instance from
 * anything this file could import, so it is reached the way the plan says: the
 * bundle's `squadronProse.create` mounts one on a host this file made, and the
 * host element carries the instance as `prose`. Typing and selection go
 * through that hook, because they need the editor's own text-input path;
 * keys and pastes are DOM events on the editor root, as a browser sends them.
 * Its types are imported: a type import is erased, and reaches no instance.
 */

type Mounted = { prose: ProseHook; host: HTMLElement; root: HTMLElement; window: DOMWindow };

for (const [expansion, label] of [
  ['c:\\Repo Mixed\\note.md', 'note.md'],
  ['D:/Repo/note.md', 'note.md'],
  ['\\\\server\\share\\note.md', 'note.md'],
  ['/repo/a\\b.md', 'a\\b.md'],
  ['//repo/share/a\\b.md', 'a\\b.md']
] as const) {
  it(`labels a file chip from explicit path syntax: ${expansion}`, (t) => {
    const m = mount(t);
    m.prose.insertChip('file', expansion);
    assert.equal(m.root.querySelector('.pchip')?.textContent, `@${label}`);
    assert.equal(m.prose.value().trim(), expansion);
  });
}

function mount(t: TestContext, options: Record<string, unknown> = {}): Mounted {
  const p = openPanel(t);
  const factory = (
    p.window as unknown as {
      squadronProse?: { create(host: HTMLElement, options: Record<string, unknown>): unknown };
    }
  ).squadronProse;
  assert.ok(factory, 'the bundle exposes no squadronProse.create');
  const host = p.window.document.createElement('div');
  p.window.document.body.append(host);
  factory.create(host, { mode: 'rich', ...options });
  const hook = (host as unknown as { prose?: ProseHook }).prose;
  assert.ok(hook, 'the host carries no prose hook');
  const root = host.querySelector<HTMLElement>('.ProseMirror');
  assert.ok(root, 'no editor root inside the host');
  // Built in the panel's realm, so cloned into this one before any
  // deepStrictEqual compares its prototypes.
  const prose = {
    ...hook,
    snapshot: () => structuredClone(hook.snapshot()),
    formats: () => structuredClone(hook.formats())
  };
  return { prose, host, root, window: p.window };
}

/** Every node type, depth first, `doc` included. */
function kinds(node: ProseSnapshot): string[] {
  return [node.type ?? '', ...(node.content ?? []).flatMap(kinds)];
}

/** Every text node that wears a mark, with its marks. */
function marked(node: ProseSnapshot): [string, ...string[]][] {
  if (node.type === 'text') {
    const marks = (node.marks ?? []).map((m) => m.type);
    return marks.length ? [[node.text ?? '', ...marks]] : [];
  }
  return (node.content ?? []).flatMap(marked);
}

/** One paragraph's inline content, as text and `<br>`. */
function inline(snap: ProseSnapshot): string[] {
  return (snap.content?.[0]?.content ?? []).map((n) =>
    n.type === 'text' ? (n.text ?? '') : (n.type ?? '')
  );
}

type Mods = { shift?: boolean; ctrl?: boolean; alt?: boolean; keyCode?: number };

/** A keydown on the root; a Latin letter carries its `keyCode`, as a browser's does. */
function key(m: Mounted, name: string, mods: Mods = {}): KeyboardEvent {
  const event = new m.window.KeyboardEvent('keydown', {
    key: name,
    keyCode: mods.keyCode ?? (/^[a-z]$/.test(name) ? name.toUpperCase().charCodeAt(0) : 0),
    shiftKey: mods.shift ?? false,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    bubbles: true,
    cancelable: true
  });
  m.root.dispatchEvent(event);
  return event;
}

/** jsdom's navigator names no Mac, so ProseMirror's `Mod` is Control here. */
const undo = (m: Mounted): void => void key(m, 'z', { ctrl: true });

/**
 * A paste event carrying `flavours`, the way a browser hands one over. jsdom
 * has neither `ClipboardEvent` nor `DataTransfer`, so the event is a plain one
 * with a `clipboardData` that answers `types` and `getData` — the two things
 * ProseMirror and the component read.
 */
function paste(m: Mounted, flavours: Record<string, string>): void {
  const event = new m.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      types: Object.keys(flavours),
      files: [],
      items: [],
      getData: (type: string) => flavours[type] ?? ''
    }
  });
  m.root.dispatchEvent(event);
}

/** A copy event, and what the editor wrote to its clipboard. */
function copy(m: Mounted): Map<string, string> {
  const written = new Map<string, string>();
  const event = new m.window.Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      clearData: () => written.clear(),
      setData: (type: string, data: string) => written.set(type, data)
    }
  });
  m.root.dispatchEvent(event);
  return written;
}

describe('prose: typed text is sent as typed', () => {
  const literal = [
    'snake_case and _private_ and __dunder__',
    '2 * 3 * 4 and a*b*c',
    '# not a heading',
    '* not a list',
    '+ not a list either',
    'rm src/*.ts lib/*.js ~/my_dir/a-b.ts',
    'see [Image #1] and Hi![Image #2]',
    'look at @squadron[4821][/Users/me/.claude/projects/-Users-me-repo/0b1c_d2.jsonl] first',
    'ask a peer on Sonnet 5.5 200k at high effort (squadron-spawn --brand claude --model-id claude-sonnet-5-5 --context 200000 --effort high)',
    'use the design skill, then the code-review skill',
    'a < b && c > d &amp; e',
    '  leading and trailing  ',
    '  - an indented dash',
    '  > an indented quote',
    '   1. an indented number'
  ];
  for (const text of literal) {
    it(`sends ${JSON.stringify(text)} byte for byte, unformatted`, (t) => {
      const m = mount(t);
      m.prose.type(text);
      assert.equal(m.prose.value(), text);
      // A complete session reference or model expansion forms a chip (Step 6);
      // the bytes are what this pins.
      assert.deepEqual(
        [...new Set(kinds(m.prose.snapshot()))].filter((n) => n !== 'chip'),
        ['doc', 'paragraph', 'text']
      );
      assert.deepEqual(marked(m.prose.snapshot()), []);
    });
  }

  const formatted: [string, [string, ...string[]][], string][] = [
    ['a **b** c', [['b', 'bold']], 'paragraph'],
    ['an *em* word', [['em', 'italic']], 'paragraph'],
    ['x ~~y~~ z', [['y', 'strike']], 'paragraph'],
    [
      '`a *b* c` then *em*',
      [
        ['a *b* c', 'code'],
        ['em', 'italic']
      ],
      'paragraph'
    ],
    ['- item', [], 'bulletList'],
    ['1. item', [], 'orderedList'],
    ['> quote', [], 'blockquote']
  ];
  for (const [text, marks, block] of formatted) {
    it(`formats ${JSON.stringify(text)} and sends it as CommonMark`, (t) => {
      const m = mount(t);
      m.prose.type(text);
      assert.equal(m.prose.value(), text);
      assert.deepEqual(marked(m.prose.snapshot()), marks);
      assert.ok(kinds(m.prose.snapshot()).includes(block), kinds(m.prose.snapshot()).join(' '));
    });
  }

  it('typing a bullet after a hard break formats only that line and can be undone', (t) => {
    const m = mount(t);
    m.prose.type('intro');
    key(m, 'Enter', { shift: true });
    m.prose.type('- ');
    assert.equal(m.prose.formats().bulletList.active, true);
    assert.equal(m.root.querySelector('ul li')?.textContent, '');
    assert.equal(m.root.querySelector('p')?.textContent, 'intro');
    key(m, 'Backspace');
    assert.equal(m.prose.value(), 'intro\n- ');
    assert.equal(m.prose.formats().bulletList.active, false);
    m.prose.type('item');
    assert.equal(m.prose.value(), 'intro\n- item');
  });

  it('an earlier pasted marker cannot convert or swallow typing on a later line', (t) => {
    const m = mount(t);
    paste(m, { 'text/plain': '- \n-' });
    m.prose.type('x');
    assert.equal(m.prose.value(), '- \n-x');
    assert.equal(m.prose.formats().bulletList.active, false);
  });

  it('a bullet typed into a middle hard-break line leaves its neighbours intact', (t) => {
    const m = mount(t);
    m.prose.type('before');
    key(m, 'Enter', { shift: true });
    key(m, 'Enter', { shift: true });
    m.prose.type('after');
    m.prose.select(8);
    m.prose.type('- item');
    assert.equal(m.prose.formats().bulletList.active, true);
    assert.equal(m.prose.value(), 'before\n\n- item\n\nafter');
  });

  it('Shift+Enter in a plain paragraph is one newline', (t) => {
    const m = mount(t);
    m.prose.type('a');
    key(m, 'Enter', { shift: true });
    m.prose.type('b');
    assert.equal(m.prose.value(), 'a\nb');
    assert.deepEqual(inline(m.prose.snapshot()), ['a', 'hardBreak', 'b']);
  });

  it('Shift+Enter in a list starts the next item', (t) => {
    const m = mount(t);
    m.prose.type('- a');
    key(m, 'Enter', { shift: true });
    m.prose.type('b');
    assert.equal(m.prose.value(), '- a\n- b');
  });

  it('Shift+Enter on an empty item leaves the list', (t) => {
    const m = mount(t);
    m.prose.type('- a');
    key(m, 'Enter', { shift: true });
    key(m, 'Enter', { shift: true });
    m.prose.type('b');
    assert.equal(m.prose.value(), '- a\n\nb');
  });

  /** What the editor's own Enter makes of `md` with `from`–`to` selected. */
  const enterOn = (t: TestContext, md: string, from: number, to: number): string => {
    const m = mount(t);
    m.prose.importMarkdown(md);
    m.prose.select(from, to);
    key(m, 'Enter');
    return m.prose.value();
  };

  it('Shift+Enter over a range across items is Enter, and keeps the list', (t) => {
    const m = mount(t);
    m.prose.importMarkdown('- abc\n- def');
    m.prose.select(4, 13);
    key(m, 'Enter', { shift: true });
    assert.equal(m.prose.value(), enterOn(t, '- abc\n- def', 4, 13));
    assert.ok(kinds(m.prose.snapshot()).includes('bulletList'));
  });

  it('Shift+Enter in a block nested in an item is Enter, and keeps the item', (t) => {
    const md = '- a\n\n  > qq\n- b';
    const m = mount(t);
    m.prose.importMarkdown(md);
    m.prose.select(8);
    key(m, 'Enter', { shift: true });
    assert.equal(m.prose.value(), enterOn(t, md, 8, 8));
    assert.equal(kinds(m.prose.snapshot()).filter((n) => n === 'listItem').length, 2);
  });

  it('Mod-Enter in a code block leaves it, as the core keymap does', (t) => {
    const m = mount(t);
    m.prose.type('``` ');
    m.prose.type('a');
    key(m, 'Enter', { ctrl: true });
    m.prose.type('b');
    assert.equal(m.prose.value(), '```\na\n```\n\nb');
  });

  it('a closed code span holding a backtick does not hold back later formatting', (t) => {
    const m = mount(t);
    m.prose.importMarkdown('``a`b`` x');
    m.prose.type(' *y*');
    assert.deepEqual(marked(m.prose.snapshot()), [
      ['a`b', 'code'],
      ['y', 'italic']
    ]);
  });

  it('Shift+Enter in a code block is a newline inside it', (t) => {
    const m = mount(t);
    m.prose.type('``` ');
    m.prose.type('a');
    key(m, 'Enter', { shift: true });
    m.prose.type('b');
    assert.equal(m.prose.value(), '```\na\nb\n```');
    assert.deepEqual(kinds(m.prose.snapshot()), ['doc', 'codeBlock', 'text']);
  });
});

describe('prose: markdown from outside', () => {
  const imported = (t: TestContext, md: string): Mounted => {
    const m = mount(t);
    m.prose.importMarkdown(md);
    return m;
  };

  it('keeps a single newline as a line break', (t) => {
    const m = imported(t, '甲\n乙');
    assert.equal(m.prose.value(), '甲\n乙');
    assert.deepEqual(inline(m.prose.snapshot()), ['甲', 'hardBreak', '乙']);
  });

  const unsupported = [
    '# heading',
    'Title\n===',
    '![alt](http://x/y.png)',
    '[label](http://x)',
    '| a | b |\n| - | - |\n| 1 | 2 |',
    '<b>raw</b> html',
    '<div>\nblock\n</div>',
    '&amp;copy; &copy;',
    '---',
    '<http://x.y>',
    '[ref]: http://x'
  ];
  for (const md of unsupported) {
    it(`keeps the source of ${JSON.stringify(md)}`, (t) => {
      const m = imported(t, md);
      assert.equal(m.prose.value(), md);
      const nodes = new Set(kinds(m.prose.snapshot()));
      assert.deepEqual(
        [...nodes].filter((n) => !['doc', 'paragraph', 'text', 'hardBreak'].includes(n)),
        []
      );
      assert.deepEqual(marked(m.prose.snapshot()), []);
    });
  }

  it('reads a backtick run as one code span, never formatting inside it', (t) => {
    const md = '`**x**` and `the design skill` and `<b>`';
    const m = imported(t, md);
    assert.equal(m.prose.value(), md);
    assert.deepEqual(marked(m.prose.snapshot()), [
      ['**x**', 'code'],
      ['the design skill', 'code'],
      ['<b>', 'code']
    ]);
  });

  it('formats inside an unsupported label, and still sends its source (accepted)', (t) => {
    const md = '![**alt**](url)';
    const m = imported(t, md);
    assert.equal(m.prose.value(), md);
    assert.deepEqual(marked(m.prose.snapshot()), [['alt', 'bold']]);
  });

  const supported: [string, string][] = [
    ['- a\n- *b*', 'bulletList'],
    ['1. one\n2. two', 'orderedList'],
    ['> quote', 'blockquote'],
    ['```js\nconst a = 1;\n```', 'codeBlock'],
    ['~~s~~ and `c` and **b**', 'paragraph']
  ];
  for (const [md, block] of supported) {
    it(`parses ${JSON.stringify(md)} and sends it back unchanged`, (t) => {
      const m = imported(t, md);
      assert.equal(m.prose.value(), md);
      assert.ok(kinds(m.prose.snapshot()).includes(block));
    });
  }

  // Two lists meet where a ticket is appended after a list (`appendBlocks`).
  // CommonMark joins two runs of one bullet into one list, blank lines or not.
  for (const type of ['bulletList', 'orderedList']) {
    it(`keeps two adjacent ${type}s two through the serializer`, (t) => {
      const m = mount(t);
      const list = (word: string): ProseSnapshot => ({
        type,
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: word }] }]
          }
        ]
      });
      assert.ok(
        m.prose.restore({ type: 'doc', content: [list('a'), list('b')] }, { history: 'fresh' })
      );
      m.prose.importMarkdown(m.prose.value());
      assert.equal(kinds(m.prose.snapshot()).filter((k) => k === type).length, 2, m.prose.value());
    });
  }

  // Key Decisions, "Accepted normalization when a loaded prompt is edited",
  // and Step 1's whitespace deviation: each pinned so a change shows up here.
  const normalized: [string, string, string][] = [
    ['blank lines collapse to one', 'a\n\n\n\nb', 'a\n\nb'],
    ['trailing spaces before a newline go', 'a  \nb', 'a\nb'],
    ['an escaped star loads as a star', '\\*not em\\*', '*not em*'],
    ['a list re-emits with dashes', '* a\n* b', '- a\n- b'],
    ['a tilde fence re-emits with backticks', '~~~\ncode\n~~~', '```\ncode\n```'],
    ['indented code re-emits as a fence', '    indented code', '```\nindented code\n```'],
    ['runs of spaces and tabs collapse', 'a   b\tc', 'a b c'],
    ['leading indentation goes', '  leading', 'leading'],
    ['a code span holding a backtick is padded', '``a`b`` x', '`` a`b `` x']
  ];
  for (const [what, md, sent] of normalized) {
    it(`normalizes on import: ${what}`, (t) => {
      assert.equal(imported(t, md).prose.value(), sent);
    });
  }

  it('an escaped star stays unformatted', (t) => {
    assert.deepEqual(marked(imported(t, '\\*not em\\*').prose.snapshot()), []);
  });

  it('starts a fresh history: Undo after an import does not reach back past it', (t) => {
    const m = mount(t);
    m.prose.type('before');
    m.prose.importMarkdown('after');
    undo(m);
    assert.equal(m.prose.value(), 'after');
  });
});

describe('prose: paste', () => {
  /**
   * Linear's editor is ProseMirror, and its copy is that editor's clipboard
   * serialization: `data-pm-slice` on the first element, every item's text in
   * a `<p>`, a nested list inside its item. Written from that structure rather
   * than captured (orchestrator decision); piece 14 pastes a real one by hand.
   */
  const LINEAR =
    '<meta charset="utf-8"><ul data-pm-slice="1 1 []">' +
    '<li><p>Ship the <strong>prose</strong> input</p></li>' +
    '<li><p>Keep <code>value()</code> raw</p>' +
    '<ul><li><p>nested item</p></li></ul></li>' +
    '<li><p>Last one</p></li></ul>';

  it('a list copied from Linear arrives as a list', (t) => {
    const m = mount(t);
    paste(m, {
      'text/html': LINEAR,
      'text/plain': 'Ship the prose input\nKeep value() raw\nnested item\nLast one'
    });
    const nodes = kinds(m.prose.snapshot());
    assert.equal(nodes.filter((n) => n === 'bulletList').length, 2);
    assert.equal(nodes.filter((n) => n === 'listItem').length, 4);
    assert.deepEqual(marked(m.prose.snapshot()), [
      ['prose', 'bold'],
      ['value()', 'code']
    ]);
    assert.equal(
      m.prose.value(),
      '- Ship the **prose** input\n- Keep `value()` raw\n  - nested item\n- Last one'
    );
  });

  it('a pasted list with two paragraphs in an item stays loose', (t) => {
    const m = mount(t);
    paste(m, {
      'text/html': '<ul><li><p>a</p><p>a2</p></li><li><p>b</p></li></ul>',
      'text/plain': 'a\na2\nb'
    });
    assert.equal(m.prose.value(), '- a\n\n  a2\n\n- b');
  });

  it('a pasted list with a code block in an item stays loose', (t) => {
    const m = mount(t);
    paste(m, {
      'text/html': '<ul><li><p>a</p><pre><code>x</code></pre></li><li><p>b</p></li></ul>',
      'text/plain': 'a\nx\nb'
    });
    assert.equal(m.prose.value(), '- a\n\n  ```\n  x\n  ```\n\n- b');
  });

  it('HTML formatting inside the set arrives formatted', (t) => {
    const m = mount(t);
    paste(m, {
      'text/html': '<p>plain <strong>bold</strong> <em>em</em> <s>struck</s> <code>c</code></p>',
      'text/plain': 'plain bold em struck c'
    });
    assert.deepEqual(marked(m.prose.snapshot()), [
      ['bold', 'bold'],
      ['em', 'italic'],
      ['struck', 'strike'],
      ['c', 'code']
    ]);
    assert.equal(m.prose.value(), 'plain **bold** *em* ~~struck~~ `c`');
  });

  it('an HTML element outside the set arrives as its text', (t) => {
    const m = mount(t);
    paste(m, {
      'text/html':
        '<h2>Heading</h2><p><a href="http://x">link</a> and <u>under</u></p><img src="http://x/y.png">',
      'text/plain': 'Heading\nlink and under'
    });
    assert.deepEqual([...new Set(kinds(m.prose.snapshot()))].sort(), ['doc', 'paragraph', 'text']);
    assert.deepEqual(marked(m.prose.snapshot()), []);
    assert.equal(m.prose.value(), 'Heading\n\nlink and under');
  });

  it('plain text alone is inserted literally, every newline kept', (t) => {
    const m = mount(t);
    paste(m, { 'text/plain': 'a\n\n\nb' });
    assert.equal(m.prose.value(), 'a\n\n\nb');
    assert.deepEqual(inline(m.prose.snapshot()), ['a', 'hardBreak', 'hardBreak', 'hardBreak', 'b']);
  });

  it('plain text keeps trailing spaces and folds CRLF', (t) => {
    const m = mount(t);
    paste(m, { 'text/plain': 'x  \r\ny  ' });
    assert.equal(m.prose.value(), 'x  \ny  ');
  });

  it('plain text that looks like markdown stays literal', (t) => {
    const m = mount(t);
    paste(m, { 'text/plain': '**not bold** _x_ # h' });
    assert.equal(m.prose.value(), '**not bold** _x_ # h');
    assert.deepEqual(marked(m.prose.snapshot()), []);
  });

  /**
   * Measured 2026-10-06 on stock VS Code 1.140.0: a synthetic `copy` event
   * with a fresh `DataTransfer`, dispatched on the editor's focused
   * `.native-edit-context` after Select All, came back with these four types
   * and this HTML — one `<div>` per line, a `<br>` per blank line. The system
   * clipboard was never touched.
   */
  const VSCODE_TEXT = 'function f() {\n    return a_b * c;\n\n}\n';
  const VSCODE = {
    'application/vnd.code.copymetadata': '{"id":"b2d40586","providerCopyMimeTypes":[]}',
    'text/plain': VSCODE_TEXT,
    'text/html':
      '<div style="color: #bbbebf;background-color: #121314;font-family: Menlo, Monaco, \'Courier New\', monospace;font-weight: normal;font-size: 12px;line-height: 18px;white-space: pre;">' +
      '<div><span style="color: #ff7b72;">function</span><span style="color: #bbbebf;"> </span><span style="color: #d2a8ff;">f</span><span style="color: #bbbebf;">() </span><span style="color: #c9d1d9;">{</span></div>' +
      '<div><span style="color: #c9d1d9;">    </span><span style="color: #c586c0;">return</span><span style="color: #c9d1d9;"> a_b </span><span style="color: #d4d4d4;">*</span><span style="color: #c9d1d9;"> c;</span></div>' +
      '<br><div><span style="color: #c9d1d9;">}</span></div><br></div>',
    'vscode-editor-data':
      '{"version":1,"id":"7d3581d9","isFromEmptySelection":false,"multicursorText":null,"mode":"typescript"}'
  };

  it('a copy from a code editor pastes its plain text, not its HTML', (t) => {
    const m = mount(t);
    paste(m, VSCODE);
    assert.equal(m.prose.value(), VSCODE_TEXT);
    assert.deepEqual([...new Set(kinds(m.prose.snapshot()))].sort(), [
      'doc',
      'hardBreak',
      'paragraph',
      'text'
    ]);
  });

  it("a copy's plain text is the markdown, its HTML the formatting", (t) => {
    const m = mount(t);
    m.prose.importMarkdown('- **a**\n- b');
    key(m, 'a', { ctrl: true });
    const written = copy(m);
    assert.equal(written.get('text/plain'), '- **a**\n- b');
    assert.match(written.get('text/html') ?? '', /<ul[^>]*><li><p><strong>a<\/strong>/);
  });

  it('the same HTML without the code editor flavour is read as HTML', (t) => {
    const m = mount(t);
    const { 'vscode-editor-data': _flavour, ...html } = VSCODE;
    paste(m, html);
    // A paragraph per line: every newline doubled, which is the rule's reason.
    assert.equal(m.prose.value(), 'function f() {\n\n    return a_b * c;\n\n\n\n}');
  });

  it('a code editor copy with no plain text is read as HTML, not dropped', (t) => {
    const m = mount(t);
    const { 'text/plain': _text, ...rest } = VSCODE;
    paste(m, rest);
    assert.match(m.prose.value(), /^function f\(\) \{/);
  });
});

describe('prose: plain mode', () => {
  const plain = (t: TestContext): Mounted => mount(t, { mode: 'plain' });

  const texts = [
    '**x** and _y_ and `z`',
    'a\n\n\nb',
    '  lead\ttab  ',
    '# h\n- l\n> q\n1. o',
    '甲\n乙',
    '<b>raw</b> &amp;',
    '\n\nedges\n\n',
    ''
  ];
  for (const text of texts) {
    it(`takes ${JSON.stringify(text)} in and gives the same out`, (t) => {
      const m = plain(t);
      m.prose.importMarkdown(text);
      assert.equal(m.prose.value(), text);
      assert.deepEqual(
        [...new Set(kinds(m.prose.snapshot()))].filter((n) => n !== 'text'),
        ['doc', 'paragraph']
      );
      assert.deepEqual(marked(m.prose.snapshot()), []);
    });
  }

  it('folds CR and CRLF to a newline', (t) => {
    const m = plain(t);
    m.prose.importMarkdown('a\r\nb\rc');
    assert.equal(m.prose.value(), 'a\nb\nc');
  });

  it('typed markdown stays literal', (t) => {
    const m = plain(t);
    m.prose.type('**x** and *y* and `z` ');
    assert.equal(m.prose.value(), '**x** and *y* and `z` ');
    assert.deepEqual(marked(m.prose.snapshot()), []);
  });

  it('a list marker typed at the start stays text', (t) => {
    const m = plain(t);
    m.prose.type('- a');
    assert.deepEqual(kinds(m.prose.snapshot()), ['doc', 'paragraph', 'text']);
  });

  it('Enter and Shift+Enter are each one newline', (t) => {
    const m = plain(t);
    m.prose.type('a');
    key(m, 'Enter');
    m.prose.type('b');
    key(m, 'Enter', { shift: true });
    m.prose.type('c');
    assert.equal(m.prose.value(), 'a\nb\nc');
  });

  it('a paste takes the plain text even beside HTML', (t) => {
    const m = plain(t);
    paste(m, { 'text/html': '<p><strong>a</strong></p><p>b</p>', 'text/plain': 'a\n\n\nb' });
    assert.equal(m.prose.value(), 'a\n\n\nb');
    assert.deepEqual(marked(m.prose.snapshot()), []);
  });

  it('a paste with HTML only is read into the plain schema, not dropped', (t) => {
    const m = plain(t);
    paste(m, { 'text/html': '<p><strong>a</strong></p><p>b</p>' });
    assert.equal(m.prose.value(), 'a\nb');
    assert.deepEqual(marked(m.prose.snapshot()), []);
  });

  it('refuses a rich snapshot, and keeps what it had', (t) => {
    const rich = mount(t);
    rich.prose.importMarkdown('**x**');
    const m = plain(t);
    m.prose.importMarkdown('kept');
    assert.equal(m.prose.restore(rich.prose.snapshot(), { history: 'fresh' }), false);
    assert.equal(m.prose.value(), 'kept');
  });

  it('a snapshot restores the same text', (t) => {
    const m = plain(t);
    m.prose.importMarkdown('one\n\ntwo');
    const snap = m.prose.snapshot();
    m.prose.importMarkdown('');
    assert.equal(m.prose.restore(snap, { history: 'fresh' }), true);
    assert.equal(m.prose.value(), 'one\n\ntwo');
  });

  it('a copy writes one newline between lines', (t) => {
    const m = plain(t);
    m.prose.importMarkdown('a\n\nb');
    m.prose.select(1, 7);
    assert.equal(copy(m).get('text/plain'), 'a\n\nb');
  });
});

describe('prose: lifecycle', () => {
  it('mounts one editable root in its host', (t) => {
    const m = mount(t);
    assert.equal(m.host.querySelectorAll('.ProseMirror').length, 1);
    assert.equal(m.root.getAttribute('contenteditable'), 'true');
    assert.equal(m.prose.value(), '');
  });

  it('calls onChange for an edit, and not for an import or a restore', (t) => {
    let changes = 0;
    const m = mount(t, { onChange: () => changes++ });
    m.prose.importMarkdown('loaded');
    const snap = m.prose.snapshot();
    m.prose.restore(snap, { history: 'fresh' });
    assert.equal(changes, 0);
    m.prose.type('x');
    assert.equal(changes, 1);
  });

  it('update swaps the callbacks on the same editor', (t) => {
    const seen: string[] = [];
    const m = mount(t, { onChange: () => seen.push('old') });
    m.prose.update({ onChange: () => seen.push('new') });
    m.prose.type('x');
    assert.deepEqual(seen, ['new']);
    assert.equal(m.host.querySelector('.ProseMirror'), m.root);
  });

  it('read-only stops editing and comes back', (t) => {
    const m = mount(t);
    m.prose.importMarkdown('kept');
    m.prose.update({ readOnly: true });
    assert.equal(m.root.getAttribute('contenteditable'), 'false');
    paste(m, { 'text/plain': 'pasted' });
    assert.equal(m.prose.value(), 'kept');
    m.prose.update({ readOnly: false });
    assert.equal(m.root.getAttribute('contenteditable'), 'true');
    assert.equal(m.host.querySelector('.ProseMirror'), m.root);
  });

  it('read-only also holds in plain mode, where paste is ours', (t) => {
    const m = mount(t, { mode: 'plain', readOnly: true });
    paste(m, { 'text/plain': 'pasted' });
    assert.equal(m.prose.value(), '');
  });

  it('shows the placeholder on an empty box, and update changes it', (t) => {
    const m = mount(t, { placeholder: 'Say something' });
    const empty = (): string | null | undefined =>
      m.root.querySelector('p')?.getAttribute('data-placeholder');
    assert.equal(empty(), 'Say something');
    m.prose.update({ placeholder: 'Reply' });
    assert.equal(empty(), 'Reply');
  });

  it('names the editor root for assistive tech, and update renames it', (t) => {
    const m = mount(t, { label: 'Message' });
    assert.equal(m.root.getAttribute('aria-label'), 'Message');
    assert.equal(m.root.getAttribute('role'), 'textbox');
    assert.equal(m.root.getAttribute('aria-multiline'), 'true');
    m.prose.update({ label: 'Answer' });
    assert.equal(m.root.getAttribute('aria-label'), 'Answer');
  });

  it('onKey sees a key before the editor and can keep it', (t) => {
    const keys: string[] = [];
    const m = mount(t, {
      onKey: (event: KeyboardEvent) => {
        keys.push(`${event.shiftKey ? 'Shift+' : ''}${event.key}`);
        return event.key === 'Enter' && !event.shiftKey;
      }
    });
    m.prose.type('a');
    key(m, 'Enter');
    assert.deepEqual(keys, ['Enter']);
    assert.equal(m.prose.value(), 'a');
    key(m, 'Enter', { shift: true });
    m.prose.type('b');
    assert.deepEqual(keys, ['Enter', 'Shift+Enter']);
    assert.equal(m.prose.value(), 'a\nb');
  });

  it("without onKey, Enter is the editor's own: a new paragraph", (t) => {
    const m = mount(t);
    m.prose.type('a');
    key(m, 'Enter');
    m.prose.type('b');
    assert.equal(m.prose.value(), 'a\n\nb');
  });

  it('Undo walks back typing', (t) => {
    const m = mount(t);
    m.prose.type('abc');
    undo(m);
    assert.equal(m.prose.value(), '');
  });

  it("keeps Undo, Redo and Select All from the host's webview shim, and lets copy through", (t) => {
    for (const mode of ['rich', 'plain']) {
      const m = mount(t, { mode });
      const heard: string[] = [];
      m.window.addEventListener('keydown', (e) => heard.push(`${e.shiftKey ? 'S-' : ''}${e.key}`));
      m.prose.type('abc');
      undo(m);
      assert.equal(m.prose.value(), '', `${mode}: the editor's own Undo still ran`);
      key(m, 'z', { ctrl: true, shift: true });
      assert.equal(m.prose.value(), 'abc', `${mode}: the editor's own Redo still ran`);
      key(m, 'y', { ctrl: true });
      key(m, 'a', { ctrl: true });
      // ⌘Z on a Russian layout: the frame keys on the code, and so does the guard.
      key(m, 'я', { ctrl: true, keyCode: 90 });
      assert.deepEqual(heard, [], `${mode}: a history or select-all key left the editor`);
      key(m, 'c', { ctrl: true });
      key(m, 'x');
      assert.deepEqual(heard, ['c', 'x'], `${mode}: copy and a plain key must still bubble`);
    }
  });

  // ProseMirror itself prevents a bare Mod-Z or Mod-Y; Shift+Mod-Z with no
  // Redo left would otherwise reach the browser's native redo.
  it("prevents the browser's own Redo even where the editor has nothing to redo", (t) => {
    for (const mode of ['rich', 'plain']) {
      const m = mount(t, { mode });
      m.prose.type('abc');
      m.prose.restore(m.prose.snapshot(), { history: 'fresh' });
      assert.equal(key(m, 'z', { ctrl: true }).defaultPrevented, true, `${mode}: Undo`);
      assert.equal(
        key(m, 'z', { ctrl: true, shift: true }).defaultPrevented,
        true,
        `${mode}: Redo`
      );
      assert.equal(m.prose.value(), 'abc');
    }
  });

  it('restore installs a fresh history: A, then B restored, then Undo stays B', (t) => {
    const m = mount(t);
    m.prose.type('B text');
    const b = m.prose.snapshot();
    m.prose.importMarkdown('');
    m.prose.type('A text');
    m.prose.restore(b, { history: 'fresh' });
    assert.equal(m.prose.value(), 'B text');
    undo(m);
    assert.equal(m.prose.value(), 'B text');
    m.prose.type('!');
    undo(m);
    assert.equal(m.prose.value(), 'B text');
  });

  it('a snapshot keeps nodes and marks, and restores them', (t) => {
    const m = mount(t);
    m.prose.importMarkdown('- **a**\n- `b`');
    const snap = m.prose.snapshot();
    m.prose.importMarkdown('');
    m.prose.restore(snap, { history: 'fresh' });
    assert.equal(m.prose.value(), '- **a**\n- `b`');
    assert.deepEqual(marked(m.prose.snapshot()), [
      ['a', 'bold'],
      ['b', 'code']
    ]);
  });

  it('a selection is where typing lands', (t) => {
    const m = mount(t);
    m.prose.type('hello world');
    m.prose.select(7, 12);
    m.prose.type('there');
    assert.equal(m.prose.value(), 'hello there');
  });

  it('focus puts the caret in the editor', (t) => {
    const m = mount(t);
    m.prose.focus();
    assert.equal(m.window.document.activeElement, m.root);
  });

  it('destroy empties the host and drops the hook', (t) => {
    const m = mount(t);
    m.prose.destroy();
    m.prose.destroy();
    assert.equal(m.host.childElementCount, 0);
    assert.equal((m.host as unknown as { prose?: unknown }).prose, undefined);
  });

  it('after destroy, a late call says so by name', (t) => {
    const m = mount(t);
    m.prose.destroy();
    assert.throws(() => m.prose.value(), /prose: used after destroy/);
    assert.throws(() => m.prose.importMarkdown('x'), /prose: used after destroy/);
    assert.throws(() => m.prose.update({ readOnly: true }), /prose: used after destroy/);
  });
});

const MODEL =
  'a peer on Sonnet 5.5 (squadron-spawn --brand claude --model-id claude-sonnet-5-5 --context 200000)';
const MODEL_HIGH =
  'a peer on Sonnet 5.5 at high effort (squadron-spawn --brand claude --model-id claude-sonnet-5-5 --effort high)';
const REF = '@squadron[4821][/Users/me/.claude/projects/-Users-me-repo/0b1c_d2.jsonl]';

/** Every chip, as its attrs. */
function chips(node: ProseSnapshot): Record<string, unknown>[] {
  if (node.type === 'chip') return [{ ...node.attrs }];
  return (node.content ?? []).flatMap(chips);
}

/** What each chip shows the reader. */
const labels = (m: Mounted): string[] =>
  [...m.root.querySelectorAll('.pchip')].map((chip) => chip.textContent ?? '');

/** A composition event; ProseMirror reads only its type. */
function compose(m: Mounted, phase: 'start' | 'end'): void {
  m.root.dispatchEvent(new m.window.Event(`composition${phase}`, { bubbles: true }));
}

describe('prose: chips', () => {
  const chipped = (t: TestContext): Mounted => mount(t, { skills: ['design', 'code-review'] });

  it('a chip is sent as its expansion and shows its label', (t) => {
    const m = chipped(t);
    m.prose.type('ask ');
    m.prose.insertChip('model', MODEL);
    m.prose.type('now');
    assert.equal(m.prose.value(), `ask ${MODEL} now`);
    assert.deepEqual(labels(m), ['@Sonnet 5.5']);
    assert.deepEqual(chips(m.prose.snapshot()), [
      { kind: 'model', expansion: MODEL, attachmentId: null }
    ]);
  });

  it('Hi! before an image chip is sent unescaped', (t) => {
    // An insert sets a chip apart, so the `!` touches it only in a document
    // restored that way.
    const m = chipped(t);
    const image = { kind: 'image', expansion: '[Image #1]', attachmentId: 'img-1' };
    const doc: ProseSnapshot = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hi!' },
            { type: 'chip', attrs: image }
          ]
        }
      ]
    };
    assert.ok(m.prose.restore(doc, { history: 'fresh' }));
    assert.equal(m.prose.value(), 'Hi![Image #1]');
    assert.deepEqual(chips(m.prose.snapshot()), [
      { kind: 'image', expansion: '[Image #1]', attachmentId: 'img-1' }
    ]);
  });

  it('each kind derives its label from its expansion', (t) => {
    const m = chipped(t);
    m.prose.insertChip('skill', 'the design skill');
    m.prose.insertChip('model', MODEL_HIGH);
    m.prose.insertChip('session', REF);
    m.prose.insertChip('file', '/Users/me/repo/notes.md', 'file-1');
    m.prose.insertChip('image', '[Image #1]', 'img-1');
    assert.deepEqual(labels(m), [
      '@design',
      '@Sonnet 5.5 · high',
      '@session 4821',
      '@notes.md',
      '[Image #1]'
    ]);
  });

  it('a restored document numbers its image chips in order', (t) => {
    // A merge (a draft promoted onto a session with an image of its own)
    // hands over two chips that each say #1; nothing is typed to renumber them.
    const m = chipped(t);
    const image = (id: string): ProseSnapshot => ({
      type: 'chip',
      attrs: { kind: 'image', expansion: '[Image #1]', attachmentId: id }
    });
    const doc: ProseSnapshot = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [image('a')] },
        { type: 'paragraph', content: [image('b')] }
      ]
    };
    assert.ok(m.prose.restore(doc, { history: 'fresh' }));
    assert.deepEqual(labels(m), ['[Image #1]', '[Image #2]']);
    assert.equal(m.prose.value(), '[Image #1]\n\n[Image #2]');
  });

  it("a session chip shows the card's name when the box can say it", (t) => {
    const m = mount(t, { sessionName: (pid: number) => (pid === 4821 ? 'Builder' : undefined) });
    m.prose.insertChip('session', REF);
    assert.deepEqual(labels(m), ['@Builder']);
  });

  it('a snapshot keeps a chip, and restores it', (t) => {
    const m = chipped(t);
    m.prose.insertChip('image', '[Image #1]', 'img-1');
    const snap = m.prose.snapshot();
    m.prose.importMarkdown('');
    assert.equal(m.prose.restore(snap, { history: 'fresh' }), true);
    assert.equal(m.prose.value(), '[Image #1] ');
    assert.equal(chips(m.prose.snapshot())[0]?.attachmentId, 'img-1');
  });

  it('one Backspace removes a whole chip', (t) => {
    const m = chipped(t);
    m.prose.type('a ');
    m.prose.insertChip('skill', 'the design skill');
    m.prose.select(4);
    key(m, 'Backspace');
    assert.equal(m.prose.value(), 'a  ');
    assert.deepEqual(chips(m.prose.snapshot()), []);
  });

  it('one Delete removes a whole chip after the caret', (t) => {
    const m = chipped(t);
    m.prose.type('a ');
    m.prose.insertChip('skill', 'the design skill');
    m.prose.type('b');
    m.prose.select(3);
    key(m, 'Delete');
    assert.equal(m.prose.value(), 'a  b');
  });

  it('Undo brings a deleted chip back whole', (t) => {
    const m = chipped(t);
    m.prose.insertChip('image', '[Image #1]', 'img-1');
    m.prose.select(2);
    key(m, 'Backspace');
    assert.deepEqual(chips(m.prose.snapshot()), []);
    undo(m);
    assert.deepEqual(chips(m.prose.snapshot()), [
      { kind: 'image', expansion: '[Image #1]', attachmentId: 'img-1' }
    ]);
  });

  it('inserted over a select-all, a chip replaces everything', (t) => {
    const m = chipped(t);
    m.prose.importMarkdown('- a\n- b');
    key(m, 'a', { ctrl: true });
    m.prose.insertChip('image', '[Image #1]', 'img-1');
    assert.equal(m.prose.value(), '[Image #1] ');
    m.prose.type('x');
    assert.equal(m.prose.value(), '[Image #1] x');
  });

  it('inserted in a code block, a chip lands in a new paragraph after it', (t) => {
    const m = chipped(t);
    m.prose.type('``` ');
    m.prose.type('x');
    m.prose.insertChip('image', '[Image #1]', 'img-1');
    assert.equal(m.prose.value(), '```\nx\n```\n\n[Image #1] ');
    assert.deepEqual(kinds(m.prose.snapshot()), [
      'doc',
      'codeBlock',
      'text',
      'paragraph',
      'chip',
      'text'
    ]);
  });
});

describe('prose: chips form from complete text', () => {
  const chipped = (t: TestContext): Mounted => mount(t, { skills: ['design', 'code-review'] });

  it('a skill phrase forms once a non-word character bounds it', (t) => {
    const m = chipped(t);
    m.prose.type('use the design skill');
    assert.deepEqual(chips(m.prose.snapshot()), []);
    m.prose.type(', then');
    assert.deepEqual(chips(m.prose.snapshot()), [
      { kind: 'skill', expansion: 'the design skill', attachmentId: null }
    ]);
    assert.deepEqual(labels(m), ['@design']);
    assert.equal(m.prose.value(), 'use the design skill, then');
  });

  it('a phrase that runs on into a word never forms', (t) => {
    const m = chipped(t);
    m.prose.type('the design skills and the design skill-set and the design skill.');
    assert.deepEqual(labels(m), ['@design']);
    assert.equal(
      m.prose.value(),
      'the design skills and the design skill-set and the design skill.'
    );
  });

  it('a skill the box does not offer never forms', (t) => {
    const m = chipped(t);
    m.prose.type('the ponytail skill and the design skill.');
    assert.deepEqual(labels(m), ['@design']);
  });

  it('a session reference forms at its closing bracket', (t) => {
    const m = chipped(t);
    m.prose.type(REF);
    assert.deepEqual(chips(m.prose.snapshot()), [
      { kind: 'session', expansion: REF, attachmentId: null }
    ]);
    assert.equal(m.prose.value(), REF);
  });

  it('a model expansion forms at its closing parenthesis', (t) => {
    const m = chipped(t);
    m.prose.type(MODEL);
    assert.deepEqual(labels(m), ['@Sonnet 5.5']);
    assert.equal(m.prose.value(), MODEL);
  });

  it('a phrase inside inline code never forms', (t) => {
    const m = chipped(t);
    m.prose.type('`the design skill` and the design skill.');
    assert.deepEqual(labels(m), ['@design']);
    assert.deepEqual(marked(m.prose.snapshot()), [['the design skill', 'code']]);
  });

  it('a phrase inside a code span still open never forms', (t) => {
    const m = chipped(t);
    m.prose.type('`the design skill and` the design skill.');
    assert.deepEqual(labels(m), ['@design']);
    assert.deepEqual(marked(m.prose.snapshot()), [['the design skill and', 'code']]);
  });

  it('a phrase inside a code block never forms', (t) => {
    const m = chipped(t);
    m.prose.type('``` ');
    m.prose.type(`the design skill ${REF} `);
    assert.deepEqual(chips(m.prose.snapshot()), []);
    key(m, 'Enter', { ctrl: true });
    m.prose.type('the design skill.');
    assert.deepEqual(labels(m), ['@design']);
  });

  it('waits out an IME composition, then forms', async (t) => {
    const m = chipped(t);
    compose(m, 'start');
    m.prose.type('the design skill ');
    assert.deepEqual(chips(m.prose.snapshot()), []);
    compose(m, 'end');
    // Formed a microtask later, after ProseMirror's own flush of the composition.
    await Promise.resolve();
    assert.equal(chips(m.prose.snapshot()).length, 1);
    assert.equal(m.prose.value(), 'the design skill ');
  });

  it('Undo right after a chip forms gives the text back, and it does not form again', (t) => {
    const m = chipped(t);
    m.prose.type('use the design skill,');
    assert.equal(chips(m.prose.snapshot()).length, 1);
    undo(m);
    assert.deepEqual(chips(m.prose.snapshot()), []);
    assert.equal(m.prose.value(), 'use the design skill,');
    m.prose.type(' then');
    assert.deepEqual(chips(m.prose.snapshot()), []);
    assert.equal(m.prose.value(), 'use the design skill, then');
  });

  it('a further Undo walks back the typing without forming anything', (t) => {
    const m = chipped(t);
    m.prose.type('use the design skill,');
    assert.equal(chips(m.prose.snapshot()).length, 1);
    undo(m);
    undo(m);
    assert.deepEqual(chips(m.prose.snapshot()), []);
    assert.equal(m.prose.value(), '');
  });

  it('an undone phrase forms again once it is edited, even to the same length', (t) => {
    const m = chipped(t);
    m.prose.type('use the design skill,');
    undo(m);
    // The `d` of `design`, retyped: an edit inside, with no change of length.
    m.prose.select(9, 10);
    m.prose.type('d');
    assert.deepEqual(labels(m), ['@design']);
    assert.equal(m.prose.value(), 'use the design skill,');
  });

  it('a phrase typed fresh after an undone one still forms', (t) => {
    const m = chipped(t);
    m.prose.type('the design skill,');
    undo(m);
    m.prose.type(' and the code-review skill.');
    assert.deepEqual(labels(m), ['@code-review']);
  });

  it('a phrase that ends its paragraph forms when Enter leaves it', (t) => {
    const m = chipped(t);
    m.prose.type('use the design skill');
    key(m, 'Enter');
    m.prose.type('next');
    assert.deepEqual(labels(m), ['@design']);
    assert.equal(m.prose.value(), 'use the design skill\n\nnext');
  });

  it('an imported phrase stays text when the reader types beside it', (t) => {
    const m = chipped(t);
    m.prose.importMarkdown(`ask the design skill to look at ${REF}`);
    m.prose.type('!');
    assert.deepEqual(chips(m.prose.snapshot()), []);
    m.prose.type(' and the code-review skill.');
    assert.deepEqual(labels(m), ['@code-review']);
  });

  it('a restored phrase stays text too', (t) => {
    const m = chipped(t);
    m.prose.importMarkdown('the design skill');
    const snap = m.prose.snapshot();
    m.prose.importMarkdown('');
    m.prose.restore(snap, { history: 'fresh' });
    m.prose.type('.');
    assert.deepEqual(chips(m.prose.snapshot()), []);
  });

  it('a pasted session reference forms', (t) => {
    const m = chipped(t);
    paste(m, { 'text/plain': `see ${REF} now` });
    assert.equal(chips(m.prose.snapshot()).length, 1);
    assert.equal(m.prose.value(), `see ${REF} now`);
  });

  it('HTML carrying chip attrs makes no chip', (t) => {
    const m = chipped(t);
    paste(m, {
      'text/html':
        '<p><span data-type="chip" data-kind="image" data-attachment-id="img-9" ' +
        'class="pchip image" contenteditable="false">[Image #9]</span> and ' +
        '<span data-type="chip" data-kind="skill" data-expansion="the design skill">@design</span></p>',
      'text/plain': '[Image #9] and @design'
    });
    assert.deepEqual(chips(m.prose.snapshot()), []);
    assert.equal(m.prose.value(), '[Image #9] and @design');
    // The text rule still runs on what the paste left.
    m.prose.type(` ${REF}`);
    assert.deepEqual(
      chips(m.prose.snapshot()).map((chip) => chip.kind),
      ['session']
    );
  });
});

describe('prose: copy and cut carry a chip as its expansion', () => {
  const withChip = (t: TestContext): Mounted => {
    const m = mount(t);
    m.prose.type('see ');
    m.prose.insertChip('model', MODEL);
    m.prose.type('now');
    key(m, 'a', { ctrl: true });
    return m;
  };

  /** The clipboard HTML holds the expansion, and nothing of the chip itself. */
  const expansionOnly = (html: string): void => {
    assert.ok(html.includes(MODEL), html);
    assert.doesNotMatch(html, /@Sonnet|pchip|data-kind|data-expansion|attachment/);
  };

  it('a copy writes the expansion as HTML and as text', (t) => {
    const written = copy(withChip(t));
    assert.equal(written.get('text/plain'), `see ${MODEL} now`);
    expansionOnly(written.get('text/html') ?? '');
  });

  it('a cut writes the same, and empties the box', (t) => {
    const m = withChip(t);
    const written = new Map<string, string>();
    const event = new m.window.Event('cut', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        clearData: () => written.clear(),
        setData: (type: string, data: string) => written.set(type, data)
      }
    });
    m.root.dispatchEvent(event);
    assert.equal(written.get('text/plain'), `see ${MODEL} now`);
    expansionOnly(written.get('text/html') ?? '');
    assert.equal(m.prose.value(), '');
  });
});

describe('prose: the selection adapter', () => {
  const spotOf = (m: Mounted) => {
    const spot = m.prose.selection.spot();
    return spot && { ...spot };
  };

  it('reports the whole @query run around the caret, not just what is left of it', (t) => {
    const m = mount(t);
    m.prose.type('ask @pon now');
    m.prose.select(8);
    assert.deepEqual(spotOf(m), { at: 5, end: 9, query: 'pon' });
  });

  it('has no run for a range selection', (t) => {
    const m = mount(t);
    m.prose.type('ask @pon');
    m.prose.select(6, 8);
    assert.equal(spotOf(m), null);
  });

  it('has no run when the caret is before the @', (t) => {
    const m = mount(t);
    m.prose.type('@pon now');
    m.prose.select(1);
    assert.equal(spotOf(m), null);
  });

  it('has no run inside a code span, open or closed', (t) => {
    const m = mount(t);
    m.prose.type('run `npm @sco');
    assert.equal(spotOf(m), null);
    m.prose.type('` and `@x`');
    assert.equal(spotOf(m), null);
    m.prose.select((m.prose.selection.caret() ?? 0) - 1);
    assert.equal(spotOf(m), null);
  });

  it('says where the caret is, and nothing for a range', (t) => {
    const m = mount(t);
    m.prose.type('abc');
    assert.equal(m.prose.selection.caret(), 4);
    m.prose.select(2, 3);
    assert.equal(m.prose.selection.caret(), null);
  });

  it('reads a text range without losing block or chip boundaries', (t) => {
    const m = mount(t);
    m.prose.importMarkdown('hi **there**\n\nnext');
    m.prose.insertChip('model', MODEL);
    const end = m.prose.selection.caret();
    assert.ok(end !== null);
    assert.equal(m.prose.selection.text(1, 3), 'hi');
    assert.equal(m.prose.selection.text(1, end), 'hi there\nnext \uFFFC ');
  });

  it('Undo after a pick gives back the @query, not the typing before it', (t) => {
    const m = mount(t);
    m.prose.type('hi @des');
    m.prose.selection.replace(4, 8, '');
    m.prose.insertChip('skill', 'the design skill');
    assert.equal(m.prose.value(), 'hi the design skill ');
    undo(m);
    assert.equal(m.prose.value(), 'hi @des');
    assert.deepEqual(chips(m.prose.snapshot()), []);
  });

  it('has no run for an @ inside a word', (t) => {
    const m = mount(t);
    m.prose.type('mail@pon');
    assert.equal(spotOf(m), null);
  });

  it('a chip ends a run', (t) => {
    const m = mount(t);
    m.prose.type('@pon');
    m.prose.insertChip('skill', 'the design skill');
    m.prose.select(5);
    assert.deepEqual(spotOf(m), { at: 1, end: 5, query: 'pon' });
  });

  it('replace writes over a range and leaves the caret after it', (t) => {
    const m = mount(t);
    m.prose.type('ask @pon');
    m.prose.selection.replace(5, 9, '@model:');
    assert.equal(m.prose.value(), 'ask @model:');
    assert.deepEqual(spotOf(m), { at: 5, end: 12, query: 'model:' });
  });

  it('tells a just-picked chip from an identical earlier one', (t) => {
    const m = mount(t);
    m.prose.insertChip('skill', 'the design skill');
    const first = m.prose.selection.picked();
    const firstEnd = m.prose.selection.caret();
    assert.ok(firstEnd !== null);
    m.prose.type(' and ');
    assert.equal(m.prose.selection.picked(), null);
    assert.equal(m.prose.selection.picked(firstEnd), first);
    m.prose.insertChip('skill', 'the design skill');
    const second = m.prose.selection.picked();
    assert.ok(first && second);
    assert.notEqual(first, second);
    // Each chip is followed by the space its insert wrote.
    m.prose.select(2);
    assert.equal(m.prose.selection.picked(), first);
    m.prose.select(9);
    assert.equal(m.prose.selection.picked(), second);
    assert.equal(m.prose.selection.picked(firstEnd), first);
    assert.equal(m.prose.selection.picked(100), null);
    assert.equal(m.prose.selection.picked(-1), null);
  });

  it('says a code block accepts no chip, and a paragraph does', (t) => {
    const m = mount(t);
    assert.equal(m.prose.selection.accepts(), true);
    m.prose.type('``` ');
    assert.equal(m.prose.selection.accepts(), false);
  });

  it('plain mode accepts no chip', (t) => {
    const m = mount(t, { mode: 'plain' });
    assert.equal(m.prose.selection.accepts(), false);
  });

  it('says whether a change was an edit or a caret move', (t) => {
    const m = mount(t);
    const seen: string[] = [];
    m.prose.selection.onChange((cause) => seen.push(cause));
    m.prose.type('a');
    m.prose.select(1);
    compose(m, 'start');
    assert.deepEqual(seen, ['edit', 'move', 'compose']);
  });

  it('its node is the editor root', (t) => {
    const m = mount(t);
    assert.equal(m.prose.selection.node, m.root);
  });
});

describe('prose: an imported document forms its chips', () => {
  type DocOf = (md: string, skills: readonly string[]) => ProseSnapshot;
  const docOf = (t: TestContext): DocOf => {
    const p = openPanel(t);
    const seam = (p.window as unknown as { squadronProse?: { markdownDoc?: DocOf } }).squadronProse;
    assert.ok(seam?.markdownDoc, 'the bundle exposes no squadronProse.markdownDoc');
    const { markdownDoc } = seam;
    return (md, skills) => structuredClone(markdownDoc(md, skills));
  };
  const chipsIn = (node: ProseSnapshot): string[] => [
    ...(node.type === 'chip' ? [String(node.attrs?.expansion)] : []),
    ...(node.content ?? []).flatMap(chipsIn)
  ];

  it('a phrase that ends its block is complete, since nobody is typing it', (t) => {
    assert.deepEqual(chipsIn(docOf(t)('use the dataviz skill', ['dataviz'])), [
      'the dataviz skill'
    ]);
  });

  it('a lone backtick opens no code span', (t) => {
    const read = docOf(t);
    assert.deepEqual(chipsIn(read('see `x the dataviz skill.', ['dataviz'])), [
      'the dataviz skill'
    ]);
    assert.deepEqual(chipsIn(read('see `the dataviz skill`.', ['dataviz'])), []);
  });
});

/**
 * The formatting a toolbar applies (`TASK_done_composer_formatting.md`).
 * A code block takes every text block the selection touches, whole, as one
 * block of lines in one Undo step; one holding a chip is refused.
 */
describe('prose: formatting', () => {
  type Inline = string | ProseSnapshot;
  const text = (t: string, ...marks: string[]): ProseSnapshot => ({
    type: 'text',
    text: t,
    ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {})
  });
  const inlineOf = (parts: Inline[]): ProseSnapshot[] =>
    parts.map((part) => (typeof part === 'string' ? text(part) : part));
  const p = (...parts: Inline[]): ProseSnapshot => ({
    type: 'paragraph',
    ...(parts.length ? { content: inlineOf(parts) } : {})
  });
  const br: ProseSnapshot = { type: 'hardBreak' };
  const code = (body: string): ProseSnapshot => ({
    type: 'codeBlock',
    attrs: { language: null },
    ...(body ? { content: [text(body)] } : {})
  });
  const li = (...blocks: ProseSnapshot[]): ProseSnapshot => ({ type: 'listItem', content: blocks });
  const ul = (...items: ProseSnapshot[]): ProseSnapshot => ({
    type: 'bulletList',
    attrs: { tight: true },
    content: items
  });
  const chip: ProseSnapshot = {
    type: 'chip',
    attrs: { kind: 'file', expansion: '/tmp/my_file.ts', attachmentId: null }
  };
  const docOf = (...blocks: ProseSnapshot[]): ProseSnapshot => ({ type: 'doc', content: blocks });

  /** Mounted with `doc`, every attribute normalised by a first read. */
  function loaded(t: TestContext, doc: ProseSnapshot, options: Record<string, unknown> = {}) {
    const m = mount(t, options);
    assert.ok(m.prose.restore(doc, { history: 'fresh' }));
    return { ...m, before: m.prose.snapshot() };
  }

  /** The document's top-level blocks, as type and text. */
  const outline = (snap: ProseSnapshot): string[] =>
    (snap.content ?? []).map((block) => `${block.type}:${textOf(block)}`);
  const textOf = (node: ProseSnapshot): string =>
    node.type === 'text'
      ? (node.text ?? '')
      : node.type === 'hardBreak'
        ? '\n'
        : (node.content ?? []).map(textOf).join(node.type === 'bulletList' ? '|' : '');

  // alpha 1–6, beta 8–12, the empty one 14, gamma 16–21.
  const four = docOf(p('alpha'), p('beta'), p(), p('gamma'));

  it('four paragraphs, one empty, become one code block of four lines', (t) => {
    const m = loaded(t, four);
    m.prose.select(1, 21);
    assert.equal(m.prose.format('codeBlock'), true);
    assert.deepEqual(kinds(m.prose.snapshot()), ['doc', 'codeBlock', 'text']);
    assert.equal(m.prose.value(), '```\nalpha\nbeta\n\ngamma\n```');
  });

  it('a backward selection takes the same blocks', (t) => {
    const m = loaded(t, four);
    m.prose.select(21, 1);
    m.prose.format('codeBlock');
    assert.deepEqual(outline(m.prose.snapshot()), ['codeBlock:alpha\nbeta\n\ngamma']);
  });

  it('endpoints inside text still take each touched block whole', (t) => {
    const m = loaded(t, four);
    m.prose.select(3, 10);
    m.prose.format('codeBlock');
    assert.deepEqual(outline(m.prose.snapshot()), [
      'codeBlock:alpha\nbeta',
      'paragraph:',
      'paragraph:gamma'
    ]);
  });

  it('a range ending where the next block starts leaves that block alone', (t) => {
    const m = loaded(t, four);
    m.prose.select(1, 8);
    m.prose.format('codeBlock');
    assert.deepEqual(outline(m.prose.snapshot()), [
      'codeBlock:alpha',
      'paragraph:beta',
      'paragraph:',
      'paragraph:gamma'
    ]);
  });

  it('a caret converts only its own block, and the rest stays', (t) => {
    const m = loaded(t, four);
    m.prose.select(10);
    m.prose.format('codeBlock');
    assert.deepEqual(outline(m.prose.snapshot()), [
      'paragraph:alpha',
      'codeBlock:beta',
      'paragraph:',
      'paragraph:gamma'
    ]);
  });

  it('keeps hard breaks as lines, and indentation and trailing spaces as typed', (t) => {
    const m = loaded(t, docOf(p('  one', br, 'two  '), p('\tthree')));
    m.prose.select(1, 16);
    m.prose.format('codeBlock');
    assert.deepEqual(outline(m.prose.snapshot()), ['codeBlock:  one\ntwo  \n\tthree']);
  });

  it('keeps the text of formatted runs and drops their marks', (t) => {
    const m = loaded(
      t,
      docOf(p('a ', text('bold', 'bold'), ' ', text('x()', 'code')), p(text('it', 'italic')))
    );
    m.prose.select(1, 15);
    m.prose.format('codeBlock');
    const after = m.prose.snapshot();
    assert.deepEqual(outline(after), ['codeBlock:a bold x()\nit']);
    assert.deepEqual(marked(after), []);
  });

  it('list items in the range join one block, and the rest of the list stays a list', (t) => {
    const m = loaded(t, docOf(ul(li(p('a')), li(p('b')), li(p('c')))));
    // a 3, b 8, c 13.
    m.prose.select(3, 9);
    m.prose.format('codeBlock');
    assert.deepEqual(outline(m.prose.snapshot()), ['codeBlock:a\nb', 'bulletList:c']);
    assert.equal(m.prose.value(), '```\na\nb\n```\n\n- c');
  });

  it('a caret in a middle item splits the list around the block', (t) => {
    const m = loaded(t, docOf(ul(li(p('a')), li(p('b')), li(p('c')))));
    m.prose.select(8);
    m.prose.format('codeBlock');
    assert.deepEqual(outline(m.prose.snapshot()), ['bulletList:a', 'codeBlock:b', 'bulletList:c']);
  });

  it("an item's nested list rejoins the list after the block", (t) => {
    const m = loaded(t, docOf(ul(li(p('a'), ul(li(p('a1')), li(p('a2')))), li(p('b')))));
    m.prose.select(3);
    m.prose.format('codeBlock');
    assert.deepEqual(outline(m.prose.snapshot()), ['codeBlock:a', 'bulletList:a1|a2|b']);
  });

  it('a range from a paragraph into a list takes the touched items only', (t) => {
    const m = loaded(t, docOf(p('intro'), ul(li(p('a')), li(p('b')))));
    // intro 1–6, a 10, b 15.
    m.prose.select(2, 11);
    m.prose.format('codeBlock');
    assert.deepEqual(outline(m.prose.snapshot()), ['codeBlock:intro\na', 'bulletList:b']);
  });

  const ol = (...items: ProseSnapshot[]): ProseSnapshot => ({
    type: 'orderedList',
    attrs: { start: 1 },
    content: items
  });
  const types = (node: ProseSnapshot | undefined): string[] =>
    (node?.content ?? []).map((child) => child.type ?? '');

  it('a range starting where a block ends leaves that block alone', (t) => {
    const m = loaded(t, four);
    m.prose.select(6, 10);
    m.prose.format('codeBlock');
    assert.deepEqual(outline(m.prose.snapshot()), [
      'paragraph:alpha',
      'codeBlock:beta',
      'paragraph:',
      'paragraph:gamma'
    ]);
  });

  it('a caret in a nested item keeps the block in its parent item, siblings nested', (t) => {
    const m = loaded(t, docOf(ul(li(p('a'), ul(li(p('x')), li(p('y')), li(p('z')))), li(p('b')))));
    // a 3, x 8, y 13.
    m.prose.select(13);
    m.prose.format('codeBlock');
    const list = m.prose.snapshot().content?.[0];
    assert.deepEqual(types(list), ['listItem', 'listItem']);
    assert.deepEqual(types(list?.content?.[0]), [
      'paragraph',
      'bulletList',
      'codeBlock',
      'bulletList'
    ]);
    assert.deepEqual(
      outline({ type: 'doc', content: list?.content?.[0]?.content?.slice(1) ?? [] }),
      ['bulletList:x', 'codeBlock:y', 'bulletList:z']
    );
  });

  it('a nested list of the other kind stays its own list after the block', (t) => {
    const m = loaded(t, docOf(ul(li(p('a'), ol(li(p('x')), li(p('y')))), li(p('b')))));
    m.prose.select(3);
    m.prose.format('codeBlock');
    assert.deepEqual(types(m.prose.snapshot()), ['codeBlock', 'orderedList', 'bulletList']);
    assert.match(m.prose.value(), /1\. x\n2\. y/);
  });

  it('a numbered list cut by the block keeps its numbers after it', (t) => {
    const m = loaded(t, docOf(ol(li(p('a')), li(p('b')), li(p('c')))));
    m.prose.select(8);
    m.prose.format('codeBlock');
    assert.equal(m.prose.value(), '1. a\n\n```\nb\n```\n\n3. c');
  });

  it("an item's paragraph after its nested list stays an item of its own", (t) => {
    const m = loaded(t, docOf(ul(li(p('a'), ul(li(p('x'))), p('tail')), li(p('b')))));
    m.prose.select(3);
    m.prose.format('codeBlock');
    assert.deepEqual(outline(m.prose.snapshot()), ['codeBlock:a', 'bulletList:x|tail|b']);
  });

  it("an item's quote keeps its text, under an empty first line", (t) => {
    const quote: ProseSnapshot = { type: 'blockquote', content: [p('q')] };
    const m = loaded(t, docOf(ul(li(p('a'), quote), li(p('b')))));
    m.prose.select(3);
    m.prose.format('codeBlock');
    assert.deepEqual(outline(m.prose.snapshot()), ['codeBlock:a', 'bulletList:q|b']);
  });

  it('an existing code block in the range is merged in verbatim', (t) => {
    const m = loaded(t, docOf(p('a'), code('x\n  y'), p('b')));
    // a 1, the code 4–9, b 12.
    m.prose.select(1, 12);
    assert.equal(m.prose.formats().codeBlock.active, false, 'a mixed range is not code');
    m.prose.format('codeBlock');
    assert.deepEqual(outline(m.prose.snapshot()), ['codeBlock:a\nx\n  y\nb']);
  });

  it('turning a code block off keeps its lines, as hard breaks in one paragraph', (t) => {
    const m = loaded(t, docOf(code('alpha\nbeta')));
    m.prose.select(2);
    assert.equal(m.prose.formats().codeBlock.active, true);
    m.prose.format('codeBlock');
    assert.deepEqual(inline(m.prose.snapshot()), ['alpha', 'hardBreak', 'beta']);
    assert.equal(m.prose.value(), 'alpha\nbeta');
  });

  it('one Undo restores the whole document, and Redo converts again', (t) => {
    const m = loaded(t, docOf(p('intro'), ul(li(p('a')), li(p('b')))));
    m.prose.select(2, 11);
    m.prose.format('codeBlock');
    const converted = m.prose.snapshot();
    undo(m);
    assert.deepEqual(m.prose.snapshot(), m.before);
    key(m, 'y', { ctrl: true });
    assert.deepEqual(m.prose.snapshot(), converted);
  });

  for (const [where, blocks, range] of [
    ['first', [p('a ', chip), p('b'), p('c')], [1, 9]],
    ['middle', [p('a'), p('b ', chip), p('c')], [1, 9]],
    ['last', [p('a'), p('b'), p('c ', chip)], [1, 9]]
  ] as const) {
    it(`refuses a code block over a chip in the ${where} block, and changes nothing`, (t) => {
      const m = loaded(t, docOf(...blocks));
      m.prose.select(...range);
      assert.deepEqual(m.prose.formats().codeBlock, { active: false, blocked: 'chip' });
      assert.equal(m.prose.format('codeBlock'), false);
      assert.deepEqual(m.prose.snapshot(), m.before);
    });
  }

  it('a chip outside the touched blocks does not stop the block', (t) => {
    const m = loaded(t, docOf(p('a ', chip), p('b')));
    m.prose.select(6);
    assert.equal(m.prose.formats().codeBlock.blocked, null);
    m.prose.format('codeBlock');
    assert.deepEqual(outline(m.prose.snapshot()).slice(1), ['codeBlock:b']);
  });

  it("the keyboard's code block is the same conversion, and the same refusal", (t) => {
    const byKey = loaded(t, four);
    byKey.prose.select(1, 21);
    key(byKey, 'c', { ctrl: true, alt: true });
    const byButton = loaded(t, four);
    byButton.prose.select(1, 21);
    byButton.prose.format('codeBlock');
    assert.deepEqual(byKey.prose.snapshot(), byButton.prose.snapshot());

    const chipped = loaded(t, docOf(p('a ', chip), p('b')));
    chipped.prose.select(1, 6);
    key(chipped, 'c', { ctrl: true, alt: true });
    assert.deepEqual(chipped.prose.snapshot(), chipped.before);
  });

  const ordinary: [Exclude<ProseFormat, 'codeBlock'>, string][] = [
    ['bold', '**alpha**'],
    ['italic', '*alpha*'],
    ['strike', '~~alpha~~'],
    ['bulletList', '- alpha'],
    ['orderedList', '1. alpha'],
    ['blockquote', '> alpha'],
    ['code', '`alpha`']
  ];
  for (const [format, sent] of ordinary) {
    it(`${format} applies to the selection, reads active, and toggles back`, (t) => {
      const m = loaded(t, docOf(p('alpha')));
      m.prose.select(1, 6);
      assert.equal(m.prose.format(format), true);
      assert.equal(m.prose.value(), sent);
      assert.equal(m.prose.formats()[format].active, true);
      m.prose.format(format);
      assert.equal(m.prose.value(), 'alpha');
    });
  }

  it('a mark is refused inside a code block, for the schema', (t) => {
    const m = loaded(t, docOf(code('x')));
    m.prose.select(1, 2);
    assert.equal(m.prose.formats().bold.blocked, 'context');
    assert.equal(m.prose.format('bold'), false);
  });

  it('a read-only box applies nothing, and says why', (t) => {
    const m = loaded(t, four, { readOnly: true });
    m.prose.select(1, 21);
    for (const format of Object.values(m.prose.formats())) assert.equal(format.blocked, 'readOnly');
    assert.equal(m.prose.format('codeBlock'), false);
    assert.equal(m.prose.format('bold'), false);
    assert.deepEqual(m.prose.snapshot(), m.before);
  });

  it('plain mode offers no formatting', (t) => {
    const m = mount(t, { mode: 'plain' });
    m.prose.type('alpha');
    m.prose.select(1, 6);
    for (const format of Object.values(m.prose.formats())) {
      assert.deepEqual(format, { active: false, blocked: 'plain' });
    }
    assert.equal(m.prose.format('bold'), false);
    assert.equal(m.prose.value(), 'alpha');
  });

  it('a caret move says the new formats, and is no edit', (t) => {
    const heard: ProseFormats[] = [];
    let edits = 0;
    const m = loaded(t, docOf(p(text('bold', 'bold'), ' plain')), {
      onFormat: (f: ProseFormats) => heard.push(structuredClone(f)),
      onChange: () => edits++
    });
    m.prose.select(2);
    assert.equal(heard.at(-1)?.bold.active, true);
    m.prose.select(8);
    assert.equal(heard.at(-1)?.bold.active, false);
    const said = heard.length;
    m.prose.select(9);
    assert.equal(heard.length, said, 'a move that changes nothing says nothing');
    assert.equal(edits, 0);
  });

  it('a restore, an import and a lock each say the formats again', (t) => {
    const heard: ProseFormats[] = [];
    const m = loaded(t, docOf(p('x')), {
      onFormat: (f: ProseFormats) => heard.push(structuredClone(f))
    });
    const said = heard.length;
    m.prose.restore(docOf(code('y')), { history: 'fresh' });
    assert.equal(heard.length, said + 1);
    assert.equal(heard.at(-1)?.codeBlock.active, true);
    m.prose.importMarkdown('plain');
    assert.equal(heard.at(-1)?.codeBlock.active, false);
    m.prose.update({ readOnly: true });
    assert.equal(heard.at(-1)?.bold.blocked, 'readOnly');
  });

  // A block format takes lines, as Slack's composer does: Shift+Enter is a hard
  // break in one paragraph, so the caret's line, or each line a range holds, is
  // cut out of it first. line1 1–6, break 6, line2 7–12, break 12, line3 13–18.
  const lines = docOf(p('line1', br, 'line2', br, 'line3'));
  const shiftEnter = (m: Mounted): KeyboardEvent => key(m, 'Enter', { shift: true });

  it('a caret quotes only its own line', (t) => {
    const m = loaded(t, lines);
    m.prose.select(9);
    assert.equal(m.prose.format('blockquote'), true);
    assert.deepEqual(outline(m.prose.snapshot()), [
      'paragraph:line1',
      'blockquote:line2',
      'paragraph:line3'
    ]);
    assert.equal(m.prose.formats().blockquote.active, true);
  });

  it('a range quotes the lines it holds as one quote, and leaves the rest', (t) => {
    const m = loaded(t, lines);
    m.prose.select(3, 9);
    m.prose.format('blockquote');
    assert.equal(m.prose.value(), '> line1\n> line2\n\nline3');
  });

  it('a range ending where a line starts leaves that line alone', (t) => {
    const m = loaded(t, lines);
    m.prose.select(3, 13);
    m.prose.format('blockquote');
    assert.equal(m.prose.value(), '> line1\n> line2\n\nline3');
  });

  it('quoting the next line joins the quote above it', (t) => {
    const m = loaded(t, lines);
    m.prose.select(3);
    m.prose.format('blockquote');
    // line1 2–7 in its quote, then line2 10–15.
    m.prose.select(12);
    assert.equal(m.prose.formats().blockquote.active, false);
    m.prose.format('blockquote');
    assert.equal(m.prose.value(), '> line1\n> line2\n\nline3');
  });

  it('unquoting a line knits it back between its neighbours', (t) => {
    const m = loaded(t, lines);
    m.prose.select(9);
    m.prose.format('blockquote');
    m.prose.format('blockquote');
    assert.equal(m.prose.value(), 'line1\nline2\nline3');
    assert.deepEqual(inline(m.prose.snapshot()), [
      'line1',
      'hardBreak',
      'line2',
      'hardBreak',
      'line3'
    ]);
  });

  for (const [format, sent] of [
    ['bulletList', '- line2'],
    ['orderedList', '1. line2']
  ] as const) {
    it(`a caret makes only its own line a ${format} item`, (t) => {
      const m = loaded(t, lines);
      m.prose.select(9);
      m.prose.format(format);
      assert.equal(m.prose.value(), `line1\n\n${sent}\n\nline3`);
    });
  }

  it('a range makes each line it holds an item of its own', (t) => {
    const bullets = loaded(t, lines);
    bullets.prose.select(3, 15);
    bullets.prose.format('bulletList');
    assert.equal(bullets.prose.value(), '- line1\n- line2\n- line3');
    const numbers = loaded(t, lines);
    numbers.prose.select(3, 15);
    numbers.prose.format('orderedList');
    assert.equal(numbers.prose.value(), '1. line1\n2. line2\n3. line3');
  });

  it('turning a list off knits its items back into lines', (t) => {
    const m = loaded(t, lines);
    m.prose.select(3, 15);
    m.prose.format('bulletList');
    m.prose.format('bulletList');
    assert.equal(m.prose.value(), 'line1\nline2\nline3');
  });

  it('a caret makes only its own line a code block, and off knits it back', (t) => {
    const m = loaded(t, lines);
    m.prose.select(9);
    m.prose.format('codeBlock');
    assert.deepEqual(outline(m.prose.snapshot()), [
      'paragraph:line1',
      'codeBlock:line2',
      'paragraph:line3'
    ]);
    m.prose.format('codeBlock');
    assert.equal(m.prose.value(), 'line1\nline2\nline3');
  });

  it('a line holding a chip does not stop a code block on another line', (t) => {
    const m = loaded(t, docOf(p('a ', chip, br, 'b')));
    // a 1–3, the chip 3, break 4, b 5.
    m.prose.select(5);
    assert.equal(m.prose.formats().codeBlock.blocked, null);
    m.prose.format('codeBlock');
    assert.deepEqual(outline(m.prose.snapshot()).slice(1), ['codeBlock:b']);
  });

  it('one Undo takes a line format back whole', (t) => {
    const m = loaded(t, lines);
    m.prose.select(9);
    m.prose.format('blockquote');
    undo(m);
    assert.deepEqual(m.prose.snapshot(), m.before);
  });

  const quote = (...blocks: ProseSnapshot[]): ProseSnapshot => ({
    type: 'blockquote',
    content: blocks
  });

  it('Shift+Enter in a quoted line is a new quoted line', (t) => {
    const m = loaded(t, docOf(quote(p('q'))));
    m.prose.select(3);
    shiftEnter(m);
    m.prose.type('r');
    assert.equal(m.prose.value(), '> q\n> r');
  });

  it('Shift+Enter on an empty last quoted line leaves the quote', (t) => {
    const m = loaded(t, docOf(quote(p('q'))));
    m.prose.select(3);
    shiftEnter(m);
    shiftEnter(m);
    m.prose.type('x');
    assert.deepEqual(outline(m.prose.snapshot()), ['blockquote:q', 'paragraph:x']);
    assert.equal(m.prose.value(), '> q\n\nx');
  });

  it('Shift+Enter on an empty quoted line between two splits the quote there', (t) => {
    // q 2, break 3, the empty line 4, break 4, r 5.
    const m = loaded(t, docOf(quote(p('q', br, br, 'r'))));
    m.prose.select(4);
    shiftEnter(m);
    m.prose.type('x');
    assert.deepEqual(outline(m.prose.snapshot()), ['blockquote:q', 'paragraph:x', 'blockquote:r']);
  });

  it('unquoting one line of a quote leaves the lines either side quoted', (t) => {
    // line1 2–7, break 7, line2 8–13, break 13, line3 14–19.
    const m = loaded(t, docOf(quote(p('line1', br, 'line2', br, 'line3'))));
    m.prose.select(10);
    m.prose.format('blockquote');
    assert.deepEqual(outline(m.prose.snapshot()), [
      'blockquote:line1',
      'paragraph:line2',
      'blockquote:line3'
    ]);
  });

  // A quote cannot sit in a list, so it takes the items a selection touches out
  // of theirs whole. a 3, b 8, c 13.
  const abc = (list: typeof ul): ProseSnapshot => docOf(list(li(p('a')), li(p('b')), li(p('c'))));

  it('quoting a whole list ends where listing quoted lines does', (t) => {
    const listed = loaded(t, abc(ul));
    listed.prose.select(3, 14);
    assert.equal(listed.prose.formats().blockquote.blocked, null);
    assert.equal(listed.prose.format('blockquote'), true);
    // a 1, break 2, b 3, break 4, c 5.
    const quoted = loaded(t, docOf(p('a', br, 'b', br, 'c')));
    quoted.prose.select(1, 6);
    quoted.prose.format('blockquote');
    quoted.prose.format('bulletList');
    assert.deepEqual(listed.prose.snapshot(), quoted.prose.snapshot());
    assert.equal(listed.prose.value(), '> - a\n> - b\n> - c');
  });

  it('a caret quotes only its own item, the list split around it', (t) => {
    const m = loaded(t, abc(ul));
    m.prose.select(8);
    m.prose.format('blockquote');
    const snap = m.prose.snapshot();
    assert.deepEqual(outline(snap), ['bulletList:a', 'blockquote:b', 'bulletList:c']);
    assert.deepEqual(types(snap.content?.[1]), ['bulletList']);
    assert.equal(m.prose.formats().blockquote.active, true);
  });

  for (const [edge, from, to, quoted] of [
    ['ends at the next item start', 3, 8, ['blockquote:a', 'bulletList:b|c']],
    ['starts at the previous item end', 4, 9, ['bulletList:a', 'blockquote:b', 'bulletList:c']]
  ] as const) {
    it(`quoting a range that ${edge} leaves that item alone`, (t) => {
      const m = loaded(t, abc(ul));
      m.prose.select(from, to);
      m.prose.format('blockquote');
      assert.deepEqual(outline(m.prose.snapshot()), quoted);
    });
  }

  for (const [edge, from, to, unquoted] of [
    ['ends at the next item start', 4, 9, ['bulletList:a', 'blockquote:b|c']],
    ['starts at the previous item end', 5, 10, ['blockquote:a', 'bulletList:b', 'blockquote:c']]
  ] as const) {
    it(`unquoting a range that ${edge} leaves that item alone`, (t) => {
      const m = loaded(t, docOf(quote(ul(li(p('a')), li(p('b')), li(p('c'))))));
      m.prose.select(from, to);
      m.prose.format('blockquote');
      assert.deepEqual(outline(m.prose.snapshot()), unquoted);
    });
  }

  it('unquoting preserves an independent numbered list start', (t) => {
    const m = mount(t);
    m.prose.importMarkdown('1. a\n\n> 7. b');
    m.prose.select(11);
    m.prose.format('blockquote');
    const snap = m.prose.snapshot();
    assert.deepEqual(outline(snap), ['orderedList:a', 'orderedList:b']);
    assert.deepEqual(
      snap.content?.map((list) => Number(list.attrs?.['start'])),
      [1, 7]
    );
  });

  it('quoting beside another numbered list preserves its independent start', (t) => {
    const m = mount(t);
    m.prose.importMarkdown('> 1. a\n\n7. b');
    const before = m.prose.snapshot();
    m.prose.select(12);
    m.prose.format('blockquote');
    const snap = m.prose.snapshot();
    assert.deepEqual(types(snap.content?.[0]), ['orderedList', 'orderedList']);
    assert.deepEqual(
      snap.content?.[0]?.content?.map((list) => Number(list.attrs?.['start'])),
      [1, 7]
    );
    m.prose.format('blockquote');
    assert.deepEqual(m.prose.snapshot(), before);
  });

  it('a numbered list split by a quote keeps its numbers', (t) => {
    const m = loaded(t, abc(ol));
    m.prose.select(8, 14);
    m.prose.format('blockquote');
    assert.equal(m.prose.value(), '1. a\n\n> 2. b\n> 3. c');
  });

  it('quoting the next item joins the quote and list above it', (t) => {
    const m = loaded(t, abc(ul));
    m.prose.select(3);
    m.prose.format('blockquote');
    // a 4 in its quoted list, then b 12.
    m.prose.select(12);
    m.prose.format('blockquote');
    assert.deepEqual(outline(m.prose.snapshot()), ['blockquote:a|b', 'bulletList:c']);
  });

  it('a caret in a nested item quotes it inside its parent item', (t) => {
    const m = loaded(t, docOf(ul(li(p('a'), ul(li(p('x')), li(p('y')))), li(p('b')))));
    // a 3, x 8, y 13.
    m.prose.select(13);
    m.prose.format('blockquote');
    assert.equal(m.prose.value(), '- a\n  - x\n\n  > - y\n- b');
  });

  for (const [what, list] of [
    ['bullet', ul],
    ['numbered', ol]
  ] as const) {
    it(`unquoting a quoted ${what} list gives the list back`, (t) => {
      const m = loaded(t, abc(list));
      m.prose.select(3, 14);
      m.prose.format('blockquote');
      assert.equal(m.prose.formats().blockquote.active, true);
      m.prose.format('blockquote');
      assert.deepEqual(m.prose.snapshot(), m.before);
    });

    it(`unquoting a ${what} item puts it back in its list`, (t) => {
      const m = loaded(t, abc(list));
      m.prose.select(8);
      m.prose.format('blockquote');
      m.prose.format('blockquote');
      assert.deepEqual(m.prose.snapshot(), m.before);
    });
  }

  it('a caret unquotes only its own item of a quoted list', (t) => {
    // a 4, b 9, c 14.
    const m = loaded(t, docOf(quote(ul(li(p('a')), li(p('b')), li(p('c'))))));
    m.prose.select(9);
    m.prose.format('blockquote');
    assert.deepEqual(outline(m.prose.snapshot()), ['blockquote:a', 'bulletList:b', 'blockquote:c']);
  });

  for (const [from, to] of [
    ['bulletList', 'orderedList'],
    ['orderedList', 'bulletList']
  ] as const) {
    for (const [where, at] of [
      ['first', 3],
      ['later', 8]
    ] as const) {
      it(`a caret in the ${where} item switches the whole ${from} to ${to}`, (t) => {
        // a 3, b 8.
        const list = from === 'bulletList' ? ul : ol;
        const m = loaded(t, docOf(list(li(p('a')), li(p('b')))));
        m.prose.select(at);
        m.prose.format(to);
        assert.deepEqual(types(m.prose.snapshot()), [to]);
      });
    }
  }

  for (const format of ['codeBlock', 'blockquote'] as const) {
    it(`${format}: a range ending where a block of lines starts leaves that block alone`, (t) => {
      // a 1, then b 4, break 5, c 6.
      const m = loaded(t, docOf(p('a'), p('b', br, 'c')));
      m.prose.select(1, 4);
      m.prose.format(format);
      assert.deepEqual(outline(m.prose.snapshot()), [`${format}:a`, 'paragraph:b\nc']);
    });

    it(`${format}: a range starting where a block of lines ends leaves that block alone`, (t) => {
      // a 1, break 2, b 3, then c 6.
      const m = loaded(t, docOf(p('a', br, 'b'), p('c')));
      m.prose.select(4, 7);
      m.prose.format(format);
      assert.deepEqual(outline(m.prose.snapshot()), ['paragraph:a\nb', `${format}:c`]);
    });
  }
});

describe('ticket pill clipboard', () => {
  const ref = '@ticket[ENG-42][https://example.test/issue/ENG-42]';
  const url = 'https://example.test/issue/ENG-42';

  it('types a ticket atom, copies a normal URL, and pastes the rich copy back as the same ticket', (t) => {
    const m = mount(t);
    m.prose.type(ref);
    assert.equal(m.root.querySelector('.pchip.ticket')?.textContent, '@ENG-42');
    assert.equal(m.prose.value(), ref);
    key(m, 'a', { ctrl: true });
    const written = copy(m);
    assert.equal(written.get('text/plain'), url);
    assert.ok(written.get('text/html')?.includes('href="' + url + '"'));
    const other = mount(t);
    paste(other, Object.fromEntries(written));
    assert.equal(other.root.querySelector('.pchip.ticket')?.textContent, '@ENG-42');
    assert.equal(other.prose.value(), ref);
    key(other, 'Backspace');
    assert.equal(other.prose.value(), '');
  });

  it('keeps code literal and rejects unsafe rich clipboard references', (t) => {
    const m = mount(t);
    m.prose.importMarkdown('`' + ref + '`');
    assert.equal(m.root.querySelector('.pchip'), null);
    const other = mount(t);
    paste(other, {
      'text/plain': 'ENG-42',
      'text/html':
        '<a href="javascript:evil()" data-squadron-mention="@ticket[ENG-42][javascript:evil()]">ENG-42</a>'
    });
    assert.equal(other.root.querySelector('.pchip'), null);
    assert.equal(other.prose.value(), 'ENG-42');
  });
});
