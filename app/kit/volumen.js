// Volumen on any page: <volumen-book> and <volumen-library>.
//
//   <script type="module" src="/volumen/volumen.js"></script>
//   <volumen-book src="/books/sample.epub"></volumen-book>
//
// The element fills the box the page gives it (by default the width of its column, and
// 70% of the window's height; style it as anything else). The reader runs in a frame
// from the folder this file is in: self-hosted, it is the site's own; from
// https://volumen.page/volumen.js, the book's server must allow other sites to read it.
//
// <volumen-book> attributes:
//   src        the book: EPUB, Word (.docx) or Markdown, by its address
//   chapters   only these, as "3" or "1-3" (the book's chapters, counted from 1)
//   theme      original, quiet, paper, bold, calm or focus
//   end-href   at the end, a way on ("Continue reading" by default: end-label)
//   end-label
//   remember   the reader's place and highlights kept in this browser (off by default)
// Events: "volumen-progress" (detail.at, 0 to 1), "volumen-end".
//
// <volumen-library src="/books.json">: a shelf from a list of books,
//   [{ "title", "author", "src", "cover" }], each opened in place. A book with no cover
//   named shows its EPUB's own, read from the file as its tile comes into view (a few
//   small range requests; a host that does not take them sends the file whole, read
//   only up to 4 MB).

const here = new URL('.', import.meta.url);
const reader = new URL('embed.html', here);

const css = `
  :host { display: block; position: relative; width: 100%; height: 70vh; min-height: 420px; }
  iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; }
`;

class VolumenBook extends HTMLElement {
  static observedAttributes = ['src', 'chapters', 'theme', 'end-href', 'end-label', 'remember'];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `<style>${css}</style><iframe allow="fullscreen; clipboard-write"></iframe>`;
    this.frame = this.shadowRoot.querySelector('iframe');
    this.onMessage = e => {
      if (e.source !== this.frame.contentWindow || typeof e.data !== 'object' || !e.data?.volumen) return;
      if (e.data.volumen === 'progress') this.dispatchEvent(new CustomEvent('volumen-progress', { detail: { at: e.data.at }, bubbles: true }));
      if (e.data.volumen === 'end') this.dispatchEvent(new CustomEvent('volumen-end', { bubbles: true }));
    };
  }

  connectedCallback() { addEventListener('message', this.onMessage); this.load(); }
  disconnectedCallback() { removeEventListener('message', this.onMessage); }
  attributeChangedCallback() { if (this.isConnected) this.load(); }

  load() {
    const src = this.getAttribute('src');
    if (!src) return;
    const p = new URLSearchParams();
    // (the book's address as the page sees it: the frame is elsewhere)
    p.set('src', new URL(src, document.baseURI).href);
    for (const [attr, key] of [['chapters', 'ch'], ['theme', 'theme'], ['end-href', 'end'], ['end-label', 'endl']]) {
      const v = this.getAttribute(attr);
      if (v) p.set(key, attr === 'end-href' ? new URL(v, document.baseURI).href : v);
    }
    if (this.hasAttribute('remember')) p.set('rem', '1');
    this.frame.title = this.getAttribute('title') || 'A book';
    const url = `${reader.href}#${p.toString()}`;
    if (this.frame.src !== url) this.frame.src = url;
  }
}

/** An EPUB's cover, as an object URL, or null: read through the zip's directory, its
 *  container and package file, by ranges where the host allows them. */
