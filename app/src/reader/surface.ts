import { fitColumn } from './verify';

/** How far ahead of the motion columns must exist, seconds: the compositor draws the move
 *  between the page's frames, which a throttled page gets 33 ms apart, so the page builds
 *  what the next of its frames will show, and some. */
const LEAD_S = 0.1;

/** How long the sheet rests before the next turn's columns are built: past the end of
 *  whatever else was moving (the map's zoom back to the page). */
const SETTLE_MS = 250;

/** Runs `f` when the page has a moment: in idle time where the browser says when that is,
 *  else just after a frame is drawn (Safari), the most time before the next. Returns how
 *  to call it off. */
function whenIdle(f: () => void): () => void {
  if (window.requestIdleCallback) { const h = window.requestIdleCallback(f, { timeout: 400 }); return () => window.cancelIdleCallback(h); }
  let t = 0;
  const raf = requestAnimationFrame(() => (t = window.setTimeout(f, 0)));
  return () => { cancelAnimationFrame(raf); clearTimeout(t); };
}
import type { Metrics } from './geometry';
import type { Strip } from './strip';

export interface RenderSource {
  strip: Strip;
  M: Metrics;
  column(k: number): string;
  isLeaf(k: number): boolean;
}

/** The track and the few columns that exist at any moment. Motion lives in motion.ts;
 *  this only places the track and keeps the right columns in the DOM. */
export class Surface {
  private cols = new Map<number, HTMLElement>();
  private base = 0;
  private dpr = Math.min(3, window.devicePixelRatio || 1);

  /** While the reader is hidden (under the map), what comes into view is built one column
   *  per frame, nearest the focus first, instead of all in one frame. */
  private lazy = false;
  private lazyRaf = 0;
  private lastPos = 0;
  /** A move the compositor is drawing (`glide`). */
  private anim: Animation | null = null;
  /** Columns being built at rest (`prebuild`): the wait, then each in idle time. */
  private settle = 0;
  private unidle = () => {};

  constructor(public track: HTMLElement, private src: () => RenderSource) {}

  setLazy(on: boolean) {
    if (on === this.lazy) return;
    this.lazy = on;
    this.quiet();
    if (!on) { cancelAnimationFrame(this.lazyRaf); this.lazyRaf = 0; if (this.src().strip) this.ensureVisible(this.lastPos); }
  }

  private x(pos: number) {
    const { M } = this.src();
    return M.x0 - (pos - this.base) * M.P;
  }

  /** The track's transform at `pos`; at a whole column the text lands on device pixels. */
  private at(pos: number) {
    let x = this.x(pos);
    if (Math.abs(pos - Math.round(pos)) < 1e-4) x = Math.round(x * this.dpr) / this.dpr;
    return `translate3d(${x.toFixed(3)}px,0,0)`;
  }

  /** Puts the track at `pos`. `v` is the speed in columns per second: columns ahead of the
   *  motion are built early, one per frame, so none is built in the frame it comes into
   *  view. `glided`: the compositor has the track there already (`glide`). */
  place(pos: number, v = 0, glided = false, to = NaN) {
    this.lastPos = pos;
    if (!glided || !this.anim) {
      this.stop();
      this.track.style.transform = this.at(pos);
    }
    this.ensureVisible(pos, v, to);
  }

  /** Hands a move to the compositor: `at(t)`, the position `t` seconds after `t0` (a frame's
   *  time on the document's timeline), as keyframes at `times` (from 0 to the move's end),
   *  straight lines between. It runs at the screen's rate, not the page's (which Safari
   *  halves in Low Power Mode); the track rests where it ends. */
  glide(at: (t: number) => number, times: number[], t0: number) {
    this.stop();
    const T = times[times.length - 1];
    const frames = times.map(t => ({ offset: t / T, transform: this.at(at(t)) }));
    this.track.style.transform = frames[frames.length - 1].transform;
    const a = this.anim = this.track.animate(frames, { duration: T * 1000, easing: 'linear' });
    a.startTime = t0;
    a.onfinish = () => { if (this.anim === a) this.anim = null; };
  }

  private stop() {
    if (!this.anim) return;
    this.anim.cancel();
    this.anim = null;
  }

  /** The columns that can be seen with the sheet between `a` and `b`. */
  private seen(a: number, b = a): [number, number] {
    const { M, strip } = this.src();
    return [Math.max(0, Math.floor(Math.min(a, b) - (M.x0 + M.G) / M.P)), Math.min(strip.N - 1, Math.ceil(Math.max(a, b) + (M.W - M.x0) / M.P))];
  }

