import * as path from 'node:path';
import { mock } from 'node:test';
import * as platform from '../core/platform';
import * as win32 from '../core/platform/paths/win32';

/** Windows lexical inputs on any test host; real fixture IO keeps native paths. */
export async function withWin32Paths<T>(body: () => T | Promise<T>): Promise<T> {
  const { key, contains } = platform.paths;
  const resolve = path.resolve.bind(path);
  const winResolve = path.win32.resolve.bind(path.win32);
  const relative = path.win32.relative.bind(path.win32);
  const resolveMock = mock.method(path, 'resolve', (...parts: string[]) =>
    parts.some((part) => /^[A-Za-z]:|^[\\/]{2}/.test(part))
      ? winResolve(...parts)
      : resolve(...parts)
  );
  const relativeMock = mock.method(path, 'relative', (from: string, to: string) =>
    relative(from, to).replaceAll('\\', path.sep)
  );
  const absolute = path.win32.isAbsolute.bind(path.win32);
  const absoluteMock = mock.method(path, 'isAbsolute', absolute);
  Object.assign(platform.paths, win32.paths());
  try {
    return await body();
  } finally {
    Object.assign(platform.paths, { key, contains });
    resolveMock.mock.restore();
    relativeMock.mock.restore();
    absoluteMock.mock.restore();
  }
}
