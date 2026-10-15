import type { BookData } from '../core/types';
import type { Annotation } from './annotations';
import type { Anchor } from './strip';
import { fileNotes, me, FORMAT, type FileNote } from './feedback';
import type { MdBook } from './notesmd';
import { chapTitle } from './render';
import { kv } from '../core/kv';

/** One entry in a notebook: a highlight (with or without a note) or a marked paragraph.
 *  `at` is where it is in the book, independent of layout; `order` sorts a book's entries
 *  into reading order; `file` is the note as it travels (in a notes file, or a Markdown
 *  export that can be put back on the book). */
export interface NoteEntry {
  kind: 'ann' | 'mark';
  id: string;
  sec: number;
  where: string;
  quote: string;
  note: string;
  color: number;
  at: Anchor;
  order: number;
  file?: FileNote;
}

/** What the library keeps of each book's notebook, so it can list every book's at once
 *  without opening them. Written whenever the book's notes change. */
export interface Digest { title: string; author: string; updated: number; items: NoteEntry[] }

const order = (sec: number, block: number, off: number) => sec * 1e9 + block * 1e4 + Math.min(off, 9999);

/** Everything the reader has added to a book, in reading order. */
export function notebookOf(book: BookData, keyIndex: Map<string, [number, number]>, ann: Annotation[], marks: Iterable<string>): NoteEntry[] {
  const out: NoteEntry[] = [];
  const files = new Map(fileNotes(book, ann, marks, keyIndex).map(f => [f.id, f]));
  for (const a of ann) {
    if (a.lost) continue;
    const hit = keyIndex.get(a.key);
    if (!hit) continue;
    out.push({ kind: 'ann', id: a.id, sec: hit[0], where: chapTitle(book, hit[0]), quote: a.quote.replace(/\n/g, ' / '), note: a.note, color: a.color, at: { key: a.key, off: a.s }, order: order(hit[0], hit[1], a.s), file: files.get(a.id) });
  }
  for (const key of marks) {
    const hit = keyIndex.get(key);
    if (!hit) continue;
    out.push({ kind: 'mark', id: key, sec: hit[0], where: chapTitle(book, hit[0]), quote: book.sections[hit[0]].blocks[hit[1]].t.replace(/\n/g, ' / '), note: '', color: 0, at: { key, off: 0 }, order: order(hit[0], hit[1], 0), file: files.get('m:' + key) });
  }
  return out.sort((a, z) => a.order - z.order);
}

export function saveDigest(book: BookData, items: NoteEntry[]) {
  const k = 'nb.' + book.id;
  if (!items.length) { kv.del(k); return; }
  kv.set(k, { title: book.title, author: book.author, updated: Date.now(), items } satisfies Digest);
}

/** Every book's digest, by book id. */
export function digests(): Map<string, Digest> {
  const out = new Map<string, Digest>();
  for (const k of kv.keys('nb.')) {
    const d = kv.get<Digest | null>(k, null);
    // (digests written before chapter lines were removed may still hold them)
    if (d?.items) d.items = d.items.filter(i => i.kind === 'ann' || i.kind === 'mark');
    if (d?.items?.length) out.set(k.slice(3), d);
  }
  return out;
}

/** Text as find matches it: case, accents, curly quotes and dashes folded away. */
export function fold(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[‘’‛′]/g, "'").replace(/[“”‟″]/g, '"').replace(/[‐-―]/g, '-');
}

/** A book's notebook entries as Markdown that can be put back on the book
 *  (`notesmd.ts`). Entries from a digest written before notes carried their anchors get
 *  one made from what the digest has (exact on the same book). */
export function markdownOf(book: { id: string; title: string; author: string }, items: NoteEntry[]): MdBook {
  const m = me();
  const entries = items.map(it => {
    const shown = it.quote.replace(/ \/ /g, '\n');
    const key = 'key' in it.at ? it.at.key : '';
    const s = 'key' in it.at ? it.at.off : 0;
    const file: FileNote = it.file ?? { id: it.kind === 'mark' ? 'm:' + key : it.id, kind: it.kind === 'mark' ? 'mark' : 'highlight', key, s, e: s + shown.length, quote: shown, prefix: '', suffix: '', color: it.color || undefined, note: it.note || undefined, created: 0, updated: 0 };
    return { where: it.where, shown: it.kind === 'ann' ? file.quote : shown, file };
  });
  return { file: { format: FORMAT, book, from: { id: m.id, name: m.name }, sent: Date.now() }, entries };
}
