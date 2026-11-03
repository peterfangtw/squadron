import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { uninstallHooks } from '../../core/claude/hooks';
import { needsFileSymlinks } from '../helpers';

/**
 * Nothing installs a hook any more; every machine that ran an older build still
 * has the entries it wrote, so what is left to prove is the removal: it takes
 * ours out, touches no foreign hook or top-level key, and edits the text rather
 * than the document. Run against a real temp file — `hooks.ts` takes the path,
 * so no HOME juggling is needed. The fixtures are what an old install wrote.
 */

const SCRIPT = 'squadron-hook.sh';
const CMD = `bash /Users/x/.vscode/extensions/acme.squadron-2026.39.8/bin/${SCRIPT}`;
const DIALOG_CMD =
  'bash /Users/x/.vscode/extensions/acme.agentsview-2026.39.6/bin/agentsview-dialog-hook.sh';
let dir: string;
let file: string;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-hooks-'));
});
after(() => fs.rm(dir, { recursive: true, force: true }));
beforeEach(() => {
  file = path.join(dir, `settings-${Math.random().toString(36).slice(2)}.json`);
});

type HookEntry = { matcher?: string; hooks: { type: string; command: string }[] };
type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;
const read = async (): Promise<Settings> => JSON.parse(await fs.readFile(file, 'utf8')) as Settings;
const raw = () => fs.readFile(file, 'utf8');
const write = (settings: unknown) => fs.writeFile(file, JSON.stringify(settings, null, 2) + '\n');
const entry = (command: string, matcher?: string): HookEntry =>
  matcher
    ? { matcher, hooks: [{ type: 'command', command }] }
    : { hooks: [{ type: 'command', command }] };
/** Rich status as it was installed: every tool call, and both ends of a turn. */
const richStatus = (command = CMD): Record<string, HookEntry[]> => ({
  PreToolUse: [entry(command, '.*')],
  PostToolUse: [entry(command, '.*')],
  Notification: [entry(command)],
  UserPromptSubmit: [entry(command)],
  Stop: [entry(command)]
});

describe('uninstallHooks', () => {
  it('restores settings that had no hooks at all', async () => {
    const original = { model: 'opus', permissions: { allow: ['Bash'] } };
    await write({ ...original, hooks: richStatus() });
    await uninstallHooks([SCRIPT], file);
    // The whole hooks key is gone again — not left as an empty object.
    assert.deepEqual(await read(), original);
  });

  it('keeps a foreign hook, on its own event and on one of ours', async () => {
    const foreign = entry('jq -Rs . < ~/.claude/caveman.md');
    const other = entry('echo other');
    const ours = richStatus();
    await write({
      hooks: { ...ours, SessionStart: [foreign], PreToolUse: [other, ...(ours.PreToolUse ?? [])] }
    });
    await uninstallHooks([SCRIPT], file);
    assert.deepEqual(await read(), { hooks: { SessionStart: [foreign], PreToolUse: [other] } });
  });

  it('takes an entry out whatever install path it names', async () => {
    // A dev host installed from the repo, the packaged copy from a versioned
    // extension directory — and an upgrade deletes the directory the old entry
    // still names. The name is what is matched, never the whole command.
    await write({ hooks: { Stop: [entry(`bash /repo/bin/${SCRIPT}`), entry(CMD)] } });
    await uninstallHooks([SCRIPT], file);
    assert.deepEqual(await read(), {});
  });

  it('removes only the script asked for', async () => {
    // Anchored on the separator: `agentsview-hook.sh` is a suffix of
    // `agentsview-dialog-hook.sh`, and each is removed on its own.
    const dialog = entry(DIALOG_CMD, 'AskUserQuestion');
    const plain = entry('bash /old/bin/agentsview-hook.sh', '.*');
    await write({ hooks: { PreToolUse: [plain, dialog] } });
    await uninstallHooks(['agentsview-hook.sh'], file);
    assert.deepEqual((await read()).hooks?.PreToolUse, [dialog]);
  });

  it('keeps a command the user added to our group', async () => {
    // The CLI's `/hooks` menu can add to an existing group whose matcher fits,
    // so a group we wrote may hold theirs beside ours.
    const theirs = { type: 'command', command: 'echo mine' };
    await write({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: CMD }, theirs] }] }
    });
    await uninstallHooks([SCRIPT], file);
    assert.deepEqual(await read(), { hooks: { Stop: [{ hooks: [theirs] }] } });
  });

  it('does not throw when the file is missing', async () => {
    await uninstallHooks([SCRIPT], file); // never created
    await assert.rejects(fs.stat(file), 'and it is not created either');
  });

  it('leaves an empty or odd-shaped hooks key alone', async () => {
    // Nothing of ours in any of them, so none may be written — an earlier
    // version read each as "every event emptied" and deleted the key.
    for (const hooks of [{}, { PreToolUse: [] }, null, [], 'x', { Stop: 'x' }]) {
      const text = JSON.stringify({ model: 'opus', hooks }, null, 2) + '\n';
      await fs.writeFile(file, text);
      await uninstallHooks([SCRIPT], file);
      assert.equal(await raw(), text, JSON.stringify(hooks));
    }
  });

  it('leaves the file untouched when nothing of ours is present', async () => {
    await write({ hooks: { SessionStart: [{ hooks: [{ command: 'x' }] }] } });
    const before = await fs.stat(file);
    // Every activation calls this for every retired script — it must not
    // rewrite a file it has nothing to remove from.
    await uninstallHooks([SCRIPT], file);
    const after = await fs.stat(file);
    assert.equal(after.mtimeMs, before.mtimeMs, 'file was rewritten with no change to make');
  });
});

