import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as owners from './incoming_owner_helpers';

export type ToolResult = { code: number; stdout: string; stderr: string };

/**
 * One shell command run by a fake owned CLI's native tool child
 * (`fixtures/native_tool.ts`), so an installed verb sees a real owned ancestor.
 * `claim` is refreshed first, because a run can outlast a claim's freshness.
 */
export async function runNativeTool(
  child: Awaited<ReturnType<typeof owners.child>>,
  shell: string,
  options: { resultDir: string; claim?: string; env?: NodeJS.ProcessEnv }
): Promise<ToolResult> {
  if (options.claim !== undefined) {
    const claimPath = options.claim;
    const claim = await fs.readFile(claimPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (claim !== undefined) {
      const current = JSON.parse(claim) as Record<string, unknown>;
      await fs.writeFile(claimPath, JSON.stringify({ ...current, updatedAt: Date.now() }));
    }
  }
  const result = path.join(options.resultDir, `tool-${crypto.randomUUID()}.json`);
  assert.equal(
    (
      await child.route.messages!.send(
        `squadron-native-tool ${JSON.stringify({ command: shell, result, env: options.env })}`
      )
    ).ok,
    true
  );
  const deadline = Date.now() + 70_000;
  while (Date.now() < deadline) {
    const output = await fs.readFile(result, 'utf8').catch(() => undefined);
    if (output) {
      await owners.until(child.handle, (handle) => handle.state.status === 'idle');
      return JSON.parse(output) as ToolResult;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('native tool did not finish');
}