async function epubCover(src) {
  const MAX = 4 << 20;
  const head = await fetch(src, { method: 'HEAD' }).catch(() => null);
  let total = +(head?.ok && head.headers.get('content-length')) || 0, whole = null;
  // bytes start..end (inclusive) of the file
  const bytes = async (start, end) => {
    if (whole) return whole.subarray(start, end + 1);
    const r = await fetch(src, { headers: { Range: `bytes=${start}-${end}` } });
    if (r.status === 206) { total ||= +(/\/(\d+)$/.exec(r.headers.get('content-range') || '')?.[1] || 0); return new Uint8Array(await r.arrayBuffer()); }
    if (!r.ok || +(r.headers.get('content-length') || 0) > MAX) throw new Error('too large to read whole');
    whole = new Uint8Array(await r.arrayBuffer());
    if (whole.length > MAX) throw new Error('too large to read whole');
    return whole.subarray(start, end + 1);
  };
  if (!total) { await bytes(0, 0); total ||= whole?.length || 0; }
  if (!total) return null;
  const le = (b, o, n) => n === 2 ? b[o] | b[o + 1] << 8 : (b[o] | b[o + 1] << 8 | b[o + 2] << 16) + b[o + 3] * 0x1000000;
  // the end of the central directory, within the last 64 KB
  const tailAt = Math.max(0, total - 65557), tail = await bytes(tailAt, total - 1);
  let e = tail.length - 22;
  while (e >= 0 && le(tail, e, 4) !== 0x06054b50) e--;
  if (e < 0) return null;
  const cdSize = le(tail, e + 12, 4), cdAt = le(tail, e + 16, 4);
  const cd = cdAt >= tailAt ? tail.subarray(cdAt - tailAt, cdAt - tailAt + cdSize) : await bytes(cdAt, cdAt + cdSize - 1);
  const entries = new Map();
  const dec = new TextDecoder();
  for (let o = 0; o + 46 <= cd.length && le(cd, o, 4) === 0x02014b50;) {
    const n = le(cd, o + 28, 2), x = le(cd, o + 30, 2), c = le(cd, o + 32, 2);
    entries.set(dec.decode(cd.subarray(o + 46, o + 46 + n)), { method: le(cd, o + 10, 2), size: le(cd, o + 20, 4), at: le(cd, o + 42, 4) });
    o += 46 + n + x + c;
  }
  const read = async name => {
    const en = entries.get(name);
    if (!en || en.size > MAX) return null;
    const h = await bytes(en.at, en.at + 29);
    const start = en.at + 30 + le(h, 26, 2) + le(h, 28, 2);
    const data = en.size ? await bytes(start, start + en.size - 1) : new Uint8Array();
    if (en.method === 0) return data;
    if (en.method !== 8) return null;
    return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  };
  const xml = async name => { const b = await read(name); return b && new DOMParser().parseFromString(dec.decode(b), 'application/xml'); };
  const opfPath = (await xml('META-INF/container.xml'))?.querySelector('rootfile')?.getAttribute('full-path');
  const opf = opfPath && await xml(opfPath);
  if (!opf) return null;
  const items = [...opf.getElementsByTagName('item')];
  const named = [...opf.getElementsByTagName('meta')].find(m => m.getAttribute('name') === 'cover')?.getAttribute('content');
  const item = items.find(i => /(^|\s)cover-image(\s|$)/.test(i.getAttribute('properties') || ''))
    || items.find(i => named && i.getAttribute('id') === named && /^image\//.test(i.getAttribute('media-type') || ''))
    || items.find(i => /^image\//.test(i.getAttribute('media-type') || '') && /cover/i.test((i.getAttribute('id') || '') + (i.getAttribute('href') || '')));
  if (!item) return null;
  const path = decodeURIComponent(new URL(item.getAttribute('href'), 'z:/' + opfPath).pathname.slice(1));
  const img = await read(path);
  return img && URL.createObjectURL(new Blob([img], { type: item.getAttribute('media-type') || 'image/jpeg' }));
}

class VolumenLibrary extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  async connectedCallback() {
    const src = this.getAttribute('src');
    if (!src) return;
    let books = [];
    try { books = await (await fetch(new URL(src, document.baseURI))).json(); }
    catch { this.shadowRoot.textContent = 'The list of books could not be read.'; return; }
    this.books = Array.isArray(books) ? books : books.books ?? [];
    this.shelf();
  }

  shelf() {
    const r = this.shadowRoot;
    // an EPUB's own cover, read when its tile comes into view (once per book)
    this.covers ??= new Map();
    this.seen?.disconnect();
    this.seen = new IntersectionObserver(es => {
      for (const { isIntersecting, target: c } of es) {
        if (!isIntersecting) continue;
        this.seen.unobserve(c);
        const src = new URL(c.book.src, document.baseURI).href;
        if (!this.covers.has(src)) this.covers.set(src, epubCover(src).catch(() => null));
        this.covers.get(src).then(u => { if (u) { c.style.backgroundImage = `url("${u}")`; c.textContent = ''; c.classList.add('own'); } });
      }
    }, { rootMargin: '200px' });
    r.innerHTML = `<style>
      :host { display: block; font: inherit; color: inherit; }
      .shelf { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 28px 20px; padding: 0; margin: 0; list-style: none; }
      button { all: unset; box-sizing: border-box; width: 100%; cursor: pointer; display: grid; gap: 8px; align-content: start; }
      button:focus-visible { outline: 2px solid currentColor; outline-offset: 4px; border-radius: 4px; }
      .c { box-sizing: border-box; width: 100%; aspect-ratio: 2 / 3; border-radius: 4px; background: color-mix(in oklab, currentColor 7%, transparent) center / cover no-repeat; box-shadow: 0 1px 2px rgb(0 0 0 / .18); display: grid; place-items: center; padding: 14px; text-align: center; font-size: 1.05em; line-height: 1.25; font-family: Georgia, serif; text-wrap: balance; }
      .t { font-weight: 600; line-height: 1.3; }
      .a { opacity: .7; font-size: .9em; }
    </style><ul class="shelf"></ul>`;
    const ul = r.querySelector('.shelf');
    for (const b of this.books) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      const c = document.createElement('span');
      c.className = 'c';
      if (b.cover) c.style.backgroundImage = `url("${new URL(b.cover, document.baseURI).href.replace(/"/g, '%22')}")`;
      else {
        c.textContent = b.title ?? '';
        if (/\.epub([?#]|$)/i.test(b.src ?? '')) this.seen.observe(Object.assign(c, { book: b }));
      }
      const t = Object.assign(document.createElement('span'), { className: 't', textContent: b.title ?? '' });
      const a = Object.assign(document.createElement('span'), { className: 'a', textContent: b.author ?? '' });
      btn.append(c, t, a);
      btn.onclick = () => this.open(b);
      li.append(btn);
      ul.append(li);
    }
  }

  open(b) {
    const r = this.shadowRoot;
    r.innerHTML = `<style>
      :host { display: block; }
      .back { all: unset; cursor: pointer; display: inline-block; margin: 0 0 12px; font: inherit; text-decoration: underline; text-underline-offset: .2em; }
      .back:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
    </style><button class="back">← All books</button>`;
    const book = document.createElement('volumen-book');
    book.setAttribute('src', new URL(b.src, document.baseURI).href);
    book.setAttribute('title', b.title ?? 'A book');
    for (const k of ['theme', 'remember']) if (this.hasAttribute(k)) book.setAttribute(k, this.getAttribute(k) || '');
    r.append(book);
    r.querySelector('.back').onclick = () => this.shelf();
  }
}

if (!customElements.get('volumen-book')) customElements.define('volumen-book', VolumenBook);
if (!customElements.get('volumen-library')) customElements.define('volumen-library', VolumenLibrary);
