import { fitColumn } from './verify';
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

  constructor(public track: HTMLElement, private src: () => RenderSource) {}

  setLazy(on: boolean) {
    if (on === this.lazy) return;
    this.lazy = on;
    if (!on) { cancelAnimationFrame(this.lazyRaf); this.lazyRaf = 0; this.ensureVisible(this.lastPos); }
  }

  private x(pos: number) {
    const { M } = this.src();
    return M.x0 - (pos - this.base) * M.P;
  }

  /** Puts the track at `pos`; at a whole column the text lands on device pixels. `v` is
   *  the speed in columns per second: columns ahead of the motion are built early, one per
   *  frame, so none is built in the frame it comes into view. */
  place(pos: number, v = 0) {
    this.lastPos = pos;
    let x = this.x(pos);
    if (Math.abs(pos - Math.round(pos)) < 1e-4) x = Math.round(x * this.dpr) / this.dpr;
    this.track.style.transform = `translate3d(${x.toFixed(3)}px,0,0)`;
    this.ensureVisible(pos, v);
  }

  /** Columns that can be seen at `pos` must exist now; columns ahead of the motion are
   *  built one per frame. */
  private ensureVisible(pos: number, v = 0) {
    const { M, strip } = this.src();
    const lo = Math.max(0, Math.floor(pos - (M.x0 + M.G) / M.P));
    const hi = Math.min(strip.N - 1, Math.ceil(pos + (M.W - M.x0) / M.P));
    const ahead = Math.round(Math.min(10, Math.max(2, Math.abs(v) * 0.6)));
    const aLo = v < -0.05 ? Math.max(0, lo - ahead) : Math.max(0, lo - 2);
    const aHi = v > 0.05 ? Math.min(strip.N - 1, hi + ahead) : Math.min(strip.N - 1, hi + 2);
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
    // one column ahead per frame, nearest first
    for (let d = 0; d < ahead + 2; d++) {
      const k = v >= 0 ? hi + 1 + d : lo - 1 - d;
      if (k >= aLo && k <= aHi && !this.cols.has(k)) { this.make(k); return; }
    }
    for (const k of [lo - 1, hi + 1, lo - 2, hi + 2]) if (k >= aLo && k <= aHi && !this.cols.has(k)) { this.make(k); return; }
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
    const { M } = this.src();
    this.base = k;
    for (const [c, el] of this.cols) el.style.left = `${(c - this.base) * M.P}px`;
  }

  /** Re-renders everything (after a relayout). */
  reset(pos: number) {
    for (const el of this.cols.values()) el.remove();
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
