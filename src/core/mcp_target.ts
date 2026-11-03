import type { BrandId } from './brands';

/** Declaration identity is independent of the repo section used to display it. */
export type McpActionRef = {
  brand: BrandId;
  name: string;
  key: string;
  url?: string;
  /** Codex reports effective cwd configuration without declaration-file provenance. */
  declaration: { scope: 'user' } | { scope: 'local' | 'project' | 'effective'; root: string };
  readCwd: string;
};

export type McpActionTarget = McpActionRef & {
  canLogin: boolean;
  canDisconnect: boolean;
};

export function sameMcpRef(a: McpActionRef, b: McpActionRef): boolean {
  return (
    a.brand === b.brand &&
    a.name === b.name &&
    a.key === b.key &&
    a.url === b.url &&
    a.readCwd === b.readCwd &&
    a.declaration.scope === b.declaration.scope &&
    (a.declaration.scope === 'user' ||
      (b.declaration.scope !== 'user' && a.declaration.root === b.declaration.root))
  );
}

/** Untrusted clicks must identify exactly one current declaration and permitted verb. */
export function resolveMcpTarget(
  rows: readonly import('./mcp').McpRow[],
  input: unknown,
  verb: 'login' | 'disconnect'
): McpActionTarget | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const ref = input as Partial<McpActionRef>;
  if (
    !ref.declaration ||
    typeof ref.declaration !== 'object' ||
    !ref.name ||
    !ref.key ||
    !ref.readCwd
  )
    return undefined;
  const hits = rows.flatMap((row) =>
    row.fromAccount
      ? []
      : (row.declarations ?? []).flatMap((d) =>
          sameMcpRef(d.ref, ref as McpActionRef) ? [{ row, ref: d.ref }] : []
        )
  );
  if (hits.length !== 1) return undefined;
  const hit = hits[0];
  if (
    !hit ||
    (verb === 'login'
      ? !hit.row.canLogin || hit.row.state === 'pending' || hit.row.state === 'unknown'
      : !hit.row.canDisconnect)
  )
    return undefined;
  return { ...hit.ref, canLogin: hit.row.canLogin, canDisconnect: hit.row.canDisconnect };
}
