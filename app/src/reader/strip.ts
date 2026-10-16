import type { BookData } from '../core/types';
import { keyIndexOf, type KeyIndex } from '../core/book';

/** Line table fields, matching vol_press::encode. */
export const F = { col: 0, row: 1, block: 2, s: 3, e: 4, flags: 5, x: 6, avail: 7, natural: 8 } as const;
export const FIELDS = 9;
export const enum Flag {
  Justify = 1, Hyph = 2, Right = 4, Center = 8, Head = 16, Verse = 32, Quote = 64, Break = 128, First = 256, Bullet = 512,
  /** An image: x, avail, natural are its left, width, height; the spaces field its rows. */
  Image = 1024, ImageRow = 2048,
  /** A table cell's line; on the same grid row as the line before; a table's rule. */
  Cell = 4096, SameRow = 8192, Rule = 16384,
  /** Set at its own size, in the spaces field (1/16 px): preformatted text (in the
   *  monospaced face) and the cells of a table set smaller to fit the measure. */
  Sized = 32768,
}

/** One section's lines, viewed straight over the engine's buffer. */
export interface SecLayout {
  cols: number;
  n: number;
  u: Uint32Array;
  f: Float32Array;
  /** Index of the first line of each column; length cols + 1. */
  colStart: Int32Array;
  /** Columns are an estimate: the section has not been laid out yet. */
  est?: boolean;
}

export function parseLayout(buf: ArrayBuffer): Map<number, SecLayout> {
  const u = new Uint32Array(buf), f = new Float32Array(buf);
  const out = new Map<number, SecLayout>();
  const ns = u[0];
  let at = 1 + 3 * ns;
  for (let i = 0; i < ns; i++) {
    const idx = u[1 + 3 * i], cols = u[2 + 3 * i], n = u[3 + 3 * i];
    const lu = u.subarray(at, at + n * FIELDS), lf = f.subarray(at, at + n * FIELDS);
    const colStart = new Int32Array(cols + 1);
    let c = 0;
    for (let j = 0; j < n; j++) {
      const col = lu[j * FIELDS];
      while (c < col) colStart[++c] = j;
    }
    while (c < cols) colStart[++c] = n;
    out.set(idx, { cols, n, u: lu, f: lf, colStart });
    at += n * FIELDS;
  }
  return out;
}

export type ItemType = 'title' | 'sect' | 'colophon';
export interface Item { type: ItemType; start: number; n: number; sec: number }

export type Anchor =
  | { key: string; off: number }
  | { leaf: ItemType; sec: number; off?: number };

export class Strip {
  items: Item[] = [];
  colItem = new Int32Array(0);
  N = 0;
  /** First and last column of each section. */
  secStart: number[] = [];
  secEnd: number[] = [];
  layouts = new Map<number, SecLayout>();
  keyIndex: KeyIndex;
  /** Columns per section that has not been laid out yet. */
  private wordsPerCol = 250;

  constructor(public book: BookData) {
    this.keyIndex = keyIndexOf(book);
  }

  setEstimate(rows: number, measure: number, fs: number) {
    const charsPerLine = measure / (fs * 0.47);
    this.wordsPerCol = Math.max(40, (rows * charsPerLine) / 5.9);
  }

  isChapter(sec: number) { return this.book.sections[sec]?.k === 1; }

  compose() {
    const items: Item[] = [];
    let k = 0;
    const push = (type: ItemType, n: number, sec: number) => { items.push({ type, start: k, n, sec }); k += n; };
    this.secStart = []; this.secEnd = [];
    push('title', 1, -1);
    this.book.sections.forEach((s, si) => {
      const lay = this.layouts.get(si);
      const n = lay ? lay.cols : Math.max(1, Math.ceil(s.blocks.reduce((a, b) => a + b.t.length / 5.9, 0) / this.wordsPerCol));
      this.secStart[si] = k; this.secEnd[si] = k + n - 1;
      push('sect', n, si);
    });
    push('colophon', 1, this.book.sections.length);
    this.items = items;
    this.N = k;
    this.colItem = new Int32Array(k);
    items.forEach((it, i) => this.colItem.fill(i, it.start, it.start + it.n));
  }

  itemAt(k: number): Item | undefined { return this.items[this.colItem[k]]; }

  /** The lines of global column k, if it is a laid-out text column. */
  linesAt(k: number): { sl: SecLayout; from: number; to: number; sec: number; local: number } | null {
    const it = this.itemAt(k);
    if (!it || it.type !== 'sect') return null;
    const sl = this.layouts.get(it.sec);
    if (!sl) return null;
    const local = k - it.start;
    if (local >= sl.cols) return null;
    return { sl, from: sl.colStart[local], to: sl.colStart[local + 1], sec: it.sec, local };
  }

  anchorAt(k: number): Anchor | null {
    const it = this.itemAt(k);
    if (!it) return null;
    if (it.type !== 'sect') return { leaf: it.type, sec: it.sec };
    const L = this.linesAt(k);
    if (L) {
      for (let j = L.from; j < L.to; j++) {
        const o = j * FIELDS;
        if (L.sl.u[o + F.flags] & Flag.Break) continue;
        return { key: this.book.sections[L.sec].blocks[L.sl.u[o + F.block]].key, off: L.sl.u[o + F.s] };
      }
    }
    return { leaf: 'sect', sec: it.sec, off: k - it.start };
  }

  resolve(a: Anchor | null): number {
    if (!a) return 0;
    if ('key' in a) {
      const hit = this.keyIndex.get(a.key);
      if (!hit) return 0;
      const [sec, b] = hit;
      const sl = this.layouts.get(sec);
      const start = this.secStart[sec] ?? 0;
      if (!sl) return start;
      let best = -1;
      for (let j = 0; j < sl.n; j++) {
        const o = j * FIELDS;
        if (sl.u[o + F.block] !== b) continue;
        if (best < 0 || sl.u[o + F.s] <= a.off) best = j;
        if (sl.u[o + F.e] > a.off) break;
      }
      return best < 0 ? start : start + sl.u[best * FIELDS + F.col];
    }
    const it = this.items.find(i => i.type === a.leaf && i.sec === a.sec);
    if (it) return it.start + Math.min(Math.max(0, a.off || 0), it.n - 1);
    if (a.leaf === 'colophon') return this.N - 1;
    // a place saved beside a leaf there is no more (a chapter's end): the next chapter
    if (a.leaf !== 'sect' && a.leaf !== 'title') return this.secStart[a.sec + 1] ?? this.N - 1;
    return this.secStart[a.sec] ?? 0;
  }

  /** Where in the book column k is, from 0 to 1. */
  frac(k: number) { return this.N > 1 ? k / (this.N - 1) : 0; }
}
