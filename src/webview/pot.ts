/**
 * The moka pot that leans in when the cup refills, from the approved mockup
 * `docs/mockups/coffee-cup/moka-overdrive.html`.
 *
 * **The shading is computed, not pasted.** Overdrive's thesis is that the lamp
 * stays put in the room while the pot rotates under it, so the eight gradients
 * the drawing paints with are a function of the pot's angle and cannot be a
 * `defs` block written down once. What is written down is the offsets — they
 * depend on roughness alone — and what is written per frame is `stop-color`,
 * which has no layout, so a pour costs 54 attribute writes a frame and no
 * reflow. The mockup states the deliverable in those words: ship the shading,
 * not a set of stops.
 *
 * **The tip is a spring, not a transition.** Two things downstream need the
 * angle as a number rather than as a matrix the page cannot read: the shading
 * above, and the stream, which leaves the lip and then falls straight down in
 * the board's frame whatever the pot is doing. A CSS transition can animate the
 * pot; it cannot tell anyone else where the pot is.
 *
 * **What was left in the mockup.** The grain filters (two `feTurbulence`
 * passes) — the mockup's own size ladder drops them under 48px and the pot
 * draws about 37px here. The heat group and its emitted warm term — `#cafe.hot`
 * already means "there is coffee in the cup", and a second meaning on the same
 * word is worse than a missing ember. The six finishes and five roughnesses:
 * this is one pot in one finish, `two`, steel over black.
 */

/* ── the drawing's place on the board ──────────────────────────────────────
   The cup is drawn at full size in a 128 box (rim ellipse cx 64 cy 47 rx 27),
   so the mockup's scene numbers — where the cup is scaled .325 and moved —
   do not transfer. `K` is cup units per pot unit and is what makes the pot
   about 1.0x the cup: the pot draws 39.45 of its own units from knob to base,
   the cup 70 from rim to saucer. The mockup's 1.5x was posed for a hero; here
   the cup is 68px in a board corner. */
const K = 1.78;
/** Where the pot's collar — the point it tips about — sits in the cup's frame. */
const PX = 21;
const PY = 11;
/** Mockup units to cup units, for every number lifted out of the pour.
 *
 *  The pour's own numbers — the ribbon's two widths, a drop's radius, gravity —
 *  scale with the *cup*, not with the pot: the mockup's scene draws that cup at
 *  .325, so one of its units is 1/.325 of ours. Scaling them with the pot
 *  instead would thin the stream by the same fraction the pot was shrunk by,
 *  and a stream a pixel wide reads as a wire. */
const M = 1 / 0.325;
/** The mouth's low corner, in the pot's own units. The stream leaves here. */
const LIP_X = 13.2;
const LIP_Y = -14.5;
/** The poured pose. A tipped pot settles, so the spring goes a little past it. */
const TIPPED = 35;
/** The liquid's own geometry, repeated from the cup: surface y at full, and how
 *  far it falls to empty. The stream has to end on the coffee, so it has to
 *  know the same two numbers the stylesheet transforms by. */
const TOP = 44;
const RANGE = 54;
/** How long the level takes to climb, matching `#cafe.pouring .liquid`. */
const CLIMB_S = 4.5;

const RAD = Math.PI / 180;
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

