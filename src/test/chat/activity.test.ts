import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import { describe, it } from 'node:test';
import { activity, toolView } from '../../ui/activity';
import { toolLabel } from '../../core/grok/transcript';

const HOME = os.homedir();

describe('activity', () => {
  it('names a command by what the model said it was for', () => {
    assert.deepEqual(
      activity({
        name: 'Bash',
        input: { command: 'git status --porcelain', description: 'Show working tree status' }
      }),
      {
        summary: 'Ran command',
        detail: 'Show working tree status',
        title: 'git status --porcelain'
      }
    );
  });

  it('falls back to the command itself, and keeps no tooltip repeating it', () => {
    assert.deepEqual(activity({ name: 'Bash', input: { command: 'npm run check' } }), {
      summary: 'Ran command',
      detail: 'npm run check'
    });
  });

  it('states a command on one line, however many the CLI wrote', () => {
    const activityOf = activity({
      name: 'Bash',
      input: { command: "cat <<'EOF' > f\nline two\nline three\nEOF" }
    });
    assert.equal(activityOf.detail, "cat <<'EOF' > f");
  });

  it('shortens a read path to the home-relative one, and hovers the whole', () => {
    assert.deepEqual(activity({ name: 'Read', input: { file_path: HOME + '/proj/src/a.ts' } }), {
      summary: 'Read file',
      detail: '~/proj/src/a.ts',
      title: HOME + '/proj/src/a.ts'
    });
  });

  it('says a write changed a file', () => {
    assert.deepEqual(activity({ name: 'Write', input: { file_path: '/tmp/notes.md' } }), {
      summary: 'Changed file',
      detail: '/tmp/notes.md'
    });
  });

  it("says Grok's dominant writer changed a file, under the name a reader knows", () => {
    // Composed on purpose: the claim is that the wire name reaches the row, and
    // it takes both halves — `TOOLS` mapping `search_replace` onto our `Edit`,
    // and `ACTION` reading `file_change` off `WRITES`. Either half breaking
    // drops the row back to the raw wire name. `toolLabel` is the one door both
    // Grok readers go through — the tee's `nameOf` and the fallback's
    // `toolCalls` — so
    // this pins a live owned card's row as well as a replayed one.
    assert.equal(toolLabel('search_replace'), 'Edit');
    assert.deepEqual(
      activity({ name: toolLabel('search_replace'), input: { file_path: '/proj/app.ts' } }),
      { summary: 'Changed file', detail: '/proj/app.ts' }
    );
  });

  it('reads an edit and a notebook edit as changes too', () => {
    assert.equal(
      activity({ name: 'Edit', input: { file_path: '/a/b.ts' } }).summary,
      'Changed file'
    );
    assert.equal(
      activity({ name: 'NotebookEdit', input: { notebook_path: '/a/b.ipynb' } }).detail,
      '/a/b.ipynb'
    );
  });

  it('gives a search what it searched for, whichever key it arrived under', () => {
    assert.deepEqual(activity({ name: 'WebSearch', input: { query: 'jsonl' } }), {
      summary: 'Searched',
      detail: 'jsonl'
    });
    assert.equal(
      activity({ name: 'WebFetch', input: { url: 'https://a/b' } }).detail,
      'https://a/b'
    );
  });

  it('reads a tool it has no word for by its own name', () => {
    // `Grep` stood in the action map and no longer does. What it costs is the
    // word, not the row: the subject is still there.
    assert.deepEqual(activity({ name: 'Grep', input: { pattern: 'tool_result' } }), {
      summary: 'Grep',
      detail: 'tool_result'
    });
  });

  it('reads an unknown tool by its own name and its first stated value', () => {
    assert.deepEqual(activity({ name: 'Skill', input: { skill: 'caveman', args: '' } }), {
      summary: 'Skill',
      detail: 'caveman'
    });
  });

  it('reads an mcp tool as its last segment, with the server on the tooltip', () => {
    assert.deepEqual(
      activity({ name: 'mcp__claude_ai_Linear__get_issue', input: { id: 'ENG-1641' } }),
      {
        summary: 'get_issue',
        detail: 'ENG-1641',
        title: 'mcp__claude_ai_Linear__get_issue'
      }
    );
  });

  it('reads a path an unnamed tool wrote under a key this does know', () => {
    assert.equal(
      activity({ name: 'SomeNewTool', input: { note: 'x', file_path: '/a/b.ts' } }).detail,
      '/a/b.ts'
    );
  });

  it('says only the name when the CLI could not parse the input', () => {
    assert.deepEqual(
      activity({ name: 'Read', input: { file_path: '/a/b.ts', __unparsedToolInput: '{"file_' } }),
      { summary: 'Read' }
    );
  });

  it('answers a call with no input at all', () => {
    assert.deepEqual(activity({ name: 'ExitPlanMode' }), { summary: 'ExitPlanMode' });
    assert.deepEqual(activity({ name: 'Read', input: undefined }), { summary: 'Read file' });
  });

  it('answers an input that is not an object', () => {
    assert.deepEqual(activity({ name: 'Bash', input: 'ls -la' }), { summary: 'Ran command' });
    assert.deepEqual(activity({ name: 'Bash', input: null }), { summary: 'Ran command' });
    assert.deepEqual(activity({ name: 'WebFetch', input: ['*.ts'] }), { summary: 'Searched' });
  });

  it('joins an argument list rather than dropping it', () => {
    assert.equal(
      activity({ name: 'Runner', input: { args: ['npm', 'run', 'check'] } }).detail,
      'npm run check'
    );
  });

  it('cuts a long line to the row and hangs the rest off the tooltip', () => {
    const long = 'x'.repeat(400);
    const cut = activity({ name: 'Bash', input: { description: long } });
    assert.equal(cut.detail?.length, 201);
    assert.equal(cut.title, long);
  });

  it('says only the name for an input that names nothing at the top', () => {
    const deep = { a: { b: { file_path: '/too/deep.ts' } } };
    assert.deepEqual(activity({ name: 'Weird', input: deep }), { summary: 'Weird' });
  });

  it('reads an ask as Asked, and says nothing more', () => {
    // Every value in this input is an array of objects, so the `other` branch
    // found nothing to say and the row wore the tool's name. What it is about
    // is the pills beside it.
    const asked = activity({
      name: 'AskUserQuestion',
      input: { questions: [{ question: 'Which way?', options: [{ label: 'Left' }] }] }
    });
    assert.deepEqual(asked, { summary: 'Asked' });
  });
});

describe('toolView', () => {
  const record = {
    questions: [
      {
        question: 'Which way?',
        header: 'Route',
        multiSelect: false,
        options: [{ label: 'Left' }, { label: 'Right' }]
      }
    ],
    answers: { 'Which way?': 'Right' },
    annotations: { 'Which way?': { notes: 'while it stays flat' } }
  };

  it('resolves the record’s labels to indices before it ships', () => {
    // The webview is never handed a label to match: that is `core/answers.ts`'s
    // knowledge, and one copy of it is the whole point of resolving here.
    const view = toolView({ id: 'a', name: 'AskUserQuestion', ask: record });
    assert.deepEqual(view.ask?.picks, [[1]]);
    assert.deepEqual(view.ask?.texts, ['']);
    assert.deepEqual(view.ask?.notes, ['while it stays flat']);
    assert.equal(view.ask?.questions[0]?.header, 'Route');
  });

  it('leaves the field off a call that answered nothing', () => {
    const view = toolView({ id: 'b', name: 'Read', output: 'a file' });
    assert.equal('ask' in view, false, 'absent, never undefined — see the header');
  });
});
