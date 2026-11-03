import * as path from 'path';
import { containment, type PathKey, type Paths } from './index';

/**
 * Folds only what every Windows volume resolves as one spelling: the drive
 * letter's case, and `/` against `\` outside a device namespace. Everything else
 * stays as given. Observed 2026-10-26 on Windows 11 26200 (paths task, Notes):
 * a case-sensitive directory, which `fsutil` makes without elevation, holds
 * `Foo` and `foo` as two directories, and a UNC server decides its own case.
 */
export function paths(): Paths {
  const key = (raw: string) => fold(raw) as PathKey;
  return {
    key,
    contains: containment(
      path.win32,
      key,
      (raw) => DEVICE.test(raw),
      (raw) => DRIVE.test(raw) || SHARE.test(raw) || DEVICE.test(raw)
    )
  };
}

// `C:\…` or `c:/…`. `C:foo` is relative to that drive's current directory.
const DRIVE = /^[A-Za-z]:[\\/]/;
// `\\server\…` in either separator. `\\?\` skips Win32 normalization, so a `/`
// there is a literal; it and the `\\.\` device namespace stay as given.
const UNC = /^[\\/]{2}(?![?.](?:[\\/]|$))[^\\/]/;
// Containment needs both server and share; a rooted path still needs a drive.
const SHARE = /^[\\/]{2}(?![?.](?:[\\/]|$))[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/;
// `\\?\` skips Win32 normalization; `\\.\` and NT `\??\` were not observed. A
// dot segment in any of them is not resolved lexically.
const DEVICE = /^(?:[\\/]{2}[?.]|\\\?\?)(?:[\\/]|$)/;

function fold(raw: string): string {
  if (DRIVE.test(raw)) return raw.charAt(0).toUpperCase() + raw.slice(1).replaceAll('/', '\\');
  if (UNC.test(raw)) return raw.replaceAll('/', '\\');
  return raw;
}
