import type { BookData, Core, LibEntry, NoteAnchor } from '../core/types';
import { IMPORTER_VERSION } from '../core/types';
import { kv } from '../core/kv';
import { keyIndexOf, type KeyIndex } from '../core/book';
import { Annotations } from './annotations';
import { notebookOf, saveDigest } from './notebook';

/** A book read by an earlier importer than this one. */
export const stale = (e: LibEntry) => (e.importer ?? 0) < IMPORTER_VERSION;

/** Where a block's text is, as an anchor that finds it again in another reading of the
 *  book: its words from `off`, and the words around them. */
export function anchorAt(book: BookData, key: string, off: number): NoteAnchor | null {
  for (const s of book.sections) for (const b of s.blocks) {
    if (b.key !== key) continue;
    const t = b.t;
    const at = Math.min(Math.max(0, off), Math.max(0, t.length - 1));
    let e = Math.min(t.length, at + 48);
    const sp = t.indexOf(' ', e);
    if (sp > 0 && sp - at < 80) e = sp;
    if (e <= at) return null;
    return { key, s: at, e, quote: t.slice(at, e), prefix: t.slice(Math.max(0, at - 32), at), suffix: t.slice(e, e + 32) };
  }
  return null;
}

type Place = { key?: string; off?: number };

/** A place and marked paragraphs in `old` (an earlier reading or draft of a book), found
 *  again by their words in the book now kept as `to`; those not found are left out. */
export async function placeAgain(core: Core, old: BookData, to: string, pos: Place | null, marks: string[]): Promise<{ pos?: { key: string; off: number }; marks: string[] }> {
  const anchors: NoteAnchor[] = [], what: ('pos' | 'mark')[] = [];
  if (pos?.key) { const a = anchorAt(old, pos.key, pos.off ?? 0); if (a) { anchors.push(a); what.push('pos'); } }
  for (const k of marks) { const a = anchorAt(old, k, 0); if (a) { anchors.push(a); what.push('mark'); } }
  const out: { pos?: { key: string; off: number }; marks: string[] } = { marks: [] };
  if (!anchors.length) return out;
  (await core.place(to, anchors)).forEach((p, i) => {
    if (!p || p.how === 'lost') return;
    if (what[i] === 'pos') out.pos = { key: p.key, off: p.s };
    else out.marks.push(p.key);
  });
  return out;
}

/** One's own highlights placed on a book's words as they are now, and the library's copy
 *  of its notebook made again. */
export async function placeOwnNotes(core: Core, book: BookData, keyIndex: KeyIndex = keyIndexOf(book)): Promise<Annotations> {
  const ann = new Annotations(book, keyIndex);
  await ann.place(core);
  saveDigest(book, notebookOf(book, keyIndex, ann.list, kv.get<string[]>('marks.' + book.id, [])));
  return ann;
}

/** Reads a book again from its kept file with the importer as it is now (a later one sets
 *  more of what the publisher made: rich blocks, the publisher's styles). The reader's
 *  place and marked paragraphs go with it, found again by their words; highlights find
 *  theirs as the book opens (annotations.ts), and the library's notebook is made again. */
export async function reread(core: Core, e: LibEntry): Promise<LibEntry> {
  const id = e.id;
  const old = await core.open(id);
  const marks = kv.get<string[]>('marks.' + id, []);
  const fresh = await core.reimport(id);
  const r = await placeAgain(core, old, id, kv.get<Place | null>('pos.' + id, null), marks);
  if (r.pos) kv.set('pos.' + id, r.pos);
  if (marks.length) kv.set('marks.' + id, r.marks);
  await placeOwnNotes(core, await core.open(id));
  return fresh;
}
