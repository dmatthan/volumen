import type { FileNote, NotesFile } from './feedback';

/* Notes as Markdown: what a reader reads (each book's title, its chapters, every quote and
 * note), with what the app needs to put them back on the book kept in HTML comments,
 * which Markdown does not show:
 *
 *   <!-- volumen-notes/1 {"book":{…},"from":{…},"sent":…} -->
 *   # The Man Who Was Thursday
 *
 *   G. K. Chesterton
 *
 *   ## Chapter II: The Secret of Gabriel Syme
 *
 *   > pulled up before a particularly dreary and greasy beershop
 *   <!-- at {"id":"…","kind":"highlight","key":"…","s":10,"e":120,"prefix":"…","suffix":"…","color":2,…} -->
 *
 *   A note here
 *
 * The quote is the blockquote above its comment (a marked paragraph's quote is its
 * opening words, kept in the comment: the blockquote shows the whole paragraph); the note
 * is what follows, up to the next quote or heading. Lines that Markdown would take for
 * something else (a heading, a quote, a list) are escaped with a backslash. */

const BOOK = /^<!-- (volumen-notes\/\d+) (\{.*\}) -->\s*$/;
const AT = /^<!-- at (\{.*\}) -->\s*$/;

/** One note as it is shown: under its chapter, its words as the book has them. */
export interface MdEntry { where: string; shown: string; file: FileNote }
export interface MdBook { file: Omit<NotesFile, 'notes'>; entries: MdEntry[] }

/** JSON that may sit in an HTML comment (no "--", no "<"). */
const comment = (head: string, v: unknown) => `<!-- ${head} ${JSON.stringify(v).replace(/--/g, '-\\u002d').replace(/</g, '\\u003c')} -->`;

/** A line Markdown would read as structure, escaped; and back. */
const esc = (line: string) => (/^\s*(#|>|<!--|[-+*](\s|$)|\d+[.)](\s|$)|\\)/.test(line) ? '\\' + line : line);
const unesc = (line: string) => (line.startsWith('\\') ? line.slice(1) : line);

/** A chapter's name as a heading: "Chapter II: The Secret of Gabriel Syme". */
const heading = (where: string) => where.replace(/\s+·\s+/g, ': ');

export function notesMarkdown(books: MdBook[]): string {
  const out: string[] = [];
  for (const b of books) {
    const { book } = b.file;
    out.push(comment(b.file.format, { book, from: b.file.from, sent: b.file.sent }), `# ${book.title}`, '');
    if (book.author) out.push(esc(book.author), '');
    let where: string | null = null;
    for (const e of b.entries) {
      if (e.where !== where) { where = e.where; out.push(`## ${heading(where)}`, ''); }
      out.push(...e.shown.split('\n').map(l => (l ? '> ' + esc(l) : '>')));
      const { note, quote, ...at } = e.file;
      out.push(comment('at', quote === e.shown ? at : { ...at, quote }), '');
      if (note) out.push(...note.split('\n').map(esc), '');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Whether a text is notes written as Markdown (rather than a manuscript). */
export function isNotesMarkdown(text: string) {
  return /^<!-- volumen-notes\/\d+ \{/m.test(text.slice(0, 4000));
}

/** Notes written as Markdown, one notes file per book in it (not yet checked: feedback.ts). */
export function parseNotesMarkdown(text: string): NotesFile[] | string {
  const out: NotesFile[] = [];
  let cur: NotesFile | null = null, quote: string[] = [], entry: FileNote | null = null, note: string[] = [];
  const end = () => {
    if (entry && cur) {
      const n = note.join('\n').trim();
      cur.notes.push(n ? { ...entry, note: n } : entry);
    }
    entry = null; note = [];
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    let m: RegExpExecArray | null;
    if ((m = BOOK.exec(line))) {
      end(); quote = [];
      try { cur = { ...JSON.parse(m[2]), format: m[1], notes: [] }; } catch { return 'The notes in this file are damaged.'; }
      out.push(cur!);
      continue;
    }
    if (!cur) continue;
    if ((m = AT.exec(line))) {
      end();
      try { entry = { quote: quote.join('\n'), ...JSON.parse(m[1]) }; } catch { return 'A note in this file is damaged.'; }
      quote = [];
      continue;
    }
    if (line.startsWith('>')) { end(); quote.push(unesc(line.replace(/^> ?/, ''))); continue; }
    if (line.startsWith('#')) { end(); quote = []; continue; }
    if (entry) note.push(unesc(line));
  }
  end();
  return out;
}
