import * as localPath from './local_path';

export interface FileLink {
  path: string;
  line?: number;
  column?: number;
}

/** Local Markdown targets; source positions are parsed before URL decoding. */
export function fileLink(href: string, cwd: string): FileLink | undefined {
  if (!href || href !== href.trim() || /^[#?]/.test(href) || hasControlCharacters(href)) return;
  const isFileUrl = /^file:\/\//i.test(href);
  const drive = /^[a-z]:(?:[\\/]|%5c|%2f)/i.test(href);
  const target = href.split(/[?#]/, 1)[0] ?? '';
  const suffix = target.match(/^(.*?):(\d+)(?::(\d+))?$/);
  const hash = href.slice(href.indexOf('#') === -1 ? href.length : href.indexOf('#'));
  const fragment = hash.match(/^#L(\d+)(?:C(\d+))?$/);
  if (/^#L(?:\d|[-+])/.test(hash) && !fragment) return;
  if (
    !drive &&
    !isFileUrl &&
    /^[a-z][a-z\d+.-]*:/i.test(href) &&
    (!suffix ||
      !/^[^:/]+$/.test(suffix[1] ?? '') ||
      /^(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|data|javascript|vbscript|command|vscode(?:-insiders)?|file):/i.test(
        href
      ) ||
      /^[a-z]:/i.test(href))
  )
    return;
  const position =
    suffix || fragment
      ? {
          line: Number(suffix?.[2] ?? fragment?.[1]),
          column: Number(suffix ? (suffix[3] ?? 1) : (fragment?.[2] ?? 1))
        }
      : undefined;
  if (
    position &&
    (!Number.isSafeInteger(position.line) ||
      position.line < 1 ||
      !Number.isSafeInteger(position.column) ||
      position.column < 1)
  )
    return;
  let raw = suffix?.[1] ?? target;
  if (isFileUrl) {
    // URL.host folds authority spelling and accepts credentials.
    const parts = raw.match(/^file:\/\/([^/]*)(\/.*)$/i);
    if (!parts) return;
    const authority = parts[1] ?? '';
    raw = parts[2] ?? '';
    if (authority && !/^localhost$/i.test(authority)) {
      if (!/^[\w.-]+$/.test(authority) || !/^\/[^/]+(?:\/|$)/.test(raw) || /%5c|%2f/i.test(raw))
        return;
      raw = `\\\\${authority}${raw.replaceAll('/', '\\')}`;
    } else if (raw.startsWith('//')) return;
    else if (/^\/[a-z]:\//i.test(raw)) raw = raw.slice(1);
    else if (/^\/[a-z]:/i.test(raw)) return;
  } else if (href.startsWith('//')) return;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return;
  }
  if (hasControlCharacters(decoded)) return;
  if (localPath.windowsPath(raw) || drive || /^%5c%5c/i.test(raw)) {
    return validWindowsTarget(decoded) ? { path: decoded, ...position } : undefined;
  }
  if (/^[\\/]{2}|^\\|^[a-z]:/i.test(decoded)) return;
  if (localPath.windowsPath(cwd) && !decoded.startsWith('/')) {
    const path = relativeWindows(cwd, decoded);
    return path && validWindowsTarget(path) ? { path, ...position } : undefined;
  }
  try {
    const base =
      cwd.startsWith('/') && !cwd.startsWith('//')
        ? `file://${cwd.split('/').map(encodeURIComponent).join('/').replace(/\/$/, '')}/`
        : undefined;
    // URL treats backslashes as slashes; POSIX names retain those bytes.
    const escaped = raw.replaceAll('\\', '%5C');
    const url = new URL(escaped.startsWith('/') ? escaped : `./${escaped}`, base);
    if (url.host || url.protocol !== 'file:') return;
    const path = decodeURIComponent(url.pathname);
    if (/^\/[\\/]/.test(path) || hasControlCharacters(path)) return;
    return { path, ...position };
  } catch {
    return;
  }
}

function validWindowsTarget(path: string): boolean {
  if (!localPath.windowsPath(path) || /^[\\/]{2}[?.][\\/]/.test(path) || hasControlCharacters(path))
    return false;
  const share = path.split(path.startsWith('//') ? /\// : /[\\/]/)[3];
  if (/^[\\/]{2}/.test(path) && (share === '.' || share === '..')) return false;
  return !path.replace(/^[a-z]:/i, '').includes(':');
}

function relativeWindows(cwd: string, relative: string): string | undefined {
  const slashRoot = cwd.startsWith('//');
  const separators = slashRoot ? /\// : /[\\/]/;
  const root = cwd.match(
    slashRoot ? /^\/\/[^/]+\/[^/]+\/?/ : /^[a-z]:[\\/]|^\\\\[^\\/]+[\\/][^\\/]+[\\/]?/i
  )?.[0];
  if (!root || !validWindowsTarget(cwd)) return;
  const separator = !slashRoot && cwd.includes('\\') ? '\\' : '/';
  const parts: string[] = [];
  for (const part of [...cwd.slice(root.length).split(separators), ...relative.split(separators)]) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return root.replace(slashRoot ? /\/$/ : /[\\/]$/, '') + separator + parts.join(separator);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}
