import type { BookData, Core } from '../core/types';
import { kv } from '../core/kv';
import { readingOrder, shareOf, type KeyIndex } from '../core/book';

/** One-tap reactions a reader of a manuscript gives a passage (D6), in the order of their
 *  keys in the chip (5 to 8). */
export const REACTIONS = ['loved', 'confused', 'slow', 'typo'] as const;
export type Reaction = (typeof REACTIONS)[number];
export const REACTION_LABEL: Record<Reaction, string> = { loved: 'Loved this', confused: 'Confused here', slow: 'Slow here', typo: 'A typo' };
export const isReaction = (r: unknown): r is Reaction => REACTIONS.includes(r as Reaction);

/** A highlight (optionally with a note) over part of one block. Offsets are UTF-16 into
 *  the block's text; the quote and its context let it find its text again if the book is
 *  re-imported and the blocks shift. */
export interface Annotation {
  id: string;
  key: string;
  s: number;
  e: number;
  quote: string;
  prefix: string;
  suffix: string;
  /** 1–4: the theme's highlight colours. */
  color: number;
  note: string;
  created: number;
  updated: number;
  /** How far through the book it was made (0–1), to help place it on a later draft. */
  pos?: number;
  /** Its words were reworded since: what they were. */
  was?: string;
  /** Not found in this version of the book: kept, but not drawn or listed. */
  lost?: boolean;
  /** A reaction (D6), with or without a note. */
  react?: Reaction;
}

/** Characters of context kept either side of a highlight, to find it again. */
const CTX = 32;

export class Annotations {
  list: Annotation[] = [];
  /** Annotations per block key, in order. */
  private byKey = new Map<string, Annotation[]>();

  constructor(private book: BookData, private keyIndex: KeyIndex) {
    this.list = kv.get<Annotation[]>('ann.' + book.id, []);
    this.index();
  }

  private block(key: string) {
    const hit = this.keyIndex.get(key);
    return hit ? this.book.sections[hit[0]].blocks[hit[1]] : null;
  }

  /** Checks every annotation still covers its words; those that do not are placed by the
   *  engine (moved, reworded, or not found: crates/engine/src/anchor.rs). Only those go
   *  to the engine, so an unchanged book costs nothing. */
  async place(core: Core) {
    const off = this.list.filter(a => { const b = this.block(a.key); return !b || b.t.slice(a.s, a.e) !== a.quote; });
    if (!off.length) return;
    const placed = await core.place(this.book.id, off.map(a => ({ key: a.key, s: a.s, e: a.e, quote: a.quote, prefix: a.prefix, suffix: a.suffix, pos: a.pos })));
    off.forEach((a, i) => {
      const p = placed[i];
      if (!p || p.how === 'lost') { a.lost = true; return; }
      const b = this.block(p.key);
      if (!b) { a.lost = true; return; }
      if (p.how === 'changed' && !a.was) a.was = a.quote;
      Object.assign(a, { key: p.key, s: p.s, e: p.e, quote: b.t.slice(p.s, p.e), prefix: b.t.slice(Math.max(0, p.s - CTX), p.s), suffix: b.t.slice(p.e, p.e + CTX), lost: false });
    });
    this.save();
  }

  private index() {
    this.byKey.clear();
    for (const a of this.list) {
      if (a.lost) continue;
      let arr = this.byKey.get(a.key);
      if (!arr) this.byKey.set(a.key, (arr = []));
      arr.push(a);
    }
    for (const arr of this.byKey.values()) arr.sort((x, y) => x.s - y.s);
  }

  private save() {
    kv.set('ann.' + this.book.id, this.list);
    this.index();
  }

  of(key: string): Annotation[] | undefined { return this.byKey.get(key); }

  /** Adds annotations not here yet (by id), as they came: `place` then finds their
   *  words. One here already takes the other's note and colour if that was edited later
   *  (the same notes from another device). Returns the ones added, and how many were
   *  brought up to date. */
  merge(add: Annotation[]): Annotation[] & { updated?: number } {
    const have = new Map(this.list.map(a => [a.id, a]));
    const fresh: Annotation[] & { updated?: number } = [];
    let updated = 0;
    for (const a of add) {
      const mine = have.get(a.id);
      if (!mine) { fresh.push(a); continue; }
      if ((a.updated || 0) > (mine.updated || 0) && (a.note !== mine.note || a.color !== mine.color)) {
        Object.assign(mine, { note: a.note, color: a.color, updated: a.updated });
        updated++;
      }
    }
    if (fresh.length) this.list.push(...fresh);
    if (fresh.length || updated) this.save();
    fresh.updated = updated;
    return fresh;
  }

  add(key: string, s: number, e: number, color = 1, note = ''): Annotation | null {
    const b = this.block(key);
    if (!b || e <= s) return null;
    // trim spaces at the edges of a selection, then take whole words
    while (s < e && /\s/.test(b.t[s])) s++;
    while (e > s && /\s/.test(b.t[e - 1])) e--;
    const word = (c: string | undefined) => !!c && /[\p{L}\p{N}’'-]/u.test(c);
    while (s > 0 && word(b.t[s - 1]) && word(b.t[s])) s--;
    while (e < b.t.length && word(b.t[e - 1]) && word(b.t[e])) e++;
    if (e <= s) return null;
    // a new highlight absorbs any it overlaps in the same block
    const over = (this.byKey.get(key) || []).filter(a => a.s < e && a.e > s);
    for (const o of over) { s = Math.min(s, o.s); e = Math.max(e, o.e); if (!note && o.note) note = o.note; }
    this.list = this.list.filter(a => !over.includes(a));
    const now = Date.now();
    const a: Annotation = {
      id: now.toString(36) + Math.random().toString(36).slice(2, 6), key, s, e,
      quote: b.t.slice(s, e), prefix: b.t.slice(Math.max(0, s - CTX), s), suffix: b.t.slice(e, e + CTX),
      color, note, created: now, updated: now, pos: shareOf(this.book, this.keyIndex, key),
    };
    this.list.push(a);
    this.save();
    return a;
  }

  update(id: string, patch: Partial<Pick<Annotation, 'color' | 'note' | 'react'>>) {
    const a = this.list.find(x => x.id === id);
    if (!a) return;
    Object.assign(a, patch, { updated: Date.now() });
    this.save();
  }

  remove(id: string) {
    this.list = this.list.filter(a => a.id !== id);
    this.save();
  }

  /** Reading order: section, block, offset. */
  ordered(): Annotation[] {
    const pos = (a: Annotation) => { const h = this.keyIndex.get(a.key); return h ? readingOrder(h[0], h[1], a.s) : Infinity; };
    return [...this.list].sort((a, b) => pos(a) - pos(b));
  }
}
