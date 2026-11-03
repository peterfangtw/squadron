import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseFlags, usageFor } from '../../cli/args';

const FLAGS = ['name', 'pid', 'force'] as const;
const BARE = ['force'] as const;
const USAGE = 'usage: verb --name <text> [--pid <n>]';

describe('parseFlags', () => {
  it('refuses a flag given twice rather than keeping the last', () => {
    assert.equal(parseFlags(['--pid', '1', '--pid', '2'], FLAGS), undefined);
    assert.equal(parseFlags(['--force', '--force'], FLAGS, BARE), undefined);
  });
});

describe('usageFor', () => {
  it('leads with the new spelling of every renamed flag the command line used', () => {
    assert.equal(
      usageFor(['--title', 'x', '--pid', '2', '--title', 'y'], USAGE, { title: 'name' }),
      `--title is now --name\n${USAGE}`
    );
  });

  it('finds one past a verb or a bare flag, which take no value', () => {
    assert.equal(
      usageFor(['start', '--force', '--title', 'x'], USAGE, { title: 'name' }),
      `--title is now --name\n${USAGE}`
    );
  });

  it('is the usage line alone when nothing renamed was used', () => {
    assert.equal(usageFor(['--nmae', 'x'], USAGE, { title: 'name' }), USAGE);
    assert.equal(usageFor(['--constructor', 'x'], USAGE, { title: 'name' }), USAGE);
  });
});
