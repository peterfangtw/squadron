import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import type { BrandId } from '../../core/model';
import * as mcp from '../../core/mcp';
import { repoRoot } from '../helpers';

type HealthRoots = (
  rows: readonly mcp.McpRow[],
  roots: readonly string[],
  brand: BrandId
) => string[];

const healthRoots: HealthRoots = (rows, roots, brand) => {
  const fn = (mcp as { healthRoots?: HealthRoots }).healthRoots;
  if (!fn) throw new Error('healthRoots is missing');
  return fn(rows, roots, brand);
};

const row = (brand: BrandId, entries: mcp.McpEntry[], name: string = brand): mcp.McpRow => ({
  brand,
  name,
  key: `${brand}:${name}`,
  host: 'example.test',
  projects: [],
  state: 'unknown',
  canLogin: false,
  canDisconnect: false,
  entries
});

describe('health roots', () => {
  const declaring = [
    row(
      'claude',
      [
        { root: '/a', scope: 'project' },
        { root: '/b', scope: 'local' }
      ],
      'one'
    ),
    row('claude', [{ root: '/a', scope: 'project' }], 'two'),
    row('grok', [{ root: '/g', scope: 'project' }]),
    row('codex', [{ root: '/c', scope: 'local' }])
  ];

  it("probes only the asked brand's declaring roots", () => {
    assert.deepEqual(healthRoots(declaring, ['/x', '/a'], 'claude'), ['/a', '/b']);
    assert.deepEqual(healthRoots(declaring, ['/x', '/a'], 'grok'), ['/g']);
  });

  it('user-scope fallback', () => {
    const rows = [row('claude', [])];
    assert.deepEqual(healthRoots(rows, ['/first', '/second'], 'claude'), ['/first']);
  });

  it('fallback needs a root', () => {
    const rows = [row('claude', [])];
    assert.deepEqual(healthRoots(rows, [], 'claude'), []);
  });

  it('no rows for the brand', () => {
    const rows = [
      row('grok', [{ root: '/g', scope: 'project' }]),
      row('codex', [{ root: '/c', scope: 'local' }])
    ];
    assert.deepEqual(healthRoots(rows, ['/first', '/second'], 'claude'), []);
  });

  it('host selects by driver, not by brand name', () => {
    const source = fs.readFileSync(path.resolve(repoRoot(), 'src/host/panel_auth.ts'), 'utf8');
    assert.equal(source.match(/\.brand\s*===\s*'/), null);
    const start = source.indexOf('const MCP_READERS');
    const end = source.indexOf('\n};', start);
    const block = source.slice(start, end);
    const probes = block.match(/probe:/g) ?? [];
    assert.equal(probes.length, 1);
    const probeAt = block.indexOf('probe:');
    assert.ok(probeAt > block.indexOf('claude:'));
    assert.ok(probeAt < block.indexOf('grok:'));
  });
});
