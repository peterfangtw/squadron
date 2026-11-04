/**
 * Pixel art from shapes, shared by the mascot mockups.
 *
 * A sprite is a list of shapes in grid units, rasterized at pixel centres with
 * later shapes over earlier ones. Two passes then make it read as pixel art
 * rather than a blurry vector: a dark outline around the silhouette, and a
 * shaded rim along the silhouette's lower edge.
 *
 * Tones are one letter each and paint through `toneCss`, so every colour is a
 * theme token and a preset repaints the sprite:
 * W shell, V shell shade (auto), G wing (accent), D antenna, O orange, E eye dark,
 * Q eye highlight, I iris, T glow (accent), Y yellow, P blush, K outline (auto),
 * H floor shadow.
 */

export const ellipse = (cx, cy, rx, ry, t) => ({
  t,
  hit: (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1
});
export const circle = (cx, cy, r, t) => ellipse(cx, cy, r, r, t);
export const rect = (x0, y0, w, h, t) => ({
  t,
  hit: (x, y) => x >= x0 && x < x0 + w && y >= y0 && y < y0 + h
});
export const px = (x, y, t) => rect(x, y, 1, 1, t);
export const round = (x0, y0, w, h, r, t) => ({
  t,
  hit: (x, y) => {
    if (x < x0 || x >= x0 + w || y < y0 || y >= y0 + h) return false;
    const dx = Math.max(x0 + r - x, 0, x - (x0 + w - r));
    const dy = Math.max(y0 + r - y, 0, y - (y0 + h - r));
    return dx * dx + dy * dy <= r * r;
  }
});
export const line = (x0, y0, x1, y1, w, t) => ({
  t,
  hit: (x, y) => {
    const vx = x1 - x0,
      vy = y1 - y0;
    const k = Math.max(0, Math.min(1, ((x - x0) * vx + (y - y0) * vy) / (vx * vx + vy * vy || 1)));
    return Math.hypot(x - (x0 + k * vx), y - (y0 + k * vy)) <= Math.max(w / 2, 0.72);
  }
});
/** The upper half of a ring: a closed, smiling eye. */
export const arch = (cx, cy, r, w, t) => ({
  t,
  hit: (x, y) => y <= cy && Math.abs(Math.hypot(x - cx, y - cy) - r) <= w / 2
});
/** An ellipse turned by `deg`; negative tilts its top toward the left. */
export const tilted = (cx, cy, rx, ry, deg, t) => {
  const a = (deg * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  return {
    t,
    hit: (x, y) =>
      (((x - cx) * c + (y - cy) * s) / rx) ** 2 + ((-(x - cx) * s + (y - cy) * c) / ry) ** 2 <= 1
  };
};
export const poly = (pts, t) => ({
  t,
  hit: (x, y) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i],
        [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
});

/** Shapes → tone grid (rows of one-letter tones, '.' empty), outlined and shaded. */
export function rasterize(shapes, n = 48) {
  const g = Array.from({ length: n }, () => Array(n).fill('.'));
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) for (const s of shapes) if (s.hit(x + 0.5, y + 0.5)) g[y][x] = s.t;
  const solid = (x, y) => x >= 0 && y >= 0 && x < n && y < n && g[y][x] !== '.' && g[y][x] !== 'H';
  const edge = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (
        !solid(x, y) &&
        (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))
      )
        edge.push([x, y]);
  for (const [x, y] of edge) g[y][x] = 'K';
  // Only the outside counts as an edge: shading above an eye or a beak is
  // what drew a grey ring round every eye.
  const out = (x, y) =>
    x < 0 || y < 0 || x >= n || y >= n || g[y][x] === 'K' || g[y][x] === '.' || g[y][x] === 'H';
  const shade = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (g[y][x] === 'W' && (out(x, y + 1) || (out(x + 1, y + 1) && out(x + 1, y))))
        shade.push([x, y]);
  for (const [x, y] of shade) g[y][x] = 'V';
  return g;
}

/** One `<rect>` per horizontal run of a tone, classed by tone. */
export function rects(grid) {
  const out = [];
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const c = row[x];
      let end = x;
      while (row[end + 1] === c) end++;
      if (c !== '.')
        out.push(
          `<rect class="${c.toLowerCase()}" x="${x}" y="${y}" width="${end - x + 1}" height="1"/>`
        );
      x = end + 1;
    }
  });
  return out.join('');
}

export const svg = (grid, size) =>
  `<svg class="droid" viewBox="0 0 ${grid.length} ${grid.length}" width="${size}" height="${size}" shape-rendering="crispEdges" aria-hidden="true">${rects(grid)}</svg>`;

export const toneCss = `
.droid { display:block; overflow:visible; }
.droid .w { fill:#f5f5f7; }
.droid .v { fill:#d9dbe0; }
.droid .g { fill:var(--av-focus); }
.droid .d { fill:color-mix(in srgb, var(--av-focus) 55%, #333); }
.droid .o { fill:color-mix(in srgb, var(--av-red) 55%, var(--av-yellow)); }
.droid .e { fill:#16161a; }
.droid .q { fill:color-mix(in srgb, var(--av-fg) 25%, #fff); }
.droid .i { fill:color-mix(in srgb, var(--av-yellow) 60%, var(--av-red)); }
.droid .t { fill:var(--av-focus); }
.droid .y { fill:var(--av-yellow); }
.droid .p { fill:color-mix(in srgb, var(--av-red) 45%, var(--av-fg)); }
.droid .k { fill:color-mix(in srgb, var(--av-focus) 22%, #141416); }
.droid .h { fill:var(--av-fg-3); opacity:.25; }`;
