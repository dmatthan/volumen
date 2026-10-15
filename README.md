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
```

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

## Embedding

Planned, not yet available.

## License

MIT. Fonts: SIL Open Font License (`assets/fonts/*-OFL.txt`). The sample book is
*Meditations* (tr. George Long) from [Standard Ebooks](https://standardebooks.org), public
domain.
