/** Volumen inside another site's page: `volumen.page/embed#src=<address of a book>`, in an
 *  iframe. One book, read in place: no library, no sharing, nothing added to the host
 *  page's history. The book comes from its own site, which must let other sites read it
 *  (CORS: `Access-Control-Allow-Origin`), and is imported again only when it changes.
 *  What the reader keeps (place, highlights) is in this frame's storage, which browsers
 *  keep apart for each site that embeds it. */
import type { Core } from './types';
import { kv } from './kv';

export const embedded = typeof location !== 'undefined' && /(^|\/)embed(\.html)?$/.test(location.pathname);

/** What the page asked for (kit/volumen.js writes these into the address's fragment):
 *  the book (an absolute http(s) address), only some chapters, a theme, a way on at the
 *  end, and whether to remember the reader's place in this browser. */
export interface EmbedOptions { src: string | null; chapters?: [number, number]; theme?: string; endHref?: string; endLabel?: string; remember: boolean }
export function embedOptions(): EmbedOptions {
  const q = new URLSearchParams(typeof location === 'undefined' ? '' : location.hash.slice(1));
  const url = (v: string | null) => { try { const u = new URL(v ?? '', location.href); return v && (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null; } catch { return null; } };
  const ch = /^(\d+)(?:-(\d+))?$/.exec(q.get('ch') ?? '');
  const chapters: [number, number] | undefined = ch ? [+ch[1], +(ch[2] ?? ch[1])] : undefined;
  return { src: url(q.get('src')), chapters: chapters && chapters[0] >= 1 && chapters[1] >= chapters[0] ? chapters : undefined, theme: q.get('theme') ?? undefined, endHref: url(q.get('end')) ?? undefined, endLabel: q.get('endl')?.slice(0, 60) || undefined, remember: q.get('rem') === '1' };
}
export const embedOpts = embedded ? embedOptions() : { src: null, remember: false } as EmbedOptions;

/** Where the reader is, and the end, told to the page around the frame (volumen.js turns
 *  them into events): a fraction of the book, a moment after it changes. */
let told = -1, ended = false, tellT = 0;
export function embedMoved(at: number, end: boolean) {
  if (!embedded || window.parent === window) return;
  clearTimeout(tellT);
  tellT = window.setTimeout(() => {
    if (Math.abs(at - told) >= 0.001) window.parent.postMessage({ volumen: 'progress', at: Math.round(at * 1000) / 1000 }, '*');
    told = at;
    if (end && !ended) { ended = true; window.parent.postMessage({ volumen: 'end' }, '*'); }
  }, 250);
}

/** Fetches the book (or finds it, unchanged since last time) and gives its id; or why it
 *  cannot. */
export async function embeddedBook(core: Core): Promise<{ id: string } | { error: string }> {
  const src = embedOpts.src;
  const chapters = embedOpts.chapters;
  if (!src) return { error: 'No book is named: the address should end with #src= and the address of an EPUB, Word or Markdown file.' };
  const host = new URL(src).host;
  let r: Response;
  try { r = await fetch(src, { mode: 'cors' }); }
  catch { return { error: `The book at ${host} cannot be read from here: its site has to allow other sites to read it (Access-Control-Allow-Origin).` }; }
  if (!r.ok) return { error: `The book is not at the address given (${host} answered ${r.status}).` };
  // the same file as last time: no need to read it again
  const tag = r.headers.get('etag') ?? (r.headers.get('last-modified') ? `${r.headers.get('last-modified')}/${r.headers.get('content-length')}` : '');
  const memo = 'embed.' + src + (chapters ? `#${chapters.join('-')}` : '');
  const known = kv.get<{ id: string; tag: string } | null>(memo, null);
  if (tag && known?.tag === tag && (await core.library()).some(e => e.id === known.id)) {
    r.body?.cancel().catch(() => {});
    return { id: known.id };
  }
  const bytes = new Uint8Array(await r.arrayBuffer());
  const name = decodeURIComponent(new URL(src).pathname.split('/').pop() || 'book.epub');
  try {
    const e = await core.importFile(bytes, name, chapters);
    kv.set(memo, { id: e.id, tag });
    return { id: e.id };
  } catch (e) {
    return { error: `The file at ${host} could not be read as a book (${(e as Error).message}).` };
  }
}
