import { kv } from '../core/kv';
import type { BookData, Core, NoteAnchor } from '../core/types';
import type { Annotation } from './annotations';
import { chapTitle } from './render';
import { isNotesMarkdown, parseNotesMarkdown } from './notesmd';
import { isWebAnno, fromWebAnno } from './webanno';

/* ---------- who I am ---------- */

/** A random id; `crypto.randomUUID` exists only on secure pages (https, localhost), not on
 *  a phone trying the app over the local network. */
function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** This reader: an id of their own (so their notes replace, not duplicate, their earlier
 *  ones at the writer's) and the name they give. Kept apart from settings, which reset. */
export interface Me { id: string; name: string }
export function me(): Me {
  let m = kv.get<Me | null>('me', null);
  if (!m) { m = { id: newId(), name: '' }; kv.set('me', m); }
  return m;
}
export function setName(name: string) { kv.set('me', { ...me(), name: name.trim().replace(/\s+/g, ' ').slice(0, 60) }); }

/* ---------- the notes file ---------- */

export const FORMAT = 'volumen-notes/1';

/** One note as it travels: where it is (as `NoteAnchor`), what it is, what it says. A
 *  marked paragraph is anchored to its opening words. */
export interface FileNote extends NoteAnchor {
  id: string;
  kind: 'highlight' | 'mark';
  color?: number;
  note?: string;
  created: number;
  updated: number;
}

/** A reader's notes on one book, to send to whoever sent them the book. */
export interface NotesFile {
  format: typeof FORMAT;
  book: { id: string; title: string; author: string };
  from: Me;
  sent: number;
  notes: FileNote[];
}

/** The opening words of a block, as an anchor for something that belongs to all of it. */
function opening(b: { key: string; t: string }, pos: number | undefined): NoteAnchor {
  const e = Math.min(b.t.length, 120);
  return { key: b.key, s: 0, e, quote: b.t.slice(0, e), prefix: '', suffix: b.t.slice(e, e + 32), pos };
}

/** Everything this reader added to a book, as notes that travel: highlights as they
 *  are, marked paragraphs by their opening words. */
export function fileNotes(book: BookData, ann: Annotation[], marks: Iterable<string>, keyIndex: Map<string, [number, number]>): FileNote[] {
  let total = 0;
  for (const s of book.sections) total += s.blocks.length;
  const start: number[] = [];
  book.sections.reduce((n, s, i) => { start[i] = n; return n + s.blocks.length; }, 0);
  const posOf = (key: string) => { const h = keyIndex.get(key); return h ? (start[h[0]] + h[1]) / Math.max(1, total) : undefined; };
  const notes: FileNote[] = [];
  for (const a of ann) {
    if (a.lost) continue;
    notes.push({ id: a.id, kind: 'highlight', key: a.key, s: a.s, e: a.e, quote: a.quote, prefix: a.prefix, suffix: a.suffix, pos: a.pos ?? posOf(a.key), color: a.color, note: a.note || undefined, created: a.created, updated: a.updated });
  }
  const now = Date.now();
  for (const key of marks) {
    const h = keyIndex.get(key);
    if (!h) continue;
    notes.push({ id: 'm:' + key, kind: 'mark', ...opening(book.sections[h[0]].blocks[h[1]], posOf(key)), created: now, updated: now });
  }
  return notes;
}

/** Everything this reader added to a book, as a notes file. */
export function notesFile(book: BookData, ann: Annotation[], marks: Iterable<string>, keyIndex: Map<string, [number, number]>): NotesFile {
  const m = me();
  return { format: FORMAT, book: { id: book.id, title: book.title, author: book.author }, from: { id: m.id, name: m.name }, sent: Date.now(), notes: fileNotes(book, ann, marks, keyIndex) };
}

/** A notes file read back, checked; or why it is not one. A notes file is JSON (sent
 *  between readers) or Markdown with its anchors kept in comments (an export: one or
 *  more books; `notesmd.ts`). */
export function parseNotes(text: string, book?: { id: string; title: string; author: string }): NotesFile[] | string {
  // W3C Web Annotations: from here, or another tool's (placed on `book` by their words)
  if (isWebAnno(text)) {
    const f = fromWebAnno(text, book);
    if (typeof f === 'string') return f;
    const c = checked(f);
    return typeof c === 'string' ? c : [c];
  }
  if (isNotesMarkdown(text)) {
    const books = parseNotesMarkdown(text);
    if (typeof books === 'string') return books;
    const out: NotesFile[] = [];
    for (const b of books) { const f = checked(b); if (typeof f === 'string') return f; out.push(f); }
    return out.length ? out : 'This file has no notes in it.';
  }
  let v: any;
  try { v = JSON.parse(text); } catch { return 'This is not a notes file.'; }
  const f = checked(v);
  return typeof f === 'string' ? f : [f];
}

function checked(v: any): NotesFile | string {
  if (v?.format !== FORMAT) return typeof v?.format === 'string' && v.format.startsWith('volumen-notes/') ? 'These notes come from a newer version of the app.' : 'This is not a notes file.';
  if (!v.book?.id || !v.from?.id || !Array.isArray(v.notes)) return 'This notes file is incomplete.';
  // (files from before chapter lines were removed may hold them: they are left out)
  const ok = (n: any) => n && typeof n.key === 'string' && typeof n.quote === 'string' && Number.isFinite(n.s) && Number.isFinite(n.e) && ['highlight', 'mark'].includes(n.kind);
  return { ...v, from: { id: String(v.from.id), name: String(v.from.name || 'A reader').slice(0, 60) }, notes: v.notes.filter(ok) };
}

/* ---------- other readers' notes on a book ---------- */

/** A note from another reader, placed on this book. */
export interface FbNote extends FileNote { lost?: boolean; was?: string; sec?: number }
interface FbReader { name: string; sent: number; notes: FbNote[] }
/** Reader colours: the n-th reader of a book is drawn in `--r{n % 6 + 1}`. */
export const READER_COLOURS = 6;

/** Feedback received on one book: each reader's latest notes, placed on the text as it
 *  is now. Kept per book (`fb.<id>`); a reader's new file replaces their old one. */
export class Feedback {
  readers: Record<string, FbReader>;
  /** Readers not shown just now. */
  hidden = new Set<string>();
  private byKey = new Map<string, { r: string; n: FbNote }[]>();

  constructor(private book: BookData, private keyIndex: Map<string, [number, number]>) {
    this.readers = kv.get<Record<string, FbReader>>('fb.' + book.id, {});
    this.status = kv.get<Record<string, 'done' | 'wont'>>('fbst.' + book.id, {});
    // (notes received before chapter lines were removed may hold them)
    for (const rd of Object.values(this.readers)) rd.notes = rd.notes.filter(n => n.kind === 'highlight' || n.kind === 'mark');
    this.index();
  }

  /** Readers in the order they first sent notes, with their colour. */
  list() {
    return Object.entries(this.readers).map(([id, r], i) => ({ id, name: r.name, sent: r.sent, colour: i % READER_COLOURS + 1, count: r.notes.filter(n => !n.lost).length, lost: r.notes.filter(n => n.lost).length }));
  }
  colourOf(id: string) { return Object.keys(this.readers).indexOf(id) % READER_COLOURS + 1; }
  get size() { return Object.keys(this.readers).length; }

  /** Readers' notes in each section (those shown, placed on this version), for the
   *  map's chapter list: where the feedback is. */
  perSection(): Map<number, number> {
    const out = new Map<number, number>();
    for (const [r, rd] of Object.entries(this.readers)) {
      if (this.hidden.has(r)) continue;
      for (const n of rd.notes) {
        const h = !n.lost && this.keyIndex.get(n.key);
        if (h) out.set(h[0], (out.get(h[0]) ?? 0) + 1);
      }
    }
    return out;
  }

  private index() {
    this.byKey.clear();
    for (const [r, rd] of Object.entries(this.readers)) {
      if (this.hidden.has(r)) continue;
      for (const n of rd.notes) {
        if (n.lost) continue;
        let a = this.byKey.get(n.key);
        if (!a) this.byKey.set(n.key, (a = []));
        a.push({ r, n });
      }
    }
  }
  private save() { kv.set('fb.' + this.book.id, this.readers); this.index(); }

  /** Adds (or replaces) a reader's notes. */
  /** A reader's notes, replacing their older ones (an older file changes nothing: false). */
  add(f: NotesFile): boolean {
    const had = this.readers[f.from.id];
    if (had && had.sent > f.sent) return false;
    this.readers[f.from.id] = { name: f.from.name || 'A reader', sent: f.sent, notes: f.notes.map(n => ({ ...n })) };
    this.save();
    return true;
  }
  remove(id: string) { delete this.readers[id]; this.hidden.delete(id); this.save(); }
  toggle(id: string) { if (this.hidden.has(id)) this.hidden.delete(id); else this.hidden.add(id); this.index(); }

  /** Places every note not on its words (made on another version, or newly arrived). */
  async place(core: Core) {
    const off: FbNote[] = [];
    for (const rd of Object.values(this.readers)) for (const n of rd.notes) {
      const h = this.keyIndex.get(n.key);
      const b = h && this.book.sections[h[0]].blocks[h[1]];
      if (!b || b.t.slice(n.s, n.e) !== n.quote) off.push(n);
    }
    if (off.length) {
      const placed = await core.place(this.book.id, off.map(n => ({ key: n.key, s: n.s, e: n.e, quote: n.quote, prefix: n.prefix, suffix: n.suffix, pos: n.pos })));
      off.forEach((n, i) => {
        const p = placed[i];
        const h = p && p.how !== 'lost' ? this.keyIndex.get(p.key) : undefined;
        if (!p || !h) { n.lost = true; return; }
        const t = this.book.sections[h[0]].blocks[h[1]].t;
        if (p.how === 'changed' && !n.was) n.was = n.quote;
        Object.assign(n, { key: p.key, s: p.s, e: p.e, quote: t.slice(p.s, p.e), lost: false });
      });
    }
    for (const rd of Object.values(this.readers)) for (const n of rd.notes) n.sec = this.keyIndex.get(n.key)?.[0];
    this.save();
  }

  /** Stretches of a block that readers marked, each with the colours of the readers who
   *  did (overlapping notes are cut into stretches with all of theirs). */
  segments(key: string): { s: number; e: number; colours: number[]; ids: string[] }[] {
    const ns = this.byKey.get(key)?.filter(x => x.n.kind === 'highlight');
    if (!ns?.length) return [];
    const cuts = [...new Set(ns.flatMap(x => [x.n.s, x.n.e]))].sort((a, b) => a - b);
    const out: { s: number; e: number; colours: number[]; ids: string[] }[] = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [s, e] = [cuts[i], cuts[i + 1]];
      const on = ns.filter(x => x.n.s <= s && x.n.e >= e);
      if (!on.length) continue;
      const colours = [...new Set(on.map(x => this.colourOf(x.r)))];
      out.push({ s, e, colours, ids: on.map(x => x.r + '|' + x.n.id) });
    }
    return out;
  }

  /** Notes with something written, in a block: for the gutter's dots and their cards. */
  written(key: string) { return (this.byKey.get(key) ?? []).filter(x => x.n.note && x.n.kind === 'highlight'); }
  /** Paragraphs readers marked, in a block. */
  marked(key: string) { return (this.byKey.get(key) ?? []).filter(x => x.n.kind === 'mark'); }

  /** One note by its reader and id. */
  find(rid: string) { const [r, id] = rid.split('|'); const rd = this.readers[r]; const n = rd?.notes.find(x => x.id === id); return n && { reader: rd.name, colour: this.colourOf(r), n }; }

  /** Everything, gathered by passage in reading order: notes on overlapping words of one
   *  block are one entry with every reader's voice. */
  /** What the writer decided about a passage (kept per book, `fbst.<id>`): done, or
   *  won't change; none is open. A passage is known by where it begins. */
  status: Record<string, 'done' | 'wont'> = {};
  passageId = (g: { key: string; s: number }) => `${g.key}:${g.s}`;
  setStatus(g: { key: string; s: number }, st: 'done' | 'wont' | null) {
    const id = this.passageId(g);
    if (st) this.status[id] = st; else delete this.status[id];
    kv.set('fbst.' + this.book.id, this.status);
  }

  /** Passages as `gathered`, with what the writer decided about each. */
  passages() { return this.gathered().map(g => ({ ...g, st: this.status[this.passageId(g)] as 'done' | 'wont' | undefined })); }

  gathered() {
    const all: { r: string; n: FbNote }[] = [];
    for (const [r, rd] of Object.entries(this.readers)) if (!this.hidden.has(r)) for (const n of rd.notes) if (!n.lost) all.push({ r, n });
    const pos = (x: { n: FbNote }) => { const h = this.keyIndex.get(x.n.key); return !h ? 9e15 : h[0] * 1e9 + h[1] * 1e4; };
    all.sort((a, b) => pos(a) - pos(b) || a.n.s - b.n.s);
    const groups: { key: string; sec: number; where: string; s: number; e: number; quote: string; voices: { reader: string; colour: number; kind: FbNote['kind']; note?: string; was?: string; rid: string; n: FbNote }[] }[] = [];
    for (const x of all) {
      const h = this.keyIndex.get(x.n.key)!;
      const t = this.book.sections[h[0]].blocks[h[1]].t;
      const last = groups[groups.length - 1];
      const voice = { reader: this.readers[x.r].name, colour: this.colourOf(x.r), kind: x.n.kind, note: x.n.note, was: x.n.was, rid: x.r, n: x.n };
      if (last && last.key === x.n.key && x.n.s < last.e) {
        last.voices.push(voice);
        last.e = Math.max(last.e, x.n.e);
        last.quote = t.slice(last.s, last.e);
      } else {
        groups.push({ key: x.n.key, sec: h[0], where: chapTitle(this.book, h[0]), s: x.n.s, e: x.n.e, quote: t.slice(x.n.s, x.n.e), voices: [voice] });
      }
    }
    return groups;
  }
}

/** Which book in the library a notes file is for: the same file, else a book of the same
 *  title (another draft: its notes are placed on the text as it is now). */
export function targetOf(f: NotesFile, library: { id: string; title: string }[]) {
  return library.find(b => b.id === f.book.id) ?? library.find(b => b.title.trim().toLowerCase() === f.book.title.trim().toLowerCase()) ?? null;
}

/** Stores a notes file against a book without opening it (placed when it opens). A
 *  reader's newer file replaces their older; an older one changes nothing (false). */
export function receive(f: NotesFile, bookId: string): boolean {
  const all = kv.get<Record<string, FbReader>>('fb.' + bookId, {});
  const had = all[f.from.id];
  if (had && had.sent > f.sent) return false;
  all[f.from.id] = { name: f.from.name || 'A reader', sent: f.sent, notes: f.notes };
  kv.set('fb.' + bookId, all);
  return true;
}
