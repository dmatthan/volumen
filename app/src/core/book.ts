/** Where things are in a book's model: each paragraph's place, how far through the text
 *  it is, and reading order. By the text, never by columns (which depend on the layout). */
import type { BookData } from './types';

/** Each block's key, as its section and its index there. */
export type KeyIndex = Map<string, [number, number]>;

export function keyIndexOf(book: BookData): KeyIndex {
  const m: KeyIndex = new Map();
  book.sections.forEach((s, si) => s.blocks.forEach((b, bi) => m.set(b.key, [si, bi])));
  return m;
}

/** Where each section begins, counted in blocks, and how many there are. */
const ordinals = new WeakMap<BookData, { start: number[]; total: number }>();
export function blockOrdinals(book: BookData) {
  let o = ordinals.get(book);
  if (!o) {
    const start: number[] = [];
    let n = 0;
    for (const s of book.sections) { start.push(n); n += s.blocks.length; }
    o = { start, total: Math.max(1, n) };
    ordinals.set(book, o);
  }
  return o;
}

/** How far through the book block `bi` of section `sec` is, from 0 to 1. */
export function shareAt(book: BookData, sec: number, bi: number): number {
  const { start, total } = blockOrdinals(book);
  return ((start[sec] ?? 0) + bi) / total;
}

/** How far through the book a block is, by its key (none if the book has no such block). */
export function shareOf(book: BookData, keyIndex: KeyIndex, key: string): number | undefined {
  const h = keyIndex.get(key);
  return h ? shareAt(book, h[0], h[1]) : undefined;
}

/** A number that sorts places into reading order: section, block, offset. */
export const readingOrder = (sec: number, block: number, off = 0) => sec * 1e9 + block * 1e4 + Math.min(off, 9999);
