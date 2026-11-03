/** Separator grammar comes from an absolute Windows path, never the host OS. */
export function windowsPath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path) || /^(?:\\\\|\/\/)(?![?.][\\/])[^\\/]+[\\/][^\\/]+/.test(path);
}

/** A raw path's last component; POSIX names may contain literal backslashes. */
export function pathLeaf(path: string): string {
  const separator = windowsPath(path) && !path.startsWith('//') ? /[\\/]/ : /\//;
  return path.split(separator).filter(Boolean).at(-1) || path;
}
