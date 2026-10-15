import type { BookData, Core, LibEntry, NoteAnchor } from '../core/types';
import { IMPORTER_VERSION } from '../core/types';
import { kv } from '../core/kv';
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

/** Reads a book again from its kept file with the importer as it is now (a later one sets
 *  more of what the publisher made: rich blocks, the publisher's styles). The reader's
 *  place and marked paragraphs go with it, found again by their words; highlights find
 *  theirs as the book opens (annotations.ts), and the library's notebook is made again. */
export async function reread(core: Core, e: LibEntry): Promise<LibEntry> {
  const id = e.id;
  const old = await core.open(id);
  const pos = kv.get<{ key?: string; off?: number } | null>('pos.' + id, null);
  const marks = kv.get<string[]>('marks.' + id, []);
  const anchors: NoteAnchor[] = [];
  const what: ('pos' | 'mark')[] = [];
  if (pos?.key) { const a = anchorAt(old, pos.key, pos.off ?? 0); if (a) { anchors.push(a); what.push('pos'); } }
  for (const k of marks) { const a = anchorAt(old, k, 0); if (a) { anchors.push(a); what.push('mark'); } }
  const fresh = await core.reimport(id);
  const book = await core.open(id);
  if (anchors.length) {
    const placed = await core.place(id, anchors);
    const nextMarks: string[] = [];
    placed.forEach((p, i) => {
      if (!p || p.how === 'lost') return;
      if (what[i] === 'pos') kv.set('pos.' + id, { key: p.key, off: p.s });
      else nextMarks.push(p.key);
    });
    if (marks.length) kv.set('marks.' + id, nextMarks);
  }
  // highlights on their words now, and the notebook the library shows
  const keyIndex = new Map<string, [number, number]>();
  book.sections.forEach((s, si) => s.blocks.forEach((b, bi) => keyIndex.set(b.key, [si, bi])));
  const ann = new Annotations(book, keyIndex);
  await ann.place(core);
  saveDigest(book, notebookOf(book, keyIndex, ann.list, kv.get<string[]>('marks.' + id, [])));
  return fresh;
}
