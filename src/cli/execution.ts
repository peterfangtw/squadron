import * as adapter from '../core/adapter';
import * as checkpoint from '../core/checkpoint';
import * as execution from '../core/execution';
import * as identity from '../core/identity';

async function main(): Promise<void> {
  const file = process.env[identity.EXECUTION_CONTEXT_ENV];
  if (!file) return;
  const admission = await execution.readAdmission(file);
  if (!admission?.enabled) return;
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 4 * 1024 * 1024) return;
  }
  const payload: unknown = JSON.parse(input);
  const children = await execution.readExecutionChildren(file);
  const decoded = adapter.adapter(admission.brand)?.execution?.decode(payload, admission, children);
  if (decoded?.child) {
    const child = decoded.child;
    const original = children.find(
      (value) => value.actor === child.actor && value.parent === child.parent
    );
    if (!child.ended || original)
      await execution.appendExecutionChild(file, {
        actor: child.actor,
        parent: child.parent,
        turn: original?.turn ?? admission.turn,
        ...(child.ended ? { ended: Date.now() } : {})
      });
  }
  if (decoded?.request) await checkpoint.captureExecution(decoded.request, file);
}

// Hook failure must not deny execution. The native 10s timeout can also kill a
// capture; an unmatched edge or missing pair retains the turn floor.
const timeout = setTimeout(() => process.exit(0), 9_000);
void main()
  .catch(() => undefined)
  .finally(() => {
    clearTimeout(timeout);
    process.exit(0);
  });
