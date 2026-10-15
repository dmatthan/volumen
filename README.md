# Volumen

A reader for EPUB, Word and Markdown. Books are typeset in columns that move sideways;
highlights and notes can be sent back to the writer of a shared manuscript. It runs in the
browser ([volumen.page](https://volumen.page)) and as a desktop app.

## Layout

| Path | |
| --- | --- |
| `crates/model` | Document model: sections, blocks, style runs, stable block keys |
| `crates/ingest` | Importers: EPUB 2 and 3 (with publisher CSS), Word, Markdown, plain text |
| `crates/press` | Typesetting: shaping (HarfRust), paragraph breaking, hyphenation, columns |
| `crates/engine` | One API over the above: layout cache, find, library search, note anchoring |
| `crates/wasm` | The engine for the web (wasm-bindgen) |
| `app` | The reader (Svelte); the engine runs in a worker. `app/site` is volumen.page |
| `src-tauri` | The desktop app (Tauri): SQLite storage and full-text search, system fonts |
| `service` | Sharing: a Cloudflare Worker with D1, holding ciphertext only |
| `assets` | Fonts, hyphenation patterns, the sample book, icons |
| `app/kit` | `volumen.js`: the elements that put the reader on other sites' pages |
| `examples` | A chapter on a blog, a library from a list |
| `scripts` | Build and deploy |

## Build

Rust (stable) with the `wasm32-unknown-unknown` target, `wasm-bindgen-cli` 0.2.129,
Node 20.19 or later.

```sh
scripts/build-wasm.sh                 # engine → app/src/core/pkg
npm --prefix app install
npm --prefix app run dev              # http://localhost:5193
cargo test                            # crates
cargo run -p vol-ingest --example dump -- book.epub   # what a file imports as
scripts/run.sh                        # desktop app
npx --prefix app tauri build          # desktop installers (target/release/bundle)
```

`VOLUMEN_KIT=1` builds the kit (`app/dist-kit`). Releases (the desktop app for Linux, macOS
and Windows, and the kit) are built by `.github/workflows/release.yml` when a `v*` tag is
pushed.

`VOLUMEN_WEB=1 npm --prefix app run build` builds the site as deployed: the reader at
`/read`, the page at `/`. Without it the reader is at `/`, as the desktop app loads it.

## Sharing service

A book is encrypted in the browser (AES-256-GCM); its key is in the link's fragment and
never reaches the service. Readers need no account. Writers are invited and sign in with
passkeys.

```sh
(cd service && npm install && cp .dev.vars.example .dev.vars)
(cd service && npx wrangler dev --port 8788 --local-upstream localhost:8788 --upstream-protocol http)
scripts/deploy.sh                     # to your own Cloudflare account, after `npx wrangler login`
scripts/service.sh invite "Name"      # an invitation link for a writer
```

## On other sites

The kit is the reader alone, for any site: `Volumen-kit.zip` from a release, unpacked into
a folder (here `/volumen/`). Two elements place it on a page:

```html
<script type="module" src="/volumen/volumen.js"></script>

<volumen-book src="/books/book.epub" chapters="3" theme="paper"
  end-href="/shop" end-label="Buy the book"></volumen-book>

<volumen-library src="/books.json"></volumen-library>
```

`<volumen-book>` fills the box the page gives it. `src` is an EPUB, Word or Markdown file;
`chapters` (`3`, `1-3`), `theme`, `end-href`/`end-label` (a card at the end) and
`remember` (keep the reader's place in the browser) are optional. It sends
`volumen-progress` (`detail.at`, 0 to 1) and `volumen-end`. `<volumen-library>` makes a
shelf from `[{ "title", "author", "src", "cover" }]`. See `examples/`.

To put a sample online without the rest of the book, write one with only those chapters
(the app's Save as EPUB, or
`cargo run -p vol-ingest --example sample -- book.epub 1-3 sample.epub`).

The same elements work from `https://volumen.page/volumen.js`, with no kit; the book's
server must then send `Access-Control-Allow-Origin`.

## License

MIT. Fonts: SIL Open Font License (`assets/fonts/*-OFL.txt`). The sample book is
*Meditations* (tr. George Long) from [Standard Ebooks](https://standardebooks.org), public
domain.
