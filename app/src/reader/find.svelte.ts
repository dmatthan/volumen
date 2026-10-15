import type { Reader } from './reader.svelte';
import type { Annotation } from './annotations';
import { chapName } from './render';

/** One match, at a UTF-16 range of a block. */
export interface Hit { sec: number; block: number; key: string; s: number; e: number; near: boolean }

/** Find in book. The engine does the matching; this keeps the query, the hits and which
 *  one is current, marks them on the page and travels between them. */
export class Finder {
  open = $state(false);
  query = $state('');
  hits = $state.raw<Hit[]>([]);
  total = $state(0);
  phrase = $state(true);
  cur = $state(-1);
  /** Hits per block key, for the renderer. */
  private byKey = new Map<string, Annotation[]>();
  private seq = 0;
  private t = 0;

  constructor(private reader: Reader) {}

  show() { this.open = true; }
  hide() {
    this.open = false;
    this.query = ''; this.hits = []; this.total = 0; this.cur = -1;
    this.byKey.clear();
    this.reader.repaint();
  }

  /** Runs the query a moment after typing pauses (a search costs a few ms; the wait
   *  only spares the page from repainting on every key). */
  type(q: string) {
    this.query = q;
    clearTimeout(this.t);
    this.t = window.setTimeout(() => this.run(), 70);
  }

  async run() {
    const r = this.reader, book = r.book, strip = r.strip;
    if (!book || !strip) return;
    const q = this.query.trim();
    const seq = ++this.seq;
    if (!q) { this.hits = []; this.total = 0; this.cur = -1; this.byKey.clear(); r.repaint(); return; }
    const v = await r.core.find(book.id, q, 5000);
    if (seq !== this.seq) return;
    const hits: Hit[] = [];
    for (let i = 2; i + 4 < v.length + 1; i += 5) {
      const sec = v[i], block = v[i + 1];
      hits.push({ sec, block, key: book.sections[sec].blocks[block].key, s: v[i + 2], e: v[i + 3], near: v[i + 4] === 1 });
    }
    this.total = v[0]; this.phrase = v[1] === 1; this.hits = hits;
    this.byKey.clear();
    hits.forEach((h, i) => {
      let arr = this.byKey.get(h.key);
      if (!arr) this.byKey.set(h.key, (arr = []));
      arr.push({ id: 'f' + i, key: h.key, s: h.s, e: h.e, quote: '', prefix: '', suffix: '', color: 5, note: '', created: 0, updated: 0 });
    });
    // the current hit: the first at or after the page in view
    const here = r.cur;
    const k = hits.findIndex(h => this.colOf(h) >= here);
    this.cur = hits.length ? (k < 0 ? 0 : k) : -1;
    this.paintCur();
    r.repaint();
  }

  colOf(h: Hit) { return this.reader.strip!.resolve({ key: h.key, off: h.s }); }

  /** Marks for one block: the hits in it, the current one stronger. */
  of(key: string): Annotation[] | undefined { return this.byKey.get(key); }
  private paintCur() {
    for (const arr of this.byKey.values()) for (const a of arr) a.color = 5;
    const h = this.hits[this.cur];
    if (h) { const a = this.byKey.get(h.key)?.find(x => x.s === h.s); if (a) a.color = 6; }
  }

  /** Hit `i` becomes current (wrapping), without moving the page; its column. */
  pick(i: number): number {
    if (!this.hits.length) return -1;
    this.cur = (i + this.hits.length) % this.hits.length;
    this.paintCur();
    this.reader.repaint();
    return this.colOf(this.hits[this.cur]);
  }

  /** To hit `i`: it becomes current and comes into view. */
  go(i: number) {
    if (!this.hits.length) return;
    this.cur = (i + this.hits.length) % this.hits.length;
    this.paintCur();
    const r = this.reader, k = this.colOf(this.hits[this.cur]);
    const inView = k >= r.cur && k < r.cur + r.M.N;
    r.repaint();
    if (!inView) r.travelTo(k);
  }
  next() { this.go(this.cur + 1); }
  prev() { this.go(this.cur - 1); }

  /** The hits as the result list shows them: grouped by chapter, one row per block
   *  (a block's hits share its row). */
  rows(limit = 400) {
    const book = this.reader.book!;
    const out: { sec: number; chapter: string; i: number; before: string; match: string; after: string; count: number }[] = [];
    let last = '';
    for (let i = 0; i < this.hits.length && out.length < limit; i++) {
      const h = this.hits[i];
      const id = h.key;
      if (id === last) { out[out.length - 1].count++; continue; }
      last = id;
      const t = book.sections[h.sec].blocks[h.block].t;
      const a = Math.max(0, h.s - 48), z = Math.min(t.length, h.e + 90);
      const before = (a > 0 ? '…' : '') + t.slice(a, h.s).replace(/^\S*\s/, a > 0 ? '' : '$&');
      out.push({ sec: h.sec, chapter: chapName(book, h.sec), i, before, match: t.slice(h.s, h.e), after: t.slice(h.e, z) + (z < t.length ? '…' : ''), count: 1 });
    }
    return out;
  }
}
