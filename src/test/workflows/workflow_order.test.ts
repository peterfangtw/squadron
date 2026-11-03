import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { tempHome } from '../helpers';

type Order = typeof import('../../core/workflows/workflow_order');

let home: string;
let order: Order;

const file = () => path.join(home, '.squadron', 'workflows.order.json');

before(async () => {
  home = await tempHome();
  order = await import('../../core/workflows/workflow_order');
});

async function reset(): Promise<void> {
  await fs.rm(file(), { force: true });
}

/** A workflow, as far as the fold is concerned: an id and a name. */
const w = (id: string, label = id) => ({ id, label });

describe('the workflow order store', () => {
  it('has nothing to say before anything has been stated', async () => {
    await reset();
    assert.equal(await order.readWorkflowOrder(), undefined);
  });

  it('round-trips an order', async () => {
    await reset();
    assert.equal(await order.writeWorkflowOrder({ order: ['ship', 'review'] }), true);
    const read = await order.readWorkflowOrder();
    assert.deepEqual(read?.order, ['ship', 'review']);
  });

  it('ignores the keys an older file still carries, and drops them on the next write', async () => {
    await reset();
    await fs.mkdir(path.dirname(file()), { recursive: true });
    await fs.writeFile(
      file(),
      JSON.stringify({
        schema: 1,
        updatedAt: 1,
        order: ['ship'],
        pinned: ['ship'],
        dropDefault: 'ship'
      })
    );
    const read = await order.readWorkflowOrder();
    assert.equal(read !== undefined && 'dropDefault' in read, false);
    assert.equal(read !== undefined && 'pinned' in read, false);
    assert.deepEqual(read?.order, ['ship']);
    assert.equal(await order.writeWorkflowOrder({ order: read?.order ?? [] }), true);
    const raw = JSON.parse(await fs.readFile(file(), 'utf8')) as Record<string, unknown>;
    assert.equal('dropDefault' in raw, false);
    assert.equal('pinned' in raw, false);
  });

  it('reads a half-written or foreign file as nothing stated', async () => {
    await reset();
    await fs.mkdir(path.dirname(file()), { recursive: true });
    await fs.writeFile(file(), '{"schema":1,"order":["shi');
    assert.equal(await order.readWorkflowOrder(), undefined);

    await fs.writeFile(file(), JSON.stringify({ schema: 2, order: ['ship'] }));
    assert.equal(await order.readWorkflowOrder(), undefined);
  });

  it('degrades a field of the wrong type rather than throwing', async () => {
    await reset();
    await fs.mkdir(path.dirname(file()), { recursive: true });
    // `order` as a string is the one that would reach `includes` and throw.
    await fs.writeFile(file(), JSON.stringify({ schema: 1, updatedAt: 1, order: 'ship' }));
    assert.deepEqual((await order.readWorkflowOrder())?.order, []);

    await fs.writeFile(
      file(),
      JSON.stringify({ schema: 1, updatedAt: 1, order: [3, null, 'ok', 'ok'] })
    );
    assert.deepEqual((await order.readWorkflowOrder())?.order, ['ok']);
  });
});

describe('the fold', () => {
  it('sorts by label when nothing has been stated — H49 floor, S7', () => {
    const list = [w('c', 'Charlie'), w('a', 'Alpha'), w('b', 'Bravo')];
    assert.deepEqual(
      order.orderWorkflows(list, undefined).map((x) => x.id),
      ['a', 'b', 'c']
    );
  });

  it('puts the stated ones first, in the order they were stated', () => {
    const list = [w('a', 'Alpha'), w('b', 'Bravo'), w('c', 'Charlie')];
    const record = {
      schema: 1 as const,
      updatedAt: 0,
      order: ['c', 'a']
    };
    assert.deepEqual(
      order.orderWorkflows(list, record).map((x) => x.id),
      ['c', 'a', 'b']
    );
  });

  it('appends a newcomer under everything stated, never sorting it in — S3', () => {
    // `aardvark` sorts first by label, and must still land last: the reader
    // placed the other two, and an insert would move them.
    const list = [w('z', 'Zulu'), w('m', 'Mike'), w('new', 'Aardvark')];
    const record = { schema: 1 as const, updatedAt: 0, order: ['z', 'm'] };
    assert.deepEqual(
      order.orderWorkflows(list, record).map((x) => x.id),
      ['z', 'm', 'new']
    );
  });

  it('sorts several newcomers among themselves by label', () => {
    const list = [w('z', 'Zulu'), w('n2', 'Bravo'), w('n1', 'Alpha')];
    const record = { schema: 1 as const, updatedAt: 0, order: ['z'] };
    assert.deepEqual(
      order.orderWorkflows(list, record).map((x) => x.id),
      ['z', 'n1', 'n2']
    );
  });

  it('leaves no hole where a stated workflow has been deleted — S4', () => {
    const list = [w('a', 'Alpha'), w('c', 'Charlie')];
    const record = {
      schema: 1 as const,
      updatedAt: 0,
      order: ['a', 'gone', 'c']
    };
    const folded = order.orderWorkflows(list, record);
    assert.deepEqual(
      folded.map((x) => x.id),
      ['a', 'c']
    );
    assert.equal(folded.length, 2);
  });

  it('places each workflow once even if the file names it twice', () => {
    const list = [w('a', 'Alpha'), w('b', 'Bravo')];
    const record = { schema: 1 as const, updatedAt: 0, order: ['a', 'a', 'b'] };
    assert.deepEqual(
      order.orderWorkflows(list, record).map((x) => x.id),
      ['a', 'b']
    );
  });

  it('is empty for a machine with no workflows, whatever the file says', () => {
    const record = { schema: 1 as const, updatedAt: 0, order: ['a'] };
    assert.deepEqual(order.orderWorkflows([], record), []);
  });
});
