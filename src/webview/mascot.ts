/**
 * The chick: a 48px pixel mascot over the board, behind the
 * `squadron.mascot.enabled` experiment (`docs/PRD/PRD_shipped_mascot.md`).
 *
 * It sits on the bottom hub, flies to the card a board fact concerns, holds
 * a pose there, and is still between facts. Still means free: nothing here
 * runs a timer, a frame callback or an animation while it rests. The café was
 * dismounted for an animation that never stopped (`8103a2ea`), and that is the
 * one thing this must not repeat.
 *
 * What it reacts to and whether it may fly is `ui/mascot.ts`. This file paints
 * the frames into one canvas, moves the element by a WAAPI transform, and finds
 * its perches: the bar's top edge, the open sheet's top edge, and a card's.
 */

import * as rules from '../ui/mascot';
import { FRAMES, SIZE, TONES } from '../ui/mascot_frames';
import type { FrameName } from '../ui/mascot_frames';
import { reveal } from './board_actions';
import { select } from './dock';
import { visible, watchVisibility } from './visibility';

/** The sprite row its feet rest on: a perch puts that row on the edge. */
const FEET = 44;
/** A hop shorter than this along the same surface is walked, not flown. */
const WALK_MAX = 160;
const WALK_PX_S = 110;
const WALK_FRAME_MS = 110;
const FLAP_FRAME_MS = 90;
/** Where it sits along each surface, from the mockup. */
const HOME_INSET = 14;
const SHEET_INSET = 56;
const CARD_AT = 0.62;

const ORDER = Object.keys(FRAMES) as FrameName[];
/** Decoded once: the spans every paint of the strip draws. */
const SPANS = ORDER.map((name) => rules.runs(FRAMES[name]));
const STAND: readonly rules.PoseStep[] = [{ frame: 'stand' }];
const CHIRP_MS = 1400;

type Perch = 'bar' | 'sheet' | 'card';

/** A place to sit, in `#board`'s coordinates. */
interface Spot {
  x: number;
  y: number;
  perch: Perch;
  pid?: number;
}

let chick: Chick | undefined;

/** Mount, feed or remove the chick for this push. Off removes everything it
 *  made and everything it listened to. */
export function syncMascot(state: StateMessage): void {
  if (!state.mascot) {
    chick?.dispose();
    chick = undefined;
    return;
  }
  const board = document.getElementById('board');
  if (!board) return;
  chick ??= new Chick(board);
  chick.push(state);
}

class Chick {
  private readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private strip: HTMLCanvasElement | undefined;
  private signature = '';
  private readonly director = new rules.Director(() => performance.now());

  private x = 0;
  private y = 0;
  private perch: Perch = 'bar';
  private pid: number | undefined;
  /** The pose it rests in once a reaction is over. */
  private rest: FrameName = 'stand';
  /** The fact it last reacted to, which a click opens. */
  private attended: rules.Fact | undefined;
  /** A fact it left because its card scrolled away; offered again when the
   *  card comes back (PRD D7). */
  private evicted: rules.Fact | undefined;
  private last: rules.Board | undefined;
  private sheetOpen = false;

  /** Bumped by every move, so a superseded one stops at its next await. */
  private gen = 0;
  private anim: Animation | undefined;
  private target: { spot: Spot; steps: readonly rules.PoseStep[] } | undefined;
  private frameTimer: ReturnType<typeof setInterval> | undefined;
  private poseTimer: ReturnType<typeof setTimeout> | undefined;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly waits = new Set<ReturnType<typeof setTimeout>>();
  /** The frames a scroll and a theme change wait for; cancelled on dispose. */
  private scrollFrame = 0;
  private themeFrame = 0;
  /** What the theme observer last saw, so an attribute rewritten to the same
   *  value (a preset re-applied on every push) costs no colour reads. */
  private themeKey = '';
  private disposed = false;

  private readonly cards: HTMLElement | null;
  private readonly sheet: HTMLElement | null;
  private readonly resize: ResizeObserver | undefined;
  private readonly observers: MutationObserver[] = [];
  private readonly reduced: MediaQueryList | undefined;
  private readonly stopWatching: () => void;
  private barWatched = false;