  /** Columns that can be seen at `pos` must exist now, and those the motion reaches before
   *  the next frame. A move whose end is known (`to`) builds, one a frame, only what it
   *  will show (at rest they were built already: `prebuild`); one whose end is not (a held
   *  key, a hand) builds ahead of itself by its speed. */
  private ensureVisible(pos: number, v = 0, to = NaN) {
    const { strip } = this.src();
    const [lo, hi] = this.seen(pos, pos + v * LEAD_S);
    this.quiet();
    const ahead = Math.round(Math.min(10, Math.max(2, Math.abs(v) * 0.6)));
    // what is kept: around what is seen, further the way it moves, and all the move's end
    // will show (a wheel spin's, up to 16 columns on, is built toward, never thrown away)
    const [tLo, tHi] = Number.isFinite(to) ? this.seen(to) : [lo, hi];
    const aLo = Math.min(tLo, v < -0.05 ? Math.max(0, lo - ahead) : Math.max(0, lo - 2));
    const aHi = Math.max(tHi, v > 0.05 ? Math.min(strip.N - 1, hi + ahead) : Math.min(strip.N - 1, hi + 2));
    for (const [k, el] of this.cols) if (k < aLo - 2 || k > aHi + 2) { el.remove(); this.cols.delete(k); }
    if (this.lazy) {
      // the focus first, then outwards; one column, then the next frame
      const f = Math.round(pos);
      const order = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).sort((a, b) => Math.abs(a - f) - Math.abs(b - f));
      const k = order.find(c => !this.cols.has(c));
      if (k != null) {
        this.make(k);
        if (!this.lazyRaf) this.lazyRaf = requestAnimationFrame(() => { this.lazyRaf = 0; if (this.lazy) this.ensureVisible(this.lastPos); });
      }
      return;
    }
    for (let k = lo; k <= hi; k++) if (!this.cols.has(k)) this.make(k);
    if (!v && Math.abs(pos - Math.round(pos)) < 1e-4) { this.prebuild(lo, hi); return; }
    if (Number.isFinite(to)) {
      const d = to > pos ? 1 : -1;
      for (let k = d > 0 ? hi + 1 : lo - 1; k >= tLo && k <= tHi; k += d) if (!this.cols.has(k)) { this.make(k); return; }
      return;
    }
    // one column ahead per frame, nearest first
    for (let d = 0; d < ahead + 2; d++) {
      const k = v >= 0 ? hi + 1 + d : lo - 1 - d;
      if (k >= aLo && k <= aHi && !this.cols.has(k)) { this.make(k); return; }
    }
    for (const k of [lo - 1, hi + 1, lo - 2, hi + 2]) if (k >= aLo && k <= aHi && !this.cols.has(k)) { this.make(k); return; }
  }

  /** At rest, once settled, the columns the next turn either way will show are built in
   *  idle time, one at a time, nearest first, so a turn builds nothing while it moves
   *  (those within what is kept: four either side of what can be seen). */
  private prebuild(lo: number, hi: number) {
    const { M, strip } = this.src();
    const want: number[] = [];
    for (let d = 1; d <= Math.min(M.N + 1, 4); d++) want.push(hi + d, lo - d);
    const next = () => {
      // (the book may have closed, or another opened, while it waited)
      if (this.src().strip !== strip) return;
      const k = want.find(c => c >= 0 && c < strip.N && !this.cols.has(c));
      if (k === undefined) return;
      this.make(k);
      this.unidle = whenIdle(next);
    };
    this.settle = window.setTimeout(() => (this.unidle = whenIdle(next)), SETTLE_MS);
  }

  /** Building at rest called off: the sheet moves, or the map takes the screen. */
  private quiet() {
    clearTimeout(this.settle);
    this.unidle();
  }

  ensure(lo: number, hi: number) {
    const { strip } = this.src();
    lo = Math.max(0, lo); hi = Math.min(strip.N - 1, hi);
    for (let k = lo; k <= hi; k++) if (!this.cols.has(k)) this.make(k);
  }

  private make(k: number) {
    const src = this.src();
    const el = document.createElement('div');
    el.className = src.isLeaf(k) ? 'col leafcol' : 'col';
    // (a screen reader hears the page from spoken.ts; a leaf is heard while in focus)
    el.setAttribute('aria-hidden', 'true');
    el.dataset.k = String(k);
    el.style.left = `${(k - this.base) * src.M.P}px`;
    el.innerHTML = src.column(k);
    this.cols.set(k, el);
    this.track.append(el);
    fitColumn(el, src.M.fs);
  }

  /** Keeps coordinates small: far from the base, float precision would blur text. */
  rebase(k: number) {
    if (Math.abs(k - this.base) < 16) return;
    this.stop();
    const { M } = this.src();
    this.base = k;
    for (const [c, el] of this.cols) el.style.left = `${(c - this.base) * M.P}px`;
  }

  /** Re-renders everything (after a relayout). */
  reset(pos: number) {
    // (all at once: one change to the page, not one per column)
    this.track.replaceChildren();
    this.cols.clear();
    this.base = Math.round(pos);
    this.place(pos);
  }

  refresh(k: number) {
    const el = this.cols.get(k);
    if (el) { el.innerHTML = this.src().column(k); fitColumn(el, this.src().M.fs); }
  }

  columnEl(k: number) { return this.cols.get(k); }
  rendered() { return this.cols.entries(); }
}
