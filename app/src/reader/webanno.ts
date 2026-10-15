import { FORMAT, type FileNote, type NotesFile } from './feedback';

/* Notes as W3C Web Annotations (https://www.w3.org/TR/annotation-model/), for other tools:
 * an AnnotationCollection whose items each target the book by a TextQuoteSelector (the
 * words, and the words either side), which any tool can place, and a selector of our own
 * with the block and offsets, which this app places exactly. Read back, a collection from
 * here or from another tool becomes a notes file: what it does not say (the block) is
 * found by the words (engine/src/anchor.rs). */

const BOOK = 'urn:volumen:book:';
const OURS = 'https://volumen.app/ns/block';

export function toWebAnno(f: NotesFile): object {
  const iso = (t: number) => new Date(t || f.sent).toISOString();
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'AnnotationCollection',
    label: f.book.title,
    creator: { type: 'Person', name: f.from.name || undefined, id: `urn:volumen:reader:${f.from.id}` },
    generated: new Date(f.sent).toISOString(),
    total: f.notes.length,
    first: {
      type: 'AnnotationPage',
      items: f.notes.map(n => ({
        type: 'Annotation',
        id: `urn:volumen:note:${n.id}`,
        created: iso(n.created),
        modified: iso(n.updated),
        motivation: n.note ? 'commenting' : n.kind === 'mark' ? 'bookmarking' : 'highlighting',
        ...(n.note ? { body: { type: 'TextualBody', value: n.note, format: 'text/plain', purpose: 'commenting' } } : {}),
        target: {
          source: BOOK + f.book.id,
          selector: [
            { type: 'TextQuoteSelector', exact: n.quote, prefix: n.prefix || undefined, suffix: n.suffix || undefined },
            { type: OURS, block: n.key, start: n.s, end: n.e, kind: n.kind, colour: n.color, position: n.pos },
          ],
        },
      })),
    },
  };
}

/** Whether a text is a Web Annotation collection (or a single annotation, or a list). */
export function isWebAnno(text: string) {
  return /"@context"\s*:\s*"http:\/\/www\.w3\.org\/ns\/anno\.jsonld"/.test(text.slice(0, 2000));
}

/** Annotations read as a notes file; `book` names the book they go on when they do not
 *  say (another tool's). Or why they cannot be. */
export function fromWebAnno(text: string, book?: { id: string; title: string; author: string }): NotesFile | string {
  let v: any;
  try { v = JSON.parse(text); } catch { return 'These annotations are damaged.'; }
  const items: any[] = Array.isArray(v) ? v : v?.type === 'Annotation' ? [v] : v?.first?.items ?? v?.items ?? [];
  const notes: FileNote[] = [];
  let source = '';
  const t = (s: unknown) => (typeof s === 'string' ? Date.parse(s) || 0 : 0);
  for (const a of items) {
    const target = Array.isArray(a?.target) ? a.target[0] : a?.target;
    const sels: any[] = Array.isArray(target?.selector) ? target.selector : target?.selector ? [target.selector] : [];
    const quote = sels.find(s => s?.type === 'TextQuoteSelector');
    if (!quote || typeof quote.exact !== 'string' || !quote.exact) continue;
    const ours = sels.find(s => s?.type === OURS) ?? {};
    source ||= typeof target?.source === 'string' ? target.source : '';
    const body = Array.isArray(a.body) ? a.body.find((b: any) => b?.type === 'TextualBody') : a.body;
    const note = typeof body?.value === 'string' ? body.value : '';
    const id = String(a.id ?? '').replace(/^urn:volumen:note:/, '') || `w:${notes.length}:${quote.exact.slice(0, 24)}`;
    notes.push({
      id, kind: ours.kind === 'mark' ? 'mark' : 'highlight',
      // (another tool's: no block known; the words find it)
      key: typeof ours.block === 'string' ? ours.block : '', s: Number.isFinite(ours.start) ? ours.start : 0, e: Number.isFinite(ours.end) ? ours.end : quote.exact.length,
      quote: quote.exact, prefix: typeof quote.prefix === 'string' ? quote.prefix : '', suffix: typeof quote.suffix === 'string' ? quote.suffix : '',
      pos: Number.isFinite(ours.position) ? ours.position : undefined,
      color: Number.isFinite(ours.colour) ? ours.colour : undefined, note: note || undefined,
      created: t(a.created), updated: t(a.modified) || t(a.created),
    });
  }
  if (!notes.length) return 'These annotations have no passages this app can place.';
  const id = source.startsWith(BOOK) ? source.slice(BOOK.length) : book?.id;
  if (!id) return 'These annotations do not say which book they are for: open the book and drop them on it.';
  const creator = Array.isArray(v?.creator) ? v.creator[0] : v?.creator ?? items[0]?.creator;
  const from = { id: String(creator?.id ?? 'web-annotations').replace(/^urn:volumen:reader:/, ''), name: String(creator?.name ?? creator?.nickname ?? 'Annotations').slice(0, 60) };
  return { format: FORMAT, book: { id, title: String(v?.label ?? book?.title ?? ''), author: book?.author ?? '' }, from, sent: t(v?.generated) || Date.now(), notes };
}