  constructor(private readonly board: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'mascot';
    // A shortcut to what the card already offers, so no tab stop and no name:
    // nothing user-facing names the chick (PRD Q2).
    this.el.setAttribute('aria-hidden', 'true');
    this.canvas = document.createElement('canvas');
    const tones = document.createElement('div');
    tones.className = 'tones';
    for (const tone of TONES) {
      const probe = document.createElement('span');
      probe.className = `t-${tone.toLowerCase()}`;
      tones.append(probe);
    }
    this.el.append(this.canvas, tones);
    board.append(this.el);
    this.ctx = this.canvas.getContext('2d');
    this.el.addEventListener('click', () => this.clicked());

    this.cards = document.getElementById('cards');
    this.cards?.addEventListener('scroll', this.onScroll, { passive: true });
    if (this.cards) {
      let hidden = this.cards.hidden;
      const watch = new MutationObserver(() => {
        if (hidden === this.cards?.hidden) return;
        hidden = !!this.cards?.hidden;
        this.visibilityMoved();
      });
      watch.observe(this.cards, { attributes: true, attributeFilter: ['hidden'] });
      this.observers.push(watch);
    }
    this.sheet = document.getElementById('bottomdrawer');
    this.sheetOpen = !!this.sheet && !this.sheet.hidden;
    if (this.sheet) {
      const watch = new MutationObserver(() => this.sheetMoved());
      watch.observe(this.sheet, { attributes: true, attributeFilter: ['hidden'] });
      this.observers.push(watch);
    }
    const theme = new MutationObserver(() => this.themeMoved());
    theme.observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    this.observers.push(theme);
    if (typeof ResizeObserver === 'function') {
      this.resize = new ResizeObserver(() => {
        this.paint();
        this.reflow();
      });
      this.resize.observe(board);
      if (this.sheet) this.resize.observe(this.sheet);
    }
    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.reduced?.addEventListener('change', this.onReduced);
    this.stopWatching = watchVisibility(() => this.visibilityMoved());

    this.themeKey = themeKey();
    this.paint();
    this.goTo(this.sheetOpen ? this.sheetSpot() : this.home(), STAND, false);
  }

  /** One state push: read its facts, keep the perch honest, hand the facts
   *  to the director. */
  push(state: StateMessage): void {
    const board: rules.Board = {
      groups: state.groups,
      ...(state.awake ? { awake: state.awake } : {})
    };
    const found = rules.facts(this.last, board);
    this.last = board;
    this.watchBar();
    if (!visible() || this.cards?.hidden) return;
    this.settleHeld();
    this.followCard();
    const due = this.director.offer(found);
    if (due !== undefined) {
      clearTimeout(this.batchTimer);
      this.batchTimer = setTimeout(() => this.decide(), Math.max(0, due - performance.now()));
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.scrollFrame);
    cancelAnimationFrame(this.themeFrame);
    this.gen++;
    this.anim?.cancel();
    this.anim = undefined;
    clearInterval(this.frameTimer);
    clearTimeout(this.poseTimer);
    clearTimeout(this.batchTimer);
    for (const wait of this.waits) clearTimeout(wait);
    this.waits.clear();
    this.director.reset();
    this.resize?.disconnect();
    for (const observer of this.observers) observer.disconnect();
    this.cards?.removeEventListener('scroll', this.onScroll);
    this.reduced?.removeEventListener('change', this.onReduced);
    this.stopWatching();
    this.el.remove();
  }

  // ── Deciding ────────────────────────────────────────────────────────────

  private decide(): void {
    this.batchTimer = undefined;
    if (!visible() || this.cards?.hidden) return;
    const act = this.director.decide(
      (fact) => this.still(fact),
      (fact) => this.canFly(fact)
    );
    if (!act) return;
    const { fact, fly } = act;
    const steps = rules.POSE[fact.kind];
    if (fact.kind === 'idle') {
      this.attended = undefined;
      if (fly) this.goTo(this.home(), steps);
      else this.react(steps);
      return;
    }
    if (fact.pid !== undefined) {
      this.attended = fact;
      this.evicted = undefined;
      const spot = fly ? this.cardSpot(fact.pid) : undefined;
      if (spot) {
        this.goTo(spot, steps);
        return;
      }
    }
    this.react(steps);
  }

  /** A reaction where it is. Mid-move, it replaces what the landing shows,
   *  so an older move never lands over a newer fact. */
  private react(steps: readonly rules.PoseStep[]): void {
    if (this.target) this.target.steps = steps;
    else this.play(steps);
  }

