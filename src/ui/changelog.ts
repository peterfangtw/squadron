export type Release = { version: string; body: string };

/** Packaged release sections through the version this extension is running. */
export function releases(source: string, version: string): Release[] {
  const current = version
    .match(/^(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number);
  return source
    .split(/^## /m)
    .slice(1)
    .flatMap((section) => {
      const end = section.indexOf('\n');
      const heading = section.slice(0, end).trim();
      const numbers = heading
        .match(/^(\d+)\.(\d+)\.(\d+)$/)
        ?.slice(1)
        .map(Number);
      if (!numbers || end < 0) return [];
      if (current) {
        const differing = numbers.findIndex((value, i) => value !== current[i]);
        if (differing >= 0 && (numbers[differing] ?? 0) > (current[differing] ?? 0)) return [];
      }
      return [{ version: heading, body: section.slice(end + 1).trim() }];
    });
}