/**
 * Every machine that ran an older build still carries these, pointing into an
 * extension directory the host deletes on upgrade, so each fails on every tool
 * call until removed. This proves the list is the default; whether activation
 * calls it is `extension.ts`, which imports `vscode`, so that is hand-checked.
 */
describe('retired scripts', () => {
  it('removes every hook any earlier build installed', async () => {
    const foreign = entry('echo mine');
    await write({
      hooks: {
        ...richStatus(),
        PreToolUse: [
          foreign,
          entry('bash /old/bin/agentsview-hook.sh', '.*'),
          entry(DIALOG_CMD, 'AskUserQuestion'),
          entry(CMD, '.*')
        ],
        SessionStart: [entry(DIALOG_CMD)]
      }
    });
    await uninstallHooks(undefined, file);
    assert.deepEqual(await read(), { hooks: { PreToolUse: [foreign] } });
  });
});

describe('the user keeps their file', () => {
  // `settings.json` is hand-edited and the CLI reads it as jsonc. Editing the
  // text rather than round-tripping the document is what these assert; a
  // parse/stringify implementation passes every test above and fails all three.

  it('keeps comments and trailing commas', async () => {
    const original = [
      '{',
      '  // the model I actually want',
      '  "model": "opus",',
      '  "permissions": {',
      '    "allow": ["Bash"],',
      '  },',
      '}',
      ''
    ];
    const ours = [
      '  "hooks": {',
      '    "Stop": [',
      '      {',
      '        "hooks": [',
      '          {',
      '            "type": "command",',
      `            "command": "${CMD}"`,
      '          }',
      '        ]',
      '      }',
      '    ]',
      '  },'
    ];
    // Ours last, where install's `modify` appended it.
    await fs.writeFile(file, [...original.slice(0, -2), ...ours, ...original.slice(-2)].join('\n'));
    await uninstallHooks([SCRIPT], file);
    assert.equal(await raw(), original.join('\n'), 'the file came back byte-for-byte');
  });

  it('leaves a hand-formatted foreign hook, and a comment inside hooks, alone', async () => {
    // The foreign entry is written on one line inside a multi-line array — a
    // shape nothing here would ever emit — and must not be reflowed when ours
    // is taken out from beside it.
    const lines = (ours: string[]) => [
      '{',
      '  "hooks": {',
      '    // my own hook',
      '    "SessionStart": [',
      '      { "hooks": [{ "type": "command", "command": "echo hi" }] }',
      '    ]' + (ours.length ? ',' : ''),
      ...ours,
      '  },',
      '  "statusLine": { "type": "command", "command": "x" }',
      '}',
      ''
    ];
    const original = lines([]).join('\n');
    await fs.writeFile(
      file,
      lines([
        '    "Stop": [',
        `      { "hooks": [{ "type": "command", "command": "${CMD}" }] }`,
        '    ]'
      ]).join('\n')
    );
    await uninstallHooks([SCRIPT], file);
    assert.equal(await raw(), original);
  });

  it('keeps a comment beside ours in the same event array', async () => {
    const lines = (ours: string[]) => [
      '{',
      '  "hooks": {',
      '    "PreToolUse": [',
      '      // lint before every command',
      '      { "hooks": [{ "type": "command", "command": "npm run lint" }] }' +
        (ours.length ? ',' : ''),
      ...ours,
      '    ]',
      '  }',
      '}',
      ''
    ];
    await fs.writeFile(
      file,
      lines([
        `      { "matcher": ".*", "hooks": [{ "type": "command", "command": "${CMD}" }] }`
      ]).join('\n')
    );
    await uninstallHooks([SCRIPT], file);
    // The comment and the user's entry survive untouched. The one cost is that
    // jsonc takes the whitespace before `]` with the removed element; asking it
    // to format instead reflows the user's one-line entry, which is worse.
    const expected = lines([]).join('\n').replace('}] }\n    ]', '}] } ]');
    assert.equal(await raw(), expected);
  });

  it(
    'writes through a symlink rather than replacing it',
    { skip: needsFileSymlinks() },
    async () => {
      // Dotfile managers link `settings.json` in; a rename over the link would
      // leave a plain file and detach the user's managed copy.
      const target = path.join(dir, `managed-${Math.random().toString(36).slice(2)}.json`);
      await fs.writeFile(target, JSON.stringify({ hooks: richStatus() }, null, 2) + '\n');
      await fs.symlink(target, file);
      await uninstallHooks([SCRIPT], file);
      assert.ok((await fs.lstat(file)).isSymbolicLink(), 'still a link');
      assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), {});
    }
  );

  it('refuses to write a file it cannot parse', async () => {
    // A fat-fingered brace used to mean "start from {} and restore a sane
    // file" — which is the user's whole settings replaced by ours.
    const broken = `{ "hooks": { "Stop": [{ "hooks": [{ "command": "${CMD}" }] }] }\n`;
    await fs.writeFile(file, broken);
    await uninstallHooks([SCRIPT], file);
    assert.equal(await raw(), broken);
  });
});
