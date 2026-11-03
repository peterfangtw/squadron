import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { ESLint } from 'eslint';
import { repoRoot } from '../helpers';

const ROOT = repoRoot();
const lint = new ESLint({ cwd: ROOT });

describe('platform lint boundary', () => {
  it('errors on new OS reads, including computed access', async () => {
    const result = await lint.lintText("void process.platform; void process['platform'];", {
      filePath: path.join(ROOT, 'src/core/claude/mcp.ts')
    });
    assert.equal(result[0]?.errorCount, 2);
    assert.equal(result[0]?.warningCount, 0);
    assert.ok(
      result[0]?.messages.every(
        (message) => message.ruleId === 'squadron/os-read' && message.severity === 2
      )
    );
  });

  it('holds the same OS reads in tests as in product code', async () => {
    const source = "import * as os from 'node:os'; void os.platform(); void process.platform;";
    for (const file of ['src/core/claude/mcp.ts', 'src/test/claude/claude_mcp.test.ts']) {
      const [result] = await lint.lintText(source, { filePath: path.join(ROOT, file) });
      const reads = result?.messages.filter((message) => message.ruleId === 'squadron/os-read');
      assert.equal(reads?.length, 2, file);
    }
  });

  it('rejects OS reads at the retired legacy coordinate and elsewhere on the same line', async () => {
    const source = '\n'.repeat(533) + ' '.repeat(62) + 'process.platform; void process.platform;';
    const result = await lint.lintText(source, {
      filePath: path.join(ROOT, 'src/core/claude/mcp.ts')
    });
    const leaks = result[0]?.messages.filter((message) => message.ruleId === 'squadron/os-read');
    assert.equal(leaks?.length, 2);
    assert.ok(leaks?.every((message) => message.severity === 2));
  });

  it('keeps opaque Program execution inside the platform boundary', async () => {
    const result = await lint.lintText(
      "import { invoke } from '../platform/executables/internal'; void invoke;",
      {
        filePath: path.join(ROOT, 'src/core/claude/mcp.ts')
      }
    );
    assert.ok(
      result[0]?.messages.some(
        (message) => message.ruleId === 'no-restricted-imports' && message.severity === 2
      )
    );
  });

  it('keeps owner checks inside the private-files capability', async () => {
    const source = 'void process.getuid?.(); if (!process.getuid) void 0;';
    const leaked = await lint.lintText(source, {
      filePath: path.join(ROOT, 'src/core/remote/serve_attach.ts')
    });
    const leaks = leaked[0]?.messages.filter(
      (message) => message.ruleId === 'no-restricted-properties'
    );
    assert.equal(leaks?.length, 2);
    assert.ok(leaks?.every((message) => message.severity === 2));
    const owner = await lint.lintText(source, {
      filePath: path.join(ROOT, 'src/core/platform/private_files/darwin.ts')
    });
    assert.ok(!owner[0]?.messages.some((message) => message.ruleId === 'no-restricted-properties'));
  });

  it('allows the host selector and shared test helper', async () => {
    const source =
      "import * as os from 'node:os'; export const named = process.platform, kind = os.type();";
    for (const file of ['src/core/platform/host.ts', 'src/test/home.ts']) {
      const result = await lint.lintText(source, { filePath: path.join(ROOT, file) });
      assert.deepEqual(result[0]?.messages, [], file);
    }
    const reported = await lint.lintText(source, {
      filePath: path.join(ROOT, 'src/test/helpers.ts')
    });
    const reads = reported[0]?.messages.filter((message) => message.ruleId === 'squadron/os-read');
    assert.equal(reads?.length, 2);
    assert.ok(reads?.every((message) => message.severity === 2));
  });
});

describe('test portability lint scope', () => {
  const source =
    "import * as fs from 'node:fs'; process.env.HOME = 'h'; fs.mkdtempSync('/tmp/x-');";
  const rules = async (file: string) => {
    const [result] = await lint.lintText(source, { filePath: path.join(ROOT, file) });
    return result?.messages.map((message) => message.ruleId).sort();
  };

  it('holds home writes and temp roots in every test file, smoke and helpers included', async () => {
    for (const file of [
      'src/test/claude/claude_mcp.test.ts',
      'src/test/smoke/boot.ts',
      'src/test/helpers.ts',
      'src/test/home.ts'
    ])
      assert.deepEqual(await rules(file), ['squadron/home-write', 'squadron/temp-root'], file);
  });

  it('leaves product code its own environment', async () => {
    assert.deepEqual(await rules('src/core/grok/auth.ts'), []);
  });
});
