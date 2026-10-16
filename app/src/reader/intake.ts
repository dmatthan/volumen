/** Notes files taken in: dropped on the library or the open book, picked, or collected
 *  from the sharing service. One's own notes go back on their books (an export, or a copy
 *  from another device); another reader's are kept as feedback on theirs, placed beside
 *  the text at once if that book is open, else when it next opens. What happened is said
 *  plainly. */
import type { BookData, Core } from '../core/types';
import { count } from '../core/say';
import { fetchNotes } from '../core/service';
import { parseNotes, receive, targetOf, type Feedback, type NotesFile } from './feedback';
import type { Annotations } from './annotations';
import { isMine, restoreInto, restoreOwn, restored } from './restore';

/** The book open in the reader, whose notes are live. */
export interface OpenBook { book: BookData; ann: Annotations; marks: Set<string>; fb: Feedback }

/** Takes notes files in. `names` name the files, for the message about any that were not
 *  notes. `changed`: something was put back or added. */
export async function takeNotes(core: Core, texts: string[], library: { id: string; title: string }[], open?: OpenBook, names: string[] = []): Promise<{ said: string; changed: boolean }> {
  // every file read first: a folder from a dozen readers is one import, said once
  const files: NotesFile[] = [], bad: string[] = [];
  let why = '';
  const meta = open ? { id: open.book.id, title: open.book.title, author: open.book.author } : undefined;
  texts.forEach((t, i) => { const r = parseNotes(t, meta); if (typeof r === 'string') { bad.push(names[i] ?? r); why = r; } else files.push(...r); });
  if (!files.length) return { said: texts.length === 1 ? why : 'None of these files are notes.', changed: false };

  const said: string[] = [];
  const theirs = new Map<string, { title: string; readers: Map<string, string>; notes: number }>();
  const missing = new Map<string, number>();
  let found = 0, changed = false;
  for (const f of files) {
    // (notes for the open book's title are for it, whichever draft they were made on)
    const t = open && targetOf(f, [open.book]) ? open.book : targetOf(f, library);
    if (!t) { missing.set(f.book.title, (missing.get(f.book.title) ?? 0) + 1); continue; }
    found++;
    const live = open && t.id === open.book.id ? open : null;
    if (isMine(f)) {
      try {
        const r = live ? await restoreInto(f, live.book, core, live.ann, live.marks) : await restoreOwn(f, t.id, core);
        said.push(restored(t.title, r));
        changed = true;
      } catch (e) { said.push(`Your notes on “${t.title}” could not be put back: ${(e as Error).message}`); }
      continue;
    }
    if (!(live ? live.fb.add(f) : receive(f, t.id))) continue;
    changed = true;
    const b = theirs.get(t.id) ?? { title: t.title, readers: new Map<string, string>(), notes: 0 };
    b.readers.set(f.from.id, f.from.name || 'A reader');
    b.notes += f.notes.length;
    theirs.set(t.id, b);
  }

  for (const [id, b] of theirs) {
    const who = b.readers.size === 1 ? [...b.readers.values()][0] : count(b.readers.size, 'reader', 'readers');
    if (open && id === open.book.id) {
      await open.fb.place(core);
      const rs = open.fb.list().filter(x => b.readers.has(x.id));
      const placed = rs.reduce((k, x) => k + x.count, 0), lost = rs.reduce((k, x) => k + x.lost, 0);
      said.push(`Notes from ${who}: ${placed} placed${lost ? `, ${lost} not found in this version` : ''}.`);
    } else said.push(`Notes from ${who} on “${b.title}”: ${count(b.notes, 'note', 'notes')}. Open the book to see them beside the text.`);
  }
  if (found && !said.length) said.push('These notes are here already.');
  for (const [title, k] of missing) said.push(`${count(k, 'file is', 'files are')} for “${title}”, which is not in your library: add the book, then the notes again.`);
  if (bad.length) said.push(`${count(bad.length, 'file was', 'files were')} not notes${bad.length <= 3 ? ` (${bad.join(', ')})` : ''}.`);
  return { said: said.join(' '), changed };
}

/** Readers' notes from the sharing service, kept as feedback on their books. What came,
 *  per book and reader. */
export async function collectNotes(): Promise<{ book: string; from: string; notes: number }[]> {
  const out: { book: string; from: string; notes: number }[] = [];
  for (const { book, text } of await fetchNotes()) {
    const files = parseNotes(text);
    if (typeof files === 'string') continue;
    for (const f of files) {
      receive({ ...f, book: { ...f.book, id: book } }, book);
      out.push({ book, from: f.from.name || 'A reader', notes: f.notes.length });
    }
  }
  return out;
}
