/**
 * The chick: the mascot's sprite, shared by the mascot mockups.
 * Drawn with ./pixel.mjs; every frame is one call to chick() with a pose.
 */
import { arch, circle, ellipse, line, poly, px, rasterize, rect, rects, tilted } from './pixel.mjs';

// The chick: a round robo bird, 48×48, front-facing. Glossy rimless eyes by
// default; happy arcs when a turn finishes or it greets a new session; flat
// closed eyes asleep. Every frame is one call with a pose.
export function chick({
  squash = 0,
  lift = 0,
  look = 0,
  eyes = 'glint',
  feet = 'stand',
  wings = 'rest',
  bulb = 'T',
  beak = 'shut',
  puff = 0,
  extra = []
} = {}) {
  const rx = 13 * (1 + squash * 0.9) * (1 + puff),
    ry = 13 * (1 - squash) * (1 + puff * 0.3);
  const cx = 24,
    cy = 43 - ry - lift;
  const fy = 43 - lift;
  const top = cy - ry;
  const ey = Math.round(cy - 2);
  const by = Math.round(cy) + 2.5;
  const x = (dx) => cx + dx + look;
  const shapes = [ellipse(24, 45.3, lift ? 7 : 10, lift ? 0.9 : 1.2, 'H')];

  const FEET = {
    stand: [ellipse(19.5, fy, 2.6, 1.2, 'O'), ellipse(28.5, fy, 2.6, 1.2, 'O')],
    walk1: [ellipse(19.5, fy - 1.6, 2.4, 1.1, 'O'), ellipse(29, fy, 2.6, 1.2, 'O')],
    walk2: [ellipse(19, fy, 2.6, 1.2, 'O'), ellipse(28.5, fy - 1.6, 2.4, 1.1, 'O')],
    tuck: [ellipse(21, fy + 0.4, 2, 1, 'O'), ellipse(27, fy + 0.4, 2, 1, 'O')]
  };
  const WINGS = {
    rest: [ellipse(cx - rx + 0.5, cy + 1, 3, 5, 'G'), ellipse(cx + rx - 0.5, cy + 1, 3, 5, 'G')],
    up: [
      tilted(cx - rx - 0.5, cy - 6, 3, 6.5, -35, 'G'),
      tilted(cx + rx + 0.5, cy - 6, 3, 6.5, 35, 'G')
    ],
    down: [
      tilted(cx - rx - 0.5, cy + 5, 3, 6, 35, 'G'),
      tilted(cx + rx + 0.5, cy + 5, 3, 6, -35, 'G')
    ]
  };
  const EYES = {
    glint: (ex) => [
      circle(ex, ey + 0.5, 3.15, 'E'),
      rect(ex - 2.1, ey - 1.3, 2, 2, 'Q'),
      px(ex + 1.2, ey + 1.9, 'Q')
    ],
    wide: (ex) => [
      circle(ex, ey + 0.3, 3.6, 'E'),
      rect(ex - 2.3, ey - 1.8, 2, 2, 'Q'),
      px(ex + 1.4, ey + 2, 'Q')
    ],
    happy: (ex) => [arch(ex, ey + 1.9, 2.6, 1.5, 'E')],
    closed: (ex) => [line(ex - 2.2, ey + 1.6, ex + 2.2, ey + 1.6, 1.2, 'E')],
    // Squeezed shut toward the nose: '>' on the left eye, '<' on the right.
    squint: (ex, side) => [
      line(ex - 2 * side, ey - 0.5, ex + 1.5 * side, ey + 1.2, 1.1, 'E'),
      line(ex + 1.5 * side, ey + 1.2, ex - 2 * side, ey + 2.9, 1.1, 'E')
    ]
  };
  const BEAK = {
    shut: [
      poly(
        [
          [x(-1.5), by],
          [x(1.5), by],
          [x(0), by + 2.5]
        ],
        'O'
      )
    ],
    open: [
      poly(
        [
          [x(-1.5), by],
          [x(1.5), by],
          [x(0), by + 1.5]
        ],
        'O'
      ),
      rect(x(-1), by + 1.5, 2, 1, 'E'),
      poly(
        [
          [x(-1), by + 2.4],
          [x(1), by + 2.4],
          [x(0), by + 3.6]
        ],
        'O'
      )
    ],
    inhale: [
      ellipse(x(0), by + 3, 4.2, 3.8, 'E'),
      poly(
        [
          [x(-2), by - 1.2],
          [x(2), by - 1.2],
          [x(0), by + 0.4]
        ],
        'O'
      )
    ]
  };

  shapes.push(...FEET[feet], ...WINGS[wings]);
  shapes.push(
    line(24, top + 1, 25 + look * 0.4, top - 6, 0.9, 'D'),
    circle(25.5 + look * 0.4, top - 7.5, 2.2, bulb)
  );
  shapes.push(ellipse(cx, cy, rx, ry, 'W'));
  shapes.push(...EYES[eyes](x(-5), 1), ...EYES[eyes](x(5), -1), ...BEAK[beak]);
  shapes.push(
    ellipse(x(-9.5 - puff * 12), cy + 3, 2 + puff * 6, 1 + puff * 3, 'P'),
    ellipse(x(9.5 + puff * 12), cy + 3, 2 + puff * 6, 1 + puff * 3, 'P'),
    circle(cx + look * 0.5, cy + 9.5 * (1 - squash), 1.2, 'T')
  );
  shapes.push(...extra);
  return rasterize(shapes);
}