type RGB = readonly [number, number, number];
const rgb = (f: (i: 0 | 1 | 2) => number): RGB => [f(0), f(1), f(2)];
const hex = (c: RGB): string =>
  '#' +
  [c[0], c[1], c[2]]
    .map((v) =>
      clamp(Math.round(v * 255), 0, 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('');

/* ── the finish ─────────────────────────────────────────────────────────────
   Three numbers per part. `f0` is what the surface reflects at normal
   incidence — for a metal that is the metal's own colour and there is no
   diffuse left over, for a dielectric it is about 5% grey and the colour lives
   in `alb`. `rough` is the only knob that separates polished from matte, and it
   works by widening the key lobe the surface reflects. */
interface Sub {
  f0: RGB;
  alb: RGB;
  rough: number;
}
/** `two`, steel over black: a bright pressed collector over a dark boiler. */
const WALL: Sub = { f0: [0.92, 0.94, 0.96], alb: [0, 0, 0], rough: 0.14 };
const LOW: Sub = { f0: [0.075, 0.078, 0.085], alb: [0.028, 0.03, 0.033], rough: 0.34 };
const LID: Sub = { f0: [0.95, 0.96, 0.98], alb: [0, 0, 0], rough: 0.13 };
const WOOD: Sub = { f0: [0.045, 0.045, 0.045], alb: [0.7, 0.46, 0.25], rough: 0.55 };
const WOOD_DARK: Sub = { f0: [0.045, 0.045, 0.045], alb: [0.28, 0.16, 0.07], rough: 0.55 };

/* ── the room ───────────────────────────────────────────────────────────────
   What the metal reflects, as a ring of radiance around it: a broad key lobe
   where the lamp is, a dim fill opposite, a room term brightest toward the
   viewer, and a floor term behind. The panel has two rooms and the host says
   which — a pot lit for a bright room is a white blob on a dark board. */
interface Room {
  key: RGB;
  fill: RGB;
  amb: RGB;
  back: RGB;
  keyI: RGB;
  floor: RGB;
  lidLift: RGB;
}
const LIGHT_ROOM: Room = {
  key: [1.58, 1.54, 1.45],
  fill: [0.3, 0.32, 0.35],
  amb: [0.185, 0.19, 0.2],
  back: [0.082, 0.088, 0.098],
  keyI: [1.06, 1.04, 0.99],
  floor: [0.7, 0.67, 0.62],
  lidLift: [0.105, 0.105, 0.11]
};
const DARK_ROOM: Room = {
  key: [1.62, 1.6, 1.55],
  fill: [0.052, 0.056, 0.066],
  amb: [0.034, 0.036, 0.042],
  back: [0.013, 0.014, 0.017],
  keyI: [1.24, 1.22, 1.17],
  floor: [0.1, 0.095, 0.088],
  lidLift: [0.085, 0.085, 0.09]
};

/** Where the lamp is. Fixed: the panel has no light to drag, and a pot whose
 *  highlight wanders on its own would be an animation nothing caused. */
const AZ = -38;
const EL = 30;

/* the octagon, as the drawing already struck it: creases at 39.7% and 90.1% of
   the half-width, so five bands are visible and their normals are the arcsine
   of each band's centre. */
const BANDS: readonly (readonly [number, number])[] = [
  [0, 0.0495],
  [0.0495, 0.3015],
  [0.3015, 0.6985],
  [0.6985, 0.9505],
  [0.9505, 1]
];
const PHI: readonly number[] = BANDS.map(([a, b]) =>
  Math.asin(clamp(((a + b) / 2 - 0.5) * 2, -1, 1))
);

const angd = (a: number): number => {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) {
    x += 2 * Math.PI;
  }
  return x - Math.PI;
};

/** The light, resolved into the pot's own frame. `tip` rotates the axis the
 *  facets are wrapped around, so the light's useful component is its projection
 *  into the plane the normals live in — which is exactly what makes the
 *  highlight slide when the pot leans and the lamp does not. */
interface Frame {
  m: number;
  th: number;
  se: number;
}
function lightFrame(tipDeg: number): Frame {
  const az = AZ * RAD;
  const el = EL * RAD;
  const t = tipDeg * RAD;
  const ce = Math.cos(el);
  const se = Math.sin(el);
  const lx = ce * Math.sin(az);
  const ly = -se;
  const lz = ce * Math.cos(az);
  const Lx = lx * Math.cos(t) + ly * Math.sin(t);
  return { m: Math.hypot(Lx, lz), th: Math.atan2(Lx, lz), se };
}

/** Tone-mapped on luminance, not per channel. Rolling each channel off on its
 *  own is what turns a warm metal into beige: red saturates first, the hue
 *  walks to grey exactly where the metal is brightest. */
const EXPO = 1.5;
function tone(c: RGB): RGB {
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  if (L <= 1e-6) {
    return [0, 0, 0];
  }
  const s = (1 - Math.exp(-EXPO * L)) / L;
  const o = rgb((i) => c[i] * s);
  const mx = Math.max(o[0], o[1], o[2]);
  if (mx <= 1) {
    return o;
  }
  const k = 1 / mx;
  return rgb((i) => o[i] * k + (1 - k) * (1 - o[i] * k) * 0.7);
}

/** One facet's colour. The reflection direction of a normal at azimuth phi is
 *  at 2*phi, so the ring is sampled there; roughness is the lobe's width. */
function shade(sub: Sub, room: Room, LF: Frame, phi: number, lift?: RGB): RGB {
  const sig = 0.55 + 1.55 * sub.rough;
  const psi = 2 * phi;
  const d = angd(psi - LF.th);
  const key = Math.exp(-(d * d) / (2 * sig * sig)) * LF.m;
  const d2 = angd(psi - LF.th - 2.6);
  const sf = sig * 1.9;
  const fil = Math.exp(-(d2 * d2) / (2 * sf * sf));
  const front = 0.5 + 0.5 * Math.cos(psi);
  const NdotV = Math.max(0, Math.cos(phi));
  const NdotL = Math.max(0, LF.m * Math.cos(phi - LF.th));
  const fs = Math.pow(1 - NdotV, 5);
  return tone(
    rgb((i) => {
      const e =
        room.key[i] * key +
        room.fill[i] * fil +
        room.amb[i] * front +
        room.back[i] * (1 - front) +
        (lift ? lift[i] : 0);
      const F = sub.f0[i] + (1 - sub.f0[i]) * fs;
      const diff = sub.alb[i] * (room.amb[i] * 1.2 + 0.62 * NdotL * room.keyI[i]);
      return diff + F * e;
    })
  );
}

/* ── the gradients ──────────────────────────────────────────────────────────
   Offsets depend on roughness only, so they are written into the markup once
   and nothing but `stop-color` moves after that. A bevel stop sits at every
   interior crease, shaded at a third of the part's roughness — an edge is the
   one place on a pressed pot that is still sharp. */
interface Stop {
  o: number;
  /** Which of the five facets, or which of the four creases between them. */
  face?: number;
  bevel?: number;
}
function bandStops(rough: number): Stop[] {
  const bev = clamp(0.008 + 0.13 * rough, 0.008, 0.16);
  const offs: Stop[] = [{ o: 0, face: 0 }];
  BANDS.slice(1).forEach(([b], j) => {
    offs.push({ o: clamp(b - bev, 0, 1), face: j });
    offs.push({ o: b, bevel: j });
    offs.push({ o: clamp(b + bev, 0, 1), face: j + 1 });
  });
  offs.push({ o: 1, face: 4 });
  let prev = 0;
  for (const s of offs) {
    if (s.o < prev) {
      s.o = prev;
    }
    prev = s.o;
  }
  return offs;
}

const WALL_STOPS = bandStops(WALL.rough);
const LOW_STOPS = bandStops(LOW.rough);
const LID_STOPS = bandStops(LID.rough);
/** The trough is 6 units long, too small for five bands: the same material is
 *  sampled along its own diagonal instead, and a touch sharper, because a
 *  pressed lip is the one part of the pot that never got a radius. */
const SPOUT_PHI = [-0.95, -0.32, 0.2, 0.78, 1.2];
const SPOUT_STOPS = [0, 0.28, 0.55, 0.82, 1];
const WOOD_PHI: readonly (readonly [number, Sub])[] = [
  [-0.6, WOOD],
  [0.15, WOOD],
  [1.0, WOOD_DARK]
];
const WOOD_STOPS = [0, 0.45, 1];

const stopsMarkup = (offs: readonly number[]): string =>
  offs.map((o) => `<stop offset="${o.toFixed(4)}"/>`).join('');

/**
 * The envelope both halves wear over their ramp: sky above, floor bounce below,
 * and how much of each is the lamp's height. It is the one gradient with no
 * angle in it — the lamp does not move and the pot's *elevation* in the room
 * does not change when it leans — so it is shaded once, here, and never again.
 */
function envMarkup(room: Room): string {
  const LF = lightFrame(0);
  const up = Math.max(0, LF.se);
  const dn = Math.max(0, -LF.se);
  const skyO = 0.035 + 0.18 * up;
  const botO = 0.05 + 0.15 * dn;
  const shO = 0.05 + 0.11 * (1 - up);
  const sky = hex(rgb((i) => Math.min(1, room.key[i] * 0.62 + room.amb[i])));
  const floor = hex(room.floor);
  const st = (o: number, c: string, a: number): string =>
    `<stop offset="${o}" stop-color="${c}" stop-opacity="${a.toFixed(3)}"/>`;
  return (
    st(0, sky, skyO) +
    st(0.28, sky, 0) +
    st(0.48, '#0d0a06', 0) +
    st(0.56, '#0d0a06', shO * 0.8) +
    st(0.8, '#0d0a06', shO) +
    st(0.93, floor, botO * 0.55) +
    st(1, floor, botO)
  );
}

/**
 * The eight ids the drawing paints with. Named `cafe*` like the cup's own, and
 * emitted into the same `defs` — one cup, one pot, so they are renamed once at
 * rest rather than uniquified per instance the way the mockup's script has to.
 */
export function potDefs(dark: boolean): string {
  const room = dark ? DARK_ROOM : LIGHT_ROOM;
  const band = (id: string, offs: Stop[]): string =>
    `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">${stopsMarkup(offs.map((s) => s.o))}</linearGradient>`;
  return `
    ${band('cafeMetal', WALL_STOPS)}
    ${band('cafeMetalLow', LOW_STOPS)}
    ${band('cafeMetalLid', LID_STOPS)}
    <linearGradient id="cafeMetalSpout" x1="0" y1="0" x2="1" y2="1">${stopsMarkup(SPOUT_STOPS)}</linearGradient>
    <linearGradient id="cafeMetalEnv" x1="0" y1="0" x2="0" y2="1">${envMarkup(room)}</linearGradient>
    <linearGradient id="cafeInk" x1="0" y1="0" x2="0" y2="1">${stopsMarkup([0, 1])}</linearGradient>
    <linearGradient id="cafeWood" x1="0" y1="0" x2="1" y2="1">${stopsMarkup(WOOD_STOPS)}</linearGradient>
    <linearGradient id="cafeSheen" x1="0" y1="0" x2="0" y2="1">${stopsMarkup([0, 1])}</linearGradient>`;
}

/**
 * The pot and its pour, drawn after the cup so the stream lands in front of the
 * rim rather than behind it. Every path is the mockup's, unchanged: the
 * hourglass profile, the inset collar, the trough spout cut from the wall, the
 * open-bottomed handle, the shallow lid cap. Only the frame around them is new
 * — `translate(PX,PY) scale(K)` puts the pot's collar where this cup wants it,
 * and the tip rotates about that same collar.
 */
export const POT_SVG = `
  <g class="kettle" transform="translate(${PX},${PY}) scale(${K})">
    <g class="tip">
      <path d="M-7.9-15.2-13.9-14.9Q-15.4-14.8-15.4-13.4V-5.6Q-15.4-3.9-13.6-3.4"
            fill="none" stroke="url(#cafeWood)" stroke-width="2.6"
            stroke-linejoin="round" stroke-linecap="round"/>
      <path d="M-8.4-14.5-13.8-14.2Q-14.7-14.1-14.7-13.2V-6.2" fill="none"
            stroke="url(#cafeSheen)" stroke-width=".5" stroke-linecap="round" opacity=".3"/>
      <path d="M-16.4-12.2-14.4-12.35M-16.4-8.4-14.4-8.55M-11.7-15.9-11.55-14"
            fill="none" stroke="#3f2412" stroke-width=".4" stroke-linecap="round" opacity=".3"/>

      <path d="M7.59-17.2 11.36-17.5 13.2-14.5 7-7.8Z" fill="url(#cafeMetalSpout)"/>
      <path d="M8.52-16.6 11.09-16.8 12.15-15.3 9.11-14.9Z" fill="url(#cafeInk)" opacity=".32"/>
      <path d="M13.07-14.6 7.66-8.6" fill="none" stroke="url(#cafeInk)" stroke-width=".6"
            stroke-linecap="round" opacity=".5"/>
      <path d="M8.06-17.1 11.69-17.4" fill="none" stroke="url(#cafeSheen)"
            stroke-width="1.1" stroke-linecap="round" opacity=".9"/>

      <path d="M-6.52 1.75-8.6 14a2 2 0 0 0 2 2H6.6a2 2 0 0 0 2-2L6.52 1.75Z"
            fill="url(#cafeMetalLow)"/>
      <path d="M-6.52 1.75-8.6 14a2 2 0 0 0 2 2H6.6a2 2 0 0 0 2-2L6.52 1.75Z"
            fill="url(#cafeMetalEnv)"/>
      <path d="M-6.4 15.2h13" fill="none" stroke="url(#cafeInk)" stroke-width=".9"
            stroke-linecap="round" opacity=".4"/>

      <path d="M-6.05-1.75H6.05V1.75H-6.05Z" fill="url(#cafeMetalLid)"/>

      <path d="M-6.55-1.75-8.4-17.5H8.4L6.55-1.75Z" fill="url(#cafeMetal)"/>
      <path d="M-6.55-1.75-8.4-17.5H8.4L6.55-1.75Z" fill="url(#cafeMetalEnv)"/>

      <path d="M-8.4-17.5h16.8" fill="none" stroke="url(#cafeInk)" stroke-width=".8" opacity=".5"/>
      <g class="lidlag" transform="rotate(0,0,-19)">
        <path d="M-9.4-17.6-6.4-20.65H6.4L9.4-17.6Z" fill="url(#cafeMetalLid)"/>
        <rect x="-1.6" y="-23.45" width="3.2" height="3.6" rx=".9" fill="url(#cafeWood)"/>
      </g>

      <path d="M11.55-17.2 13.01-14.8" fill="none" stroke="url(#cafeInk)" stroke-width=".75"
            stroke-linecap="round"/>
    </g>
  </g>
  <g class="stream">
    <g class="pour" opacity="0">
      <path class="ribbon" d="" fill="url(#cafeBrew)"/>
      <path class="streaks" d="" fill="none" stroke="#a9683a" stroke-width="${(0.85 * M).toFixed(2)}"
            stroke-linecap="round" stroke-dasharray="${(3 * M).toFixed(1)} ${(8 * M).toFixed(1)}"/>
    </g>
    <g class="drops" fill="url(#cafeBrew)">${'<circle r="0" cx="0" cy="-50"/>'.repeat(7)}</g>
  </g>`;

/** Where the stream lands, in the cup's frame, with the pot at this angle. */
export function lipAt(tipDeg: number): readonly [number, number] {
  const a = tipDeg * RAD;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [PX + K * (LIP_X * c - LIP_Y * s), PY + K * (LIP_X * s + LIP_Y * c)];
}

/* ── the pour ───────────────────────────────────────────────────────────────
   One cup on the board, so one pot, so this is module state rather than an
   instance. `arm` caches every node the frame writes to; nothing is queried
   inside the loop. */
interface Drop {
  el: SVGCircleElement;
  live: boolean;
  x: number;
  y: number;
  vy: number;
  r: number;
}
interface Rig {
  tip: SVGGElement;
  lidlag: SVGGElement;
  pour: SVGGElement;
  ribbon: SVGPathElement;
  streaks: SVGPathElement;
  drops: Drop[];
  room: Room;
  stops: Record<string, NodeListOf<SVGStopElement>>;
}
let rig: Rig | undefined;

let tip = 0;
let tipV = 0;
let tipTarget = 0;
/** 0..1, how established the stream is. It leads in slower than it breaks. */
let ribbon = 0;
let ribbonTarget = 0;
let pending: { t: number; r: number }[] = [];
let raf = 0;
let last = 0;
/** The level the pour started from and is climbing to, and how far in it is —
 *  the stream has to end on the coffee while the coffee is still rising. */
let from = 1;
let to = 1;
let climbed = 0;

/** Whether this reader asked for less motion. jsdom ships no `matchMedia` at
 *  all, so this is a feature test rather than a preference test. */
const reduced = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Cache the pot's nodes and light it once, standing up. */
export function armPot(svg: Element, dark: boolean): void {
  const q = <T extends Element>(sel: string): T | null => svg.querySelector<T>(sel);
  const tipG = q<SVGGElement>('.tip');
  const lidlag = q<SVGGElement>('.lidlag');
  const pour = q<SVGGElement>('.pour');
  const ribbonEl = q<SVGPathElement>('.ribbon');
  const streaks = q<SVGPathElement>('.streaks');
  if (!tipG || !lidlag || !pour || !ribbonEl || !streaks) {
    return;
  }
  const stops: Record<string, NodeListOf<SVGStopElement>> = {};
  for (const id of [
    'cafeMetal',
    'cafeMetalLow',
    'cafeMetalLid',
    'cafeMetalSpout',
    'cafeInk',
    'cafeWood',
    'cafeSheen'
  ]) {
    stops[id] = svg.querySelectorAll<SVGStopElement>(`#${id} stop`);
  }
  rig = {
    tip: tipG,
    lidlag,
    pour,
    ribbon: ribbonEl,
    streaks,
    drops: [...svg.querySelectorAll<SVGCircleElement>('.drops circle')].map((el) => ({
      el,
      live: false,
      x: 0,
      y: 0,
      vy: 0,
      r: 0.9 * M
    })),
    room: dark ? DARK_ROOM : LIGHT_ROOM,
    stops
  };
  tip = 0;
  tipV = 0;
  tipTarget = 0;
  ribbon = 0;
  ribbonTarget = 0;
  pending = [];
  paint(0);
}

/**
 * Lean in and pour, from the level the cup was at to the one it is going to.
 *
 * Under reduced motion this does nothing at all: the caller still marks the
 * pour, and the stylesheet declines to draw a pot. There is no JS branch on the
 * class for the same reason — the level still moves, and that is the report.
 */
export function pourFrom(was: number, now: number): void {
  if (!rig || reduced()) {
    return;
  }
  from = was;
  to = now;
  climbed = 0;
  tipTarget = TIPPED;
  ribbonTarget = 1;
  // Two lead drops, thrown before the ribbon establishes: first contact is
  // never a ribbon, and without them the stream switches on like a tap.
  pending.push({ t: 0.1, r: 0.82 * M }, { t: 0.2, r: 1.05 * M });
  run();
}

/** Stand back up. The ribbon breaks at the lip and the tail falls on its own. */
export function stopPour(): void {
  if (!rig) {
    return;
  }
  tipTarget = 0;
  ribbonTarget = 0;
  pending.push({ t: 0, r: 0.95 * M });
  run();
}

/** Forget the pot: the cup has been removed, so nothing must go on animating. */
export function disarmPot(): void {
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  rig = undefined;
  last = 0;
}

function run(): void {
  if (!raf && typeof requestAnimationFrame === 'function') {
    last = 0;
    raf = requestAnimationFrame(frame);
  }
}

function frame(t: number): void {
  const r = rig;
  if (!r) {
    raf = 0;
    return;
  }
  const dt = last ? Math.min(0.05, (t - last) / 1000) : 0.016;
  last = t;

  // The spring on the tip. Stiff enough to read as a snap, damped just under
  // critical so it settles with one visible overshoot.
  const k = 210;
  const c = 19;
  tipV += (k * (tipTarget - tip) - c * tipV) * dt;
  tip += tipV * dt;
  let moving = Math.abs(tipTarget - tip) > 0.01 || Math.abs(tipV) > 0.05;
  if (!moving && tip !== tipTarget) {
    tip = tipTarget;
    tipV = 0;
  }

  // The ribbon establishes after the lead drops and breaks faster than it came.
  const rate = ribbonTarget > ribbon ? 4.4 : 7.2;
  if (ribbon !== ribbonTarget) {
    ribbon += clamp(ribbonTarget - ribbon, -rate * dt, rate * dt);
    if (Math.abs(ribbonTarget - ribbon) < 0.003) {
      ribbon = ribbonTarget;
    }
    moving = true;
  }

  // A climb still under way is motion, even with the pot standing still. The
  // tip settles in about 0.9s and the ribbon in 0.23s, so without this the loop
  // stopped a fifth of the way through the 4.5s rise — freezing the stream at
  // the length it had over the *old* surface while the stylesheet went on
  // raising the coffee, and the last three seconds of every pour were a ribbon
  // plunging into the drink rather than landing on it.
  climbed = Math.min(CLIMB_S, climbed + dt);
  if (climbed < CLIMB_S) {
    moving = true;
  }
  const level = from + (to - from) * (climbed / CLIMB_S);
  const surface = TOP + (1 - level) * RANGE;

  const lip = lipAt(tip);
  for (const p of pending) {
    p.t -= dt;
  }
  while (pending.length && (pending[0]?.t ?? 1) <= 0) {
    pending.shift();
    const slot = r.drops.find((d) => !d.live);
    if (slot) {
      slot.live = true;
      slot.x = lip[0] + (Math.random() - 0.5) * 0.5 * M;
      slot.y = lip[1];
      slot.vy = (2 + Math.random() * 3) * M;
      slot.r = (0.82 + Math.random() * 0.35) * M;
    }
  }
  for (const d of r.drops) {
    if (!d.live) {
      continue;
    }
    moving = true;
    d.vy += 190 * M * dt;
    d.y += d.vy * dt;
    if (d.y >= surface) {
      d.live = false;
      d.el.setAttribute('r', '0');
      continue;
    }
    d.el.setAttribute('cx', d.x.toFixed(2));
    d.el.setAttribute('cy', d.y.toFixed(2));
    d.el.setAttribute('r', (d.r * (1 - (d.y - lip[1]) / (90 * M))).toFixed(2));
  }

  r.tip.setAttribute('transform', `rotate(${tip.toFixed(2)})`);
  // A lid is dropped into a rim, not screwed to it, so it lags the tip by a
  // degree or two off the angular velocity — the cheapest mark that says so.
  r.lidlag.setAttribute('transform', `rotate(${clamp(-tipV * 0.011, -3, 3).toFixed(2)},0,-19)`);

  const len = Math.max(0, surface - lip[1]) * ribbon;
  if (len > 0.5) {
    // `d` is rewritten rather than scaled, so the taper stays a taper: a falling
    // stream accelerates, and an accelerating stream narrows.
    const w0 = 0.88 * M;
    const w1 = 0.46 * M;
    const x = lip[0];
    const y = lip[1];
    r.pour.setAttribute('opacity', clamp(ribbon * 1.4, 0, 1).toFixed(2));
    r.ribbon.setAttribute(
      'd',
      `M${x - w0} ${y}` +
        `C${x - w0 * 0.8} ${y + len * 0.35} ${x - w1} ${y + len * 0.7} ${x - w1} ${y + len}` +
        `L${x + w1} ${y + len}` +
        `C${x + w1} ${y + len * 0.7} ${x + w0 * 0.8} ${y + len * 0.35} ${x + w0} ${y}Z`
    );
    r.streaks.setAttribute('d', `M${x} ${y + 1.5 * M}V${y + len - 1.5 * M}`);
  } else {
    r.pour.setAttribute('opacity', '0');
  }

  if (moving) {
    paint(tip);
    raf = requestAnimationFrame(frame);
  } else {
    // Nothing is moving and nothing is falling: the pot is standing up with its
    // stream broken, so the loop stops rather than idling at 60fps over a
    // board that has one.
    raf = 0;
    last = 0;
  }
}

/** Re-light the pot for the angle it is at. Only `stop-color` is written. */
function paint(tipDeg: number): void {
  const r = rig;
  if (!r) {
    return;
  }
  const room = r.room;
  const LF = lightFrame(tipDeg);

  const write = (id: string, colours: readonly string[]): void => {
    const stops = r.stops[id];
    if (!stops) {
      return;
    }
    colours.forEach((c, i) => stops[i]?.setAttribute('stop-color', c));
  };

  const band = (id: string, layout: Stop[], sub: Sub, lift?: RGB): RGB[] => {
    const faces = PHI.map((p) => shade(sub, room, LF, p ?? 0, lift));
    const sharp: Sub = { f0: sub.f0, alb: sub.alb, rough: sub.rough * 0.34 };
    const bevels = PHI.slice(0, 4).map((p, i) =>
      shade(sharp, room, LF, ((p ?? 0) + (PHI[i + 1] ?? 0)) / 2, lift)
    );
    write(
      id,
      layout.map((s) =>
        hex((s.face === undefined ? bevels[s.bevel ?? 0] : faces[s.face]) ?? [0, 0, 0])
      )
    );
    return faces.filter((f): f is RGB => f !== undefined);
  };

  const wall = band('cafeMetal', WALL_STOPS, WALL);
  band('cafeMetalLow', LOW_STOPS, LOW);
  // The collar and lid carry a small constant lift on top of the room. A
  // machined band is turned, not pressed: it catches light from everywhere at
  // once, and without the lift a dark pot in a dark room loses its waist — and
  // the waist is the whole silhouette.
  band('cafeMetalLid', LID_STOPS, LID, room.lidLift);

  const spout: Sub = { f0: WALL.f0, alb: WALL.alb, rough: WALL.rough * 0.75 };
  write(
    'cafeMetalSpout',
    SPOUT_PHI.map((p) => hex(shade(spout, room, LF, p)))
  );

  // The finish's own dark, for the three marks with no wall behind them. It is
  // floored: in a dark room the darkest facet is already near black, and a mark
  // darker than the wall it sits on stops being a mark.
  const sum = (c: RGB): number => c[0] + c[1] + c[2];
  const dk = wall.reduce((a, c) => (sum(a) < sum(c) ? a : c));
  const fl = (v: number, i: 0 | 1 | 2): number => Math.max(v * 0.52, WALL.f0[i] * 0.13 + 0.022);
  write('cafeInk', [hex(rgb((i) => fl(dk[i], i))), hex(rgb((i) => fl(dk[i], i) * 0.68))]);

  // The sheen is the brightest thing the room has to offer, so the edge catch
  // on the spout tracks the lamp instead of staying a painted-on white line.
  const br = wall.reduce((a, c) => (sum(a) > sum(c) ? a : c));
  const shn = hex(rgb((i) => Math.min(1, br[i] * 1.12 + 0.06)));
  write('cafeSheen', [shn, shn]);

  // Wood is a rough dielectric, so it only needs the diffuse half of the model.
  write(
    'cafeWood',
    WOOD_PHI.map(([p, sub]) => hex(shade(sub, room, LF, p)))
  );
}