  /** Whether a fact is still true of the board as last pushed. */
  private still(fact: rules.Fact): boolean {
    const board = this.last;
    if (!board) return false;
    const card = fact.pid === undefined ? undefined : this.card(fact.pid);
    switch (fact.kind) {
      case 'waiting':
        return card?.status === 'waiting';
      case 'done':
        return !!card?.unread;
      case 'start':
        return !!card;
      case 'idle':
        return rules.cardsOf(board).every(rules.quiet);
      case 'sleep':
        return board.awake?.reason !== 'drinking';
    }
  }

  /** Whether the target is somewhere a flight should go: not behind the open
   *  sheet, not where it already sits, and on screen. */
  private canFly(fact: rules.Fact): boolean {
    if (this.sheetOpen) return false;
    if (fact.kind === 'idle') return this.perch !== 'bar';
    if (fact.pid === undefined) return false;
    if (this.perch === 'card' && this.pid === fact.pid) return false;
    return this.inView(fact.pid);
  }

  private card(pid: number): CardView | undefined {
    return this.last ? rules.cardsOf(this.last).find((c) => c.pid === pid) : undefined;
  }

  /** An alert held for a dialog stands once the dialog is answered, and a
   *  flight to one answered on the way lands standing. */
  private settleHeld(): void {
    const fact = this.attended;
    if (fact?.kind !== 'waiting' || this.still(fact)) return;
    if (this.target) {
      if (this.target.steps === rules.POSE.waiting) this.target.steps = STAND;
      return;
    }
    if (this.rest !== 'alert') return;
    this.rest = 'stand';
    this.show('stand');
  }

  /** A card it sits on that left the push sends it home; one that moved is
   *  followed without animating. */
  private followCard(): void {
    if (this.perch !== 'card' || this.pid === undefined || this.target) return;
    if (!this.card(this.pid)) {
      this.attended = undefined;
      this.goTo(this.home(), STAND);
      return;
    }
    this.reflow();
  }

  // ── Perches ─────────────────────────────────────────────────────────────

  /** The bar's top edge near its left end. The bar has a static
   *  `translateX(-50%)`, so its box is read as drawn. */
  private home(): Spot {
    const bar = document.getElementById('bottomhub');
    if (!bar) return { x: HOME_INSET, y: this.board.clientHeight - SIZE - 6, perch: 'bar' };
    const b = this.board.getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    return { x: r.left - b.left + HOME_INSET, y: r.top - b.top - FEET + 1, perch: 'bar' };
  }

  /** The open sheet's top edge, left of its pull handle. `offsetTop` is where
   *  the sheet stops: its rise is a `translate`, which offsets do not see, so
   *  a flight that starts with the rise lands where the sheet will be. */
  private sheetSpot(): Spot {
    const sheet = this.sheet;
    if (!sheet) return this.home();
    return { x: sheet.offsetLeft + SHEET_INSET, y: sheet.offsetTop - FEET + 1, perch: 'sheet' };
  }

  /** A card's top edge, from layout rather than its drawn box: straight after
   *  a push the board's FLIP (`kit.ts`, `slide`) has an inverse transform on a
   *  card that moved, so its rect still reads the old place. */
  private cardSpot(pid: number): Spot | undefined {
    const node = this.cardNode(pid);
    if (!node) return undefined;
    const at = this.offsetIn(node);
    return {
      x: at.x + node.offsetWidth * CARD_AT - SIZE / 2,
      y: at.y - FEET + 1,
      perch: 'card',
      pid
    };
  }

  /** Whether a card's top edge is inside the scroller's visible box. */
  private inView(pid: number): boolean {
    const node = this.cardNode(pid);
    if (!node || !this.cards || this.cards.hidden) return false;
    const top = this.offsetIn(node).y;
    const box = this.offsetIn(this.cards);
    return top >= box.y && top <= box.y + this.cards.clientHeight;
  }

  private cardNode(pid: number): HTMLElement | null {
    return this.cards?.querySelector<HTMLElement>(`.card[data-pid="${pid}"]`) ?? null;
  }

