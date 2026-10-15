/** Volumen inside another site's page: `volumen.page/embed#src=<address of a book>`, in an
 *  iframe. One book, read in place: no library, no sharing, nothing added to the host
 *  page's history. The book comes from its own site, which must let other sites read it
 *  (CORS: `Access-Control-Allow-Origin`), and is imported again only when it changes.
 *  What the reader keeps (place, highlights) is in this frame's storage, which browsers
 *  keep apart for each site that embeds it. */
import type { Core } from './types';
import { kv } from './kv';

export const embedded = typeof location !== 'undefined' && /^\/embed(\.html)?$/.test(location.pathname);

/** The book's address, from `#src=` (an absolute http(s) address, encoded if it holds
 *  `&`); or null. */
export function embedSource(): string | null {
  const m = /(?:^#|&)src=([^&]*)/.exec(location.hash);
  if (!m) return null;
  try {
    const u = new URL(decodeURIComponent(m[1]), location.href);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch { return null; }
}

/** Fetches the book (or finds it, unchanged since last time) and gives its id; or why it
 *  cannot. */
export async function embeddedBook(core: Core): Promise<{ id: string } | { error: string }> {
  const src = embedSource();
  if (!src) return { error: 'No book is named: the address should end with #src= and the address of an EPUB, Word or Markdown file.' };
  const host = new URL(src).host;
  let r: Response;
  try { r = await fetch(src, { mode: 'cors' }); }
  catch { return { error: `The book at ${host} cannot be read from here: its site has to allow other sites to read it (Access-Control-Allow-Origin).` }; }
  if (!r.ok) return { error: `The book is not at the address given (${host} answered ${r.status}).` };
  // the same file as last time: no need to read it again
  const tag = r.headers.get('etag') ?? (r.headers.get('last-modified') ? `${r.headers.get('last-modified')}/${r.headers.get('content-length')}` : '');
  const known = kv.get<{ id: string; tag: string } | null>('embed.' + src, null);
  if (tag && known?.tag === tag && (await core.library()).some(e => e.id === known.id)) {
    r.body?.cancel().catch(() => {});
    return { id: known.id };
  }
  const bytes = new Uint8Array(await r.arrayBuffer());
  const name = decodeURIComponent(new URL(src).pathname.split('/').pop() || 'book.epub');
  try {
    const e = await core.importFile(bytes, name);
    kv.set('embed.' + src, { id: e.id, tag });
    return { id: e.id };
  } catch (e) {
    return { error: `The file at ${host} could not be read as a book (${(e as Error).message}).` };
  }
}