const bang = [rect(38, 5, 2, 6, 'Y'), rect(38, 12, 2, 2, 'Y')];
const sparkles = [
  rect(7, 11, 1, 3, 'Y'),
  rect(6, 12, 3, 1, 'Y'),
  rect(40, 8, 1, 3, 'Y'),
  rect(39, 9, 3, 1, 'Y'),
  px(42, 15, 'Y')
];
const zz = [
  line(36, 5, 40, 5, 0.9, 'G'),
  line(40, 5, 36, 9, 0.9, 'G'),
  line(36, 9, 40, 9, 0.9, 'G'),
  px(42, 12, 'G'),
  px(43, 12, 'G'),
  px(43, 13, 'G'),
  px(42, 14, 'G'),
  px(43, 14, 'G')
];

export const frames = {
  stand: chick(),
  walk1: chick({ feet: 'walk1', look: 2 }),
  walk2: chick({ feet: 'walk2', look: 2, squash: 0.03 }),
  crouch: chick({ squash: 0.14 }),
  fly1: chick({ lift: 6, wings: 'up', feet: 'tuck', look: 2 }),
  fly2: chick({ lift: 4, wings: 'down', feet: 'tuck', look: 2 }),
  alert: chick({ eyes: 'wide', bulb: 'Y', extra: bang }),
  happy: chick({ eyes: 'happy', beak: 'open', wings: 'up', extra: sparkles }),
  sleep: chick({ squash: 0.1, eyes: 'closed', bulb: 'G', extra: zz })
};

const N = 48;
/** Every frame of `set` stacked in one SVG, all but the first hidden; `only` draws one. */
export const spriteSvg = (set, size, only) =>
  `<svg class="droid" viewBox="0 0 ${N} ${N}" width="${size}" height="${size}" shape-rendering="crispEdges" aria-hidden="true">${Object.entries(
    set
  )
    .filter(([name]) => !only || name === only)
    .map(
      ([name, grid]) =>
        `<g class="fr" data-f="${name}"${only || name === Object.keys(set)[0] ? '' : ' hidden'}>${rects(grid)}</g>`
    )
    .join('')}</svg>`;

/** The extra poses the fun ideas need: inhale, stuffed, gulp and peck. */
export const funFrames = {
  ...frames,
  peck: chick({ squash: 0.1, beak: 'open', eyes: 'happy' }),
  gulp: chick({ puff: 0.14, eyes: 'happy' }),
  inhale: chick({ puff: 0.05, eyes: 'squint', beak: 'inhale', wings: 'up' }),
  stuffed: chick({ puff: 0.24 })
};
