import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import * as platform from '../../core/platform';
import type * as commands from '../../core/platform/commands';
import * as darwin from '../../core/platform/commands/darwin';
import * as win32 from '../../core/platform/commands/win32';
import { tempHome, testPlatform } from '../helpers';

const WORD: commands.Policy = { program: 'quoted', args: 'word' };
const QUOTED: commands.Policy = { program: 'literal', args: 'quoted' };
const DOUBLE: commands.Policy = { program: 'unescapedDouble', args: 'unescapedDouble' };

describe('command rendering', () => {
  const program = "/opt/my tools/it's";
  const args: commands.Arg[] = [
    'plain-id_1.2',
    'with space',
    "it's",
    'a"b',
    '日本',
    '{"j":1}',
    'two\nlines',
    '',
    7,
    { option: '--path', value: '/a b' }
  ];
  const spelled: [commands.Policy, string][] = [
    [
      WORD,
      `'/opt/my tools/it'\\''s' plain-id_1.2 'with space' 'it'\\''s' 'a"b' '日本' '{"j":1}' 'two\nlines' '' 7 --path='/a b'`
    ],
    [
      QUOTED,
      `/opt/my tools/it's 'plain-id_1.2' 'with space' 'it'\\''s' 'a"b' '日本' '{"j":1}' 'two\nlines' '' 7 --path='/a b'`
    ],
    [
      DOUBLE,
      `"/opt/my tools/it's" "plain-id_1.2" "with space" "it's" "a"b" "日本" "{"j":1}" "two\nlines" "" 7 --path="/a b"`
    ]
  ];

  for (const [host, rendering] of [
    ['darwin', darwin.commands()],
    ['legacy win32', win32.commands()],
    ['this host', platform.commands]
  ] as const) {
    it(`spells each producer's policy byte for byte on ${host}, numbers bare`, () => {
      for (const [policy, text] of spelled) {
        assert.equal(rendering.render(program, args, policy, 'posix'), text);
      }
      assert.equal(rendering.render('/bin/x', [], WORD, 'posix'), "'/bin/x'");
    });
  }

  // win32's POSIX consumer is Git Bash (Claude's tool and hook shell).
  const sh = testPlatform() === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/sh';
  it(
    'hands every argument through a real shell intact',
    { skip: !fsSync.existsSync(sh) && 'win32: Git Bash is not installed here' },
    () => {
      const hard: commands.Arg[] = [
        'with space',
        "it's",
        '{"j":1,"k":["x y"]}',
        '日本 ünï',
        'line one\nline two',
        '',
        'a"b$c`d\\e*',
        '--flag',
        42,
        { option: '--opt', value: "o'p q" }
      ];
      const doubled = ['a\\\\b', '\\\\server\\share', 'C:\\x\\\\'];
      for (const value of doubled) {
        assert.equal(
          platform.commands.carries(process.execPath, [value], 'posix'),
          testPlatform() !== 'win32',
          value
        );
      }
      if (testPlatform() !== 'win32') hard.push(...doubled);
      const argv = hard.map((arg) =>
        typeof arg === 'object' ? `${arg.option}=${arg.value}` : String(arg)
      );
      const print = 'console.log(JSON.stringify(process.argv.slice(1)))';
      const probe = platform.commands.render(process.execPath, ['-e', print, '--'], WORD, 'posix');
      for (const line of [
        platform.commands.render(process.execPath, ['-e', print, '--', ...hard], WORD, 'posix'),
        `probe() { ${probe} "$@"; }; ${platform.commands.render('probe', hard, QUOTED, 'posix')}`
      ]) {
        const run = cp.spawnSync(sh, ['-c', line], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
        assert.deepEqual(JSON.parse(run.stdout), argv);
      }
    }
  );
});

/**
 * Regenerated from the pre-seam producers with HOME at a plain temp directory
 * (`<T>`), so an always-quoted word reads apart from one quoted only where
 * needed. A native hook is trusted by its exact text: a change here, however
 * equivalent in a shell, needs approval and a note about hook re-review.
 */
describe(
  'emitted commands, byte for byte',
  {
    skip:
      testPlatform() === 'win32' &&
      'win32: spelled with POSIX home paths; legacy win32 parity is the rendering table — W1'
  },
  () => {
    const SHA = '66ba719f48d5f94efa0a77848db63a94b543b1c86f0810d5804fdd78c357b6ee';
    const RUNNER = `<T>/.squadron/execution/runners/${SHA}.js`;
    const HOOK = `/usr/bin/env node '${RUNNER}'`;
    const STEP = "'<T>/.squadron/bin/squadron-step'";
    const flag = (event: string) =>
      `hooks.${event}=[{matcher="^(Bash|apply_patch)$",hooks=[{type="command",command="/usr/bin/env node '${RUNNER}'",timeout=10}]}]`;
    const quotedFlag = (event: string) =>
      `'hooks.${event}=[{matcher="^(Bash|apply_patch)$",hooks=[{type="command",command="/usr/bin/env node '\\''${RUNNER}'\\''",timeout=10}]}]'`;

    let root: string;
    let hook: string;
    const T = (text: string) => text.replaceAll(root, '<T>');
    const integration = (brand: 'claude' | 'grok' | 'codex') => {
      const found = adapters.adapter(brand)?.execution;
      assert.ok(found);
      return found;
    };
    let adapters: typeof import('../../core/adapter');
    let paths: typeof import('../../core/paths');

    before(async () => {
      root = await tempHome();
      assert.match(root, /^[\w@%+=:,./-]+$/, 'the goldens assume a home no policy quotes');
      adapters = await import('../../core/adapter');
      paths = await import('../../core/paths');
      const execution = await import('../../core/execution');
      const source = path.join(root, 'runner-bundle.js');
      await fs.writeFile(source, '// golden runner\n');
      let captured: string | undefined;
      const prepared = await execution.prepareExecution(
        {
          configure: (command) => {
            captured = command;
            return Promise.resolve(command);
          },
          hookShell: 'posix',
          decode: () => undefined
        },
        source,
        true
      );
      assert.ok(prepared.runtime.enabled && captured);
      hook = captured;
    });

    it('pins the execution hook command, its runner always quoted', () => {
      assert.equal(T(hook), HOOK);
    });

    it("pins Codex's hook flags and its whole review file", async () => {
      const directory = path.join(root, 'codex');
      await fs.mkdir(directory);
      const args = (await integration('codex').configure(hook, directory)) as string[];
      assert.deepEqual(args.map(T), ['-c', flag('PreToolUse'), '-c', flag('PostToolUse')]);
      assert.equal(
        T(await fs.readFile(path.join(directory, 'codex-hook-review.txt'), 'utf8')),
        'Run this in the same Codex environment, then open /hooks and review the two Session flags hooks. Restart the owned session afterward.\n\n' +
          `codex '-c' ${quotedFlag('PreToolUse')} '-c' ${quotedFlag('PostToolUse')}\n`
      );
    });

    it("carries the hook command unchanged into Claude's and Grok's hook config", async () => {
      const commandsIn = (config: unknown) =>
        Object.values(
          (config as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks
        )
          .flat()
          .flatMap((entry) => entry.hooks.map((one) => T(one.command)));
      const claude = commandsIn(await integration('claude').configure(hook, root));
      assert.deepEqual(claude, Array<string>(5).fill(HOOK));
      const directory = path.join(root, 'grok');
      await fs.mkdir(directory);
      await integration('grok').configure(hook, directory);
      const grok = commandsIn(
        JSON.parse(await fs.readFile(path.join(directory, 'plugin/hooks/hooks.json'), 'utf8'))
      );
      assert.deepEqual(grok, Array<string>(4).fill(HOOK));
    });

    it('pins the step verb in the briefing and in both workflow waits', async () => {
      const briefing = await import('../../core/workflows/progress_briefing');
      const wait = await import('../../core/coordination/wait');
      const execution = await import('../../core/workflows/progress_execution');
      assert.equal(T(paths.stepCommand('posix')), STEP);
      assert.ok(
        T(briefing.progressBriefing('/runs/x.progress.json', 'posix')).includes(
          `run \`${STEP} next\` for your next instruction, and \`${STEP} done --note "<what you did>"\` once that step is finished.`
        )
      );
      assert.ok(
        T(wait.resolutionText([], false, true, 'posix')).startsWith(
          `Your workflow wait is over. Run \`${STEP} next\` to continue or read why it cannot proceed.`
        )
      );
      assert.ok(
        T(execution.heldReason([{ pid: 5, who: 's1', holds: [], idle: true }], 'posix')).endsWith(
          `Ask the reader to have that session run \`${STEP} next\`, then run \`${STEP} next\` here again.`
        )
      );
    });

    it('pins the fetch-file instructions, its path always quoted', async () => {
      const words = await import('../../core/bridge/words');
      const admission = {
        correlation: 'C0rr.el-1',
        omitted: 2,
        files: [
          { id: 'file-0', source: 's', cacheKey: 'k', name: 'a.txt', mime: 'text/plain', size: 7 },
          { id: 'it\'s\n日本 {"j":1}', source: 's', cacheKey: 'k' },
          { id: '', source: 's', cacheKey: 'k' }
        ]
      } as unknown as import('../../core/bridge/model').IncomingAdmission;
      const lines = T(words.incomingManifest('conversation one', admission, 'posix')).split('\n');
      const fetch =
        "'<T>/.squadron/bin/squadron-fetch-file' --conversation-id 'conversation one' --message-id C0rr.el-1 --file-id";
      assert.deepEqual(lines.slice(lines.indexOf('```text') + 1), [
        '{"conversation":"conversation one","message":"C0rr.el-1","omitted":2}',
        '{"id":"file-0","name":"a.txt","mime":"text/plain","size":7}',
        `${fetch} file-0`,
        '{"id":"it\'s\\n日本 {\\"j\\":1}"}',
        `${fetch} 'it'\\''s`,
        '日本 {"j":1}\'',
        '{"id":""}',
        `${fetch} ''`,
        '```'
      ]);
    });
  }
);
