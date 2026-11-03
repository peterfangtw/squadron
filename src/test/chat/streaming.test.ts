import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as streaming from '../../ui/streaming';
import type { Authored } from '../../core/transcript';

describe('buffered Markdown boundaries', () => {
  const cases: [string, string, string][] = [
    ['single paragraph', 'A long paragraph without a boundary', ''],
    ['unfinished paragraph after a complete one', 'First\n\nSecond\ncontinued\n', 'First\n\n'],
    ['open fence', 'Intro\n\n```ts\nx()\n\n', 'Intro\n\n'],
    ['closed fence', '```ts\nx()\n```\nrest', '```ts\nx()\n```\n'],
    ['heading awaiting content', 'Intro\n\n## Results\n\n', 'Intro\n\n'],
    ['bold heading with content', '**Results**\n\nBody\n\nNext', '**Results**\n\nBody\n\n'],
    ['heading after a paragraph', 'Intro\n## Results\nBody', 'Intro\n'],
    ['tight list', '- one\n- two', '- one\n'],
    ['loose list', '- one\n\n- two\ncontinued', '- one\n\n'],
    ['nested list', '- one\n  - two', '- one\n'],
    ['partial list marker', '- one\n-', ''],
    ['ordered list', '1. one\n2) two', '1. one\n'],
    ['list under heading', '## Results\n- one', ''],
    ['list inside fence', 'Intro\n\n```\n- one\n- two\n', 'Intro\n\n'],
    ['mismatched fence', 'Intro\n\n```\nx\n~~~\n', 'Intro\n\n'],
    ['closing fence with info string', 'Intro\n\n```\nx\n```ts\n', 'Intro\n\n'],
    ['indented list fence', '  ```\nx\n     ```\nrest', '  ```\nx\n     ```\n'],
    ['over-indented closer', 'Intro\n\n```\nx\n    ```\n', 'Intro\n\n'],
    ['nonbreaking space is content', 'First\n\u00a0\nSecond', ''],
    ['CRLF blank line', 'First\r\n\r\nSecond', 'First\r\n\r\n']
  ];
  for (const [name, text, ready] of cases) {
    it(name, () => {
      assert.deepEqual(streaming.splitBufferedAssistantText(text), {
        ready,
        rest: text.slice(ready.length)
      });
    });
  }
});

describe('draft display projection', () => {
  it('keeps boundary-free text visible and leaves the source draft lossless', () => {
    const paragraph = 'A single paragraph '.repeat(200);
    const source: Authored = { role: 'assistant', text: paragraph, blocks: [{ text: paragraph }] };
    assert.equal(streaming.heldDraft(source).text, paragraph);
    const text = 'First\n\nUnfinished **bold';
    const draft: Authored = { ...source, text, blocks: [{ text }], at: 123, skill: 'ponytail' };
    const before = structuredClone(draft);
    assert.deepEqual(streaming.heldDraft(draft), {
      ...draft,
      text: 'First\n\n',
      blocks: [{ text: 'First\n\n' }]
    });
    assert.deepEqual(draft, before);
  });

  it('passes through other authors', () => {
    for (const role of ['user', 'cli', 'wait', 'warm'] as const) {
      const text = 'First\n\nUnfinished';
      const source: Authored = {
        role,
        text,
        blocks: [{ text }]
      };
      assert.deepEqual(streaming.heldDraft(source), source);
    }
  });
});
