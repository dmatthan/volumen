/** Selections in the book: where a point on the page is in the text, the word around it,
 *  and a selection's stretch of each paragraph it covers. Selection here is entirely the
 *  reader's own (input.ts): word by word, never the browser's drag. */
import type { BookData } from '../core/types';
import type { Strip } from './strip';

/** A place in the text: section, block, UTF-16 offset. */
export type Point = [number, number, number];

/** A text selection in the book: from one point to another (either may come first). */
export interface Sel { a: Point; z: Point }

/** The selection's ends in reading order. */
function ordered(sel: Sel): [Point, Point] {
  const [as, ab, ao] = sel.a, [zs, zb, zo] = sel.z;
  return as > zs || (as === zs && (ab > zb || (ab === zb && ao > zo))) ? [sel.z, sel.a] : [sel.a, sel.z];
}

/** Each block a selection covers, with the stretch of its text, in reading order. */
export function* spans(book: BookData, sel: Sel): Generator<{ s: number; b: number; from: number; to: number }> {
  const [[as, ab, ao], [zs, zb, zo]] = ordered(sel);
  for (let s = as; s <= zs; s++) {
    const blocks = book.sections[s].blocks;
    for (let b = s === as ? ab : 0; b <= (s === zs ? zb : blocks.length - 1); b++) {
      yield { s, b, from: s === as && b === ab ? ao : 0, to: s === zs && b === zb ? zo : blocks[b].t.length };
    }
  }
}

/** The quote of a selection, for copying. */
export function selText(book: BookData, sel: Sel): string {
  const parts: string[] = [];
  for (const { s, b, from, to } of spans(book, sel)) parts.push(book.sections[s].blocks[b].t.slice(from, to).replace(/\n/g, ' / '));
  return parts.join('\n\n').trim();
}

/** A DOM point inside a line, as a place in the text. */
export function pointAt(strip: Strip, node: Node | null, off: number): Point | null {
  const el = node?.nodeType === 3 ? node.parentElement : (node as Element | null);
  const ln = el?.closest?.('.ln[data-b]') as HTMLElement | null;
  const col = ln?.closest('.col') as HTMLElement | null;
  if (!ln || !col) return null;
  const it = strip.itemAt(+col.dataset.k!);
  if (!it || it.type !== 'sect') return null;
  let n = 0;
  const tw = document.createTreeWalker(ln, NodeFilter.SHOW_TEXT);
  for (let t = tw.nextNode(); t; t = tw.nextNode()) {
    if ((t.parentElement as Element).closest('.bul')) continue;
    if (t === node) { n += off; break; }
    n += (t as Text).length;
  }
  if (node?.nodeType !== 3) n = 0;
  return [it.sec, +ln.dataset.b!, +ln.dataset.s! + n];
}

/** A word's ends within its text node. */
export type Word = { s: [Node, number]; e: [Node, number] };

/** The word around a DOM point, as start and end points within its text node. */
export function wordAt(node: Node, off: number): Word {
  if (node.nodeType !== 3) return { s: [node, off], e: [node, off] };
  const t = (node as Text).data;
  const w = (c: string | undefined) => !!c && /[\p{L}\p{N}’'-]/u.test(c);
  let a = off;
  // over a gap (space, punctuation): hold at the end of the word before it
  while (a > 0 && !w(t[a]) && !w(t[a - 1])) a--;
  if (!w(t[a]) && a > 0 && w(t[a - 1])) a--;
  let z = a;
  while (a > 0 && w(t[a - 1])) a--;
  while (z < t.length && w(t[z])) z++;
  // keep punctuation that closes the word (a full stop, a comma, a closing quote)
  while (z < t.length && /[.,;:!?”’)]/.test(t[z])) z++;
  if (z === a) z = Math.min(t.length, a + 1);
  return { s: [node, a], e: [node, z] };
}

/** Shows a selection from one word to another, whichever comes first in the text. */
export function showSel(a: Word, f: Word) {
  const r = document.createRange();
  r.setStart(a.s[0], a.s[1]);
  let before = false;
  try { before = r.comparePoint(f.s[0], f.s[1]) < 0; } catch { /* different roots */ }
  const [s, e] = before ? [f.s, a.e] : [a.s, f.e];
  try { getSelection()?.setBaseAndExtent(s[0], s[1], e[0], e[1]); } catch { /* outside text */ }
}

/** The text position under a point of the window. */
export function caretAt(x: number, y: number): { node: Node; off: number } | null {
  const d = document as any;
  if (d.caretPositionFromPoint) { const p = d.caretPositionFromPoint(x, y); return p ? { node: p.offsetNode, off: p.offset } : null; }
  if (d.caretRangeFromPoint) { const r = d.caretRangeFromPoint(x, y); return r ? { node: r.startContainer, off: r.startOffset } : null; }
  return null;
}
