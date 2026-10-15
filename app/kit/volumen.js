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
//   [{ "title", "author", "src", "cover" }], each opened in place.

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
      else c.textContent = b.title ?? '';
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