  /** An element's layout position in `#board`, scroll subtracted. */
  private offsetIn(node: HTMLElement): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (let n: Element | null = node; n && n !== this.board;) {
      const el = n as HTMLElement;
      x += el.offsetLeft;
      y += el.offsetTop;
      n = el.offsetParent;
    }
    for (let p = node.parentElement; p && p !== this.board; p = p.parentElement) {
      x -= p.scrollLeft;
      y -= p.scrollTop;
    }
    return { x, y };
  }

  /** Put it back on its perch after the board, the bar or the sheet changed
   *  size, without animating. A card no longer in view sends it home. A move
   *  in progress is left alone: its landing calls this again. */
  private reflow(): void {
    if (this.target) return;
    if (this.perch === 'card') {
      const spot = this.pid === undefined ? undefined : this.cardSpot(this.pid);
      if (!spot || this.pid === undefined || !this.inView(this.pid)) {
        this.evict();
        return;
      }
      this.moveTo(spot);
      return;
    }
    this.moveTo(this.perch === 'sheet' ? this.sheetSpot() : this.home());
  }

  /** Its card scrolled out of view: go home, keeping the fact for when the
   *  card returns. */
  private evict(): void {
    this.evicted = this.attended;
    this.attended = undefined;
    this.goTo(this.home(), STAND);
  }

  private watchBar(): void {
    if (this.barWatched || !this.resize) return;
    const bar = document.getElementById('bottomhub');
    if (!bar) return;
    this.resize.observe(bar);
    this.barWatched = true;
  }

  // ── Events ──────────────────────────────────────────────────────────────

  /** `render` reassigns `hidden` on every push, open or not, and each
   *  assignment is a mutation record, so only a real change counts. */
  private sheetMoved(): void {
    const open = !!this.sheet && !this.sheet.hidden;
    if (open === this.sheetOpen) return;
    this.sheetOpen = open;
    if (open) {
      this.goTo(this.sheetSpot(), STAND);
      return;
    }
    // Back to what it attended, if that is still true and the director
    // agrees; home otherwise.
    const fact = this.attended;
    if (fact && visible()) {
      this.director.offer([fact]);
      const act = this.director.decide(
        (f) => this.still(f),
        (f) => this.canFly(f)
      );
      const spot = act?.fly && act.fact.pid !== undefined ? this.cardSpot(act.fact.pid) : undefined;
      if (act && spot) {
        this.attended = act.fact;
        this.goTo(spot, rules.POSE[act.fact.kind]);
        return;
      }
    }
    this.goTo(this.home(), STAND);
  }

  private readonly onScroll = (): void => {
    if (this.perch !== 'card' && !this.evicted) return;
    if (this.scrollFrame) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      if (!this.disposed) this.scrolled();
    });
  };

  private scrolled(): void {
    if (this.perch === 'card') {
      this.reflow();
      return;
    }
    const fact = this.evicted;
    if (fact?.pid === undefined || !this.inView(fact.pid) || !this.still(fact)) return;
    this.evicted = undefined;
    const due = this.director.offer([fact]);
    if (due !== undefined) {
      clearTimeout(this.batchTimer);
      this.batchTimer = setTimeout(() => this.decide(), Math.max(0, due - performance.now()));
    }
  }

  private visibilityMoved(): void {
    if (visible() && !this.cards?.hidden) {
      // ResizeObserver can miss layout that disappears and returns between deliveries.
      this.reflow();
      return;
    }
    clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
    this.director.reset();
    this.attended = undefined;
    this.evicted = undefined;
    this.goTo(this.sheetOpen ? this.sheetSpot() : this.home(), STAND);
  }

  /** Reduced motion switched on mid-move, the takeoff crouch included:
   *  land at the target now. */
  private readonly onReduced = (): void => {
    if (!this.reduced?.matches || !this.target) return;
    const { spot, steps } = this.target;
    this.goTo(spot, steps);
  };

  private themeMoved(): void {
    const key = themeKey();
    if (key === this.themeKey || this.themeFrame) return;
    this.themeKey = key;
    this.themeFrame = requestAnimationFrame(() => {
      this.themeFrame = 0;
      if (!this.disposed) this.paint();
    });
  }

  /** Open what it attends, then chirp. On a waiting card that is the dialog
   *  (`reveal`), on any other card the session; at home it only chirps. */
  private clicked(): void {
    if (this.target) return;
    const pid =
      this.perch === 'card' ? this.pid : this.perch === 'sheet' ? this.attended?.pid : undefined;
    const card = pid === undefined ? undefined : this.card(pid);
    if (card) {
      if (card.status === 'waiting') reveal(card.pid);
      else select(card.pid);
    }
    this.play([{ frame: 'happy', ms: CHIRP_MS }, { frame: this.rest }]);
  }

  // ── Moving ──────────────────────────────────────────────────────────────

  /**
   * Go somewhere and then show `steps`. Walks a short way along the same
   * surface and flies everywhere else. With no animation to run — a hidden
   * panel, reduced motion, or no `Element.animate` — it is placed there at
   * once: hidden shows only the resting pose, the other two the reaction too.
   * `travel` false places it there whatever the motion setting: the mount.
   */
  private goTo(spot: Spot, steps: readonly rules.PoseStep[], travel = true): void {
    const from = this.perch === 'card' ? `card:${this.pid}` : this.perch;
    const to = spot.perch === 'card' ? `card:${spot.pid}` : spot.perch;
    this.halt();
    const gen = this.gen;
    const x = Math.max(0, Math.min(spot.x, this.board.clientWidth - SIZE));
    const y = spot.y;
    this.perch = spot.perch;
    this.pid = spot.pid;
    this.mark();
    if (!travel || !this.animates()) {
      this.x = x;
      this.y = y;
      this.place();
      this.play(steps, visible());
      return;
    }
    this.target = { spot: { ...spot, x }, steps };
    const dx = x - this.x;
    const walk = from === to && Math.abs(y - this.y) < 4 && Math.abs(dx) <= WALK_MAX;
    const move = walk ? this.walk(x) : this.fly(x, y);
    void move.then((ok) => {
      if (!ok || gen !== this.gen || !this.target) return;
      // What changed on the way: a reaction decided mid-move, a sheet that
      // changed height, a card that moved or left, a dialog answered.
      const landing = this.target.steps;
      this.target = undefined;
      this.reflow();
      if (gen !== this.gen) return;
      this.play(landing);
      this.settleHeld();
    });
  }

  private async walk(x: number): Promise<boolean> {
    const dx = x - this.x;
    if (Math.abs(dx) < 3) return true;
    this.face(dx);
    const ok = await this.travel(
      x,
      this.y,
      [],
      (Math.abs(dx) / WALK_PX_S) * 1000,
      ['walk1', 'walk2'],
      WALK_FRAME_MS
    );
    if (ok) this.show('stand');
    return ok;
  }

  /** Crouch, flap across in an arc, crouch, land. */
  private async fly(x: number, y: number): Promise<boolean> {
    const dx = x - this.x;
    const dy = y - this.y;
    this.face(dx);
    this.show('crouch');
    if (!(await this.after(110))) return false;
    const peak = Math.min(this.y, y) - 28 - Math.min(50, Math.abs(dx) * 0.1);
    const ms = Math.min(1500, 480 + Math.hypot(dx, dy) * 0.9);
    const mid = {
      transform: `translate(${this.x + dx / 2}px, ${peak}px)`,
      easing: 'cubic-bezier(.5, 0, .6, .5)'
    };
    if (!(await this.travel(x, y, [mid], ms, ['fly1', 'fly2'], FLAP_FRAME_MS))) return false;
    this.show('crouch');
    if (!(await this.after(100))) return false;
    this.show('stand');
    return true;
  }

  /**
   * Slide to (x, y) while two frames alternate. The element's own transform is
   * set to the destination first, so the instant the animation ends it is
   * already there: nothing reads the old place for a frame in between.
   */
  private async travel(
    x: number,
    y: number,
    via: Keyframe[],
    ms: number,
    pair: readonly [FrameName, FrameName],
    every: number
  ): Promise<boolean> {
    const gen = this.gen;
    const start = `translate(${this.x}px, ${this.y}px)`;
    this.x = x;
    this.y = y;
    this.place();
    let i = 0;
    this.show(pair[0]);
    this.frameTimer = setInterval(() => this.show(++i % 2 ? pair[1] : pair[0]), every);
    const first: Keyframe = { transform: start, easing: 'cubic-bezier(.3, .6, .5, 1)' };
    this.anim = this.el.animate([first, ...via, { transform: this.el.style.transform }], {
      duration: ms
    });
    let ok = true;
    try {
      await this.anim.finished;
    } catch {
      ok = false;
    }
    clearInterval(this.frameTimer);
    this.frameTimer = undefined;
    if (!ok || gen !== this.gen) return false;
    this.anim = undefined;
    return true;
  }

  /** Stop whatever runs, keeping the chick where it visibly is. */
  private halt(): void {
    this.gen++;
    clearInterval(this.frameTimer);
    this.frameTimer = undefined;
    clearTimeout(this.poseTimer);
    for (const wait of this.waits) clearTimeout(wait);
    this.waits.clear();
    this.target = undefined;
    if (!this.anim) return;
    const drawn = getComputedStyle(this.el).transform;
    if (typeof DOMMatrix === 'function' && drawn && drawn !== 'none') {
      const m = new DOMMatrix(drawn);
      this.x = m.m41;
      this.y = m.m42;
    }
    this.anim.cancel();
    this.anim = undefined;
    this.place();
  }

  /** A pause inside a move; false once the move was superseded. */
  private after(ms: number): Promise<boolean> {
    const gen = this.gen;
    return new Promise((resolve) => {
      const wait = setTimeout(() => {
        this.waits.delete(wait);
        resolve(gen === this.gen);
      }, ms);
      this.waits.add(wait);
    });
  }

  /** Placed without travel; the pose it holds stays. */
  private moveTo(spot: Spot): void {
    const x = Math.max(0, Math.min(spot.x, this.board.clientWidth - SIZE));
    if (x === this.x && spot.y === this.y) return;
    this.x = x;
    this.y = spot.y;
    this.place();
  }

  private animates(): boolean {
    return visible() && !this.reduced?.matches && typeof this.el.animate === 'function';
  }

  private place(): void {
    this.el.style.transform = `translate(${this.x}px, ${this.y}px)`;
  }

  private face(dx: number): void {
    if (Math.abs(dx) > 2) this.el.classList.toggle('left', dx < 0);
  }

  private mark(): void {
    this.el.dataset.perch = this.perch;
    if (this.pid === undefined) delete this.el.dataset.pid;
    else this.el.dataset.pid = String(this.pid);
  }

  // ── Posing and painting ─────────────────────────────────────────────────

  /** Show a reaction then rest. `react` false skips straight to the rest.
   *  With no motion the crouch lead-in goes, so a reaction is one swap. */
  private play(all: readonly rules.PoseStep[], react = true): void {
    clearTimeout(this.poseTimer);
    const steps = this.animates() ? all : all.filter((step) => step.frame !== 'crouch');
    const last = steps.at(-1);
    if (!last) return;
    this.rest = last.frame;
    const run = (i: number): void => {
      const step = steps[i];
      if (!step) return;
      this.show(step.frame);
      if (step.ms !== undefined && i + 1 < steps.length) {
        this.poseTimer = setTimeout(() => run(i + 1), step.ms);
      }
    };
    run(react ? 0 : steps.length - 1);
  }

  private show(frame: FrameName): void {
    if (this.el.dataset.pose === frame) return;
    this.el.dataset.pose = frame;
    this.draw(frame);
  }

  /** One frame: a clear and one copy out of the strip. */
  private draw(frame: FrameName): void {
    const strip = this.strip;
    if (!this.ctx || !strip) return;
    const s = this.canvas.width;
    this.ctx.clearRect(0, 0, s, s);
    this.ctx.drawImage(strip, ORDER.indexOf(frame) * s, 0, s, s, 0, 0, s, s);
  }

  /**
   * Paint every frame into the offscreen strip, in the tones the theme gives
   * the probes. Only when those tones or the pixel ratio changed: a theme
   * observer calls this for every body class flip, and most change nothing.
   */
  private paint(): void {
    const dpr = window.devicePixelRatio || 1;
    const probes = this.el.querySelectorAll('.tones span');
    const tones = [...probes].map((probe) => getComputedStyle(probe).color);
    const signature = `${dpr}|${tones.join('|')}`;
    if (signature === this.signature) return;
    this.signature = signature;
    if (!this.ctx) return;
    const s = Math.round(SIZE * dpr);
    const strip = document.createElement('canvas');
    strip.width = s * ORDER.length;
    strip.height = s;
    const ink = strip.getContext('2d');
    if (!ink) return;
    ink.setTransform(s / SIZE, 0, 0, s / SIZE, 0, 0);
    SPANS.forEach((spans, i) => {
      for (const span of spans) {
        ink.fillStyle = tones[TONES.indexOf(span.tone)] ?? 'transparent';
        ink.globalAlpha = span.tone === 'H' ? 0.25 : 1;
        ink.fillRect(i * SIZE + span.x, span.y, span.w, 1);
      }
    });
    this.strip = strip;
    this.canvas.width = s;
    this.canvas.height = s;
    const pose = this.el.dataset.pose as FrameName | undefined;
    if (pose) this.draw(pose);
  }
}

/** The attributes a theme rides on: the preset, the host's theme class, and
 *  the host's variables on the root. */
function themeKey(): string {
  return [
    document.body.dataset.theme ?? '',
    document.body.className,
    document.documentElement.getAttribute('style') ?? ''
  ].join('|');
}
