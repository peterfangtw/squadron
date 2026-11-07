import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { repoRoot } from '../helpers';
import { describe, it } from 'node:test';
import { ESLint, RuleTester } from 'eslint';
import * as pills from '../../../scripts/eslint-mention-pills.cjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

new RuleTester().run('mention-pills', pills.rules['mention-pills'], {
  valid: ["el('span', 'status-badge');", "root.querySelector('.sref.ticket');"],
  invalid: [
    "el('span', 'sref ticket');",
    "node.className = 'pchip ticket';",
    'node.className = `sref ${kind}`;',
    "node.classList.add('pchip');",
    "node.setAttribute('class', 'sref');",
    'node.innerHTML = `<span class="sref ticket">ENG-42</span>`;'
  ].map((code) => ({ code, errors: [{ messageId: 'shared' }] }))
});

new RuleTester({ plugins: { squadron: { rules: pills.rules } } }).run(
  'mention-exception-reason',
  pills.rules['mention-exception-reason'],
  {
    valid: [
      '// eslint-disable-next-line squadron/mention-pills -- imported static preview\nvoid 0;'
    ],
    invalid: [
      '// eslint-disable-next-line squadron/mention-pills\nvoid 0;',
      '// eslint-disable squadron/mention-pills -- too broad\nvoid 0;'
    ].map((code) => ({ code, errors: [{ messageId: 'reason' }] }))
  }
);

it('enforces the mention boundary and named exceptions through the real ESLint config', async () => {
  const root = repoRoot();
  const lint = new ESLint({ cwd: root });
  const source = "document.body.className = 'sref ticket';";
  const run = async (code: string, file = 'src/webview/board.ts'): Promise<(string | null)[]> => {
    const [result] = await lint.lintText(code, { filePath: path.join(root, file) });
    assert.ok(result);
    return result.messages.map((message) => message.ruleId);
  };
  assert.deepEqual(await run(source), ['squadron/mention-pills']);
  assert.deepEqual(await run(source, 'src/webview/prose.ts'), []);
  assert.deepEqual(await run(source, 'src/webview/mention_pill.ts'), []);
  assert.deepEqual(
    await run(
      '// eslint-disable-next-line squadron/mention-pills -- reviewed static fixture\n' + source
    ),
    []
  );
  assert.deepEqual(await run("void '/* eslint-disable */';"), []);
  for (const code of [
    '/* eslint-disable */\n' + source,
    '/* eslint-disable -- a reason without a rule list */\n' + source,
    '// eslint-disable-next-line\n' + source,
    source + ' // eslint-disable-line'
  ])
    assert.deepEqual(await run(code), ['squadron/mention-exception-reason'], code);
});
