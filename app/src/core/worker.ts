/// <reference lib="webworker" />
// The engine for the web build. Book blobs live in IndexedDB here, so the main thread
// never holds or parses a whole book.
import init, { Engine, catchPanics, lastPanic, faultForTest, importerVersion, annotateDocx, epubOf } from './pkg/vol_wasm.js';
import wasmUrl from './pkg/vol_wasm_bg.wasm?url';
import type { BookData, BookHits, FamilyLoad, LibEntry } from './types';
import { bundledFiles } from './fonts';
import { at } from './root';
import { tx, library } from './db';

let eng: Engine;
let wasm: { memory: WebAssembly.Memory };
const ready = (async () => {
  wasm = await init({ module_or_path: wasmUrl });
  catchPanics();
  eng = new Engine();
})();

/** Files this worker fetched (for the service worker to keep: main.ts). */
const fetched = new Set<string>();

/** Bundled families are fetched the first time a layout asks for them. */
const loading = new Map<string, Promise<void>>();
function family(name: string): Promise<void> {
  const files = bundledFiles(name);
  if (!files) return Promise.resolve();
  let p = loading.get(name);
  if (!p) {
    p = (async () => {
      await ready;
      const bufs = await Promise.all(files.map(f => { const u = at('fonts/' + f.file); fetched.add(u); return fetch(u, { cache: 'force-cache' }).then(x => x.arrayBuffer()); }));
      for (const b of bufs) eng.addFont(name, new Uint8Array(b));
    })();
    loading.set(name, p);
  }
  return p;
}
/** A book's hyphenation patterns, fetched the first time a layout of it asks. */
const hyph = new Map<string, Promise<void>>();
function patterns(id: string): Promise<void> {
  const code = eng.patternsWanted(id);
  if (!code) return Promise.resolve();
  let p = hyph.get(code);
  if (!p) {
    fetched.add(at(`hyph/${code}.bin`));
    p = fetch(at(`hyph/${code}.bin`), { cache: 'force-cache' }).then(r => r.arrayBuffer()).then(b => eng.addPatterns(code, new Uint8Array(b))).catch(() => {});
    hyph.set(code, p);
  }
  return p;
}

/** The faces a layout of book `id` draws with: the theme's first face (with its extension
 *  if the book goes beyond the core characters); the rest of the chain, and Literata last,
 *  only if the book has characters the first face lacks; JetBrains Mono only for
 *  preformatted text. Without a book (calibrating), the first face alone. */
async function families(names: string[], id?: string) {
  const ext = !!id && eng.extWanted(id);
  const load = (n: string) => Promise.all([family(n), ext ? family(n + '~ext') : null]);
  await load(names[0] ?? 'Literata');
  if (!id) return;
  const needs = JSON.parse(eng.fontNeeds(id, names[0] ?? 'Literata') ?? '{"fallback":"","pre":false}');
  await Promise.all([
    ...(needs.fallback ? [...names.slice(1), 'Literata'].map(load) : []),
    needs.pre ? load('JetBrains Mono') : null,
  ]);
}

async function ensure(id: string) {
  await ready;
  if (eng.has(id)) return;
  const blob = await tx<Uint8Array | undefined>('books', 'readonly', s => s.get(id));
  if (!blob) throw new Error('This book is no longer in the library.');
  eng.restore(blob);
}

const ops: Record<string, (...a: any[]) => Promise<unknown>> = {
  /** Reads a file and stores the book (in a worker of its own, ended afterwards: see
   *  web.ts); the library's list is the reading worker's (`addEntry`). */
  async importFile(bytes: Uint8Array, name: string, sample = false, chapters?: [number, number]): Promise<LibEntry> {
    await ready;
    // (an extract of some chapters, for a page: kit/volumen.js)
    const id = chapters ? eng.import_chapters(bytes, name, chapters[0], chapters[1]) : eng.import(bytes, name);
    const book = JSON.parse(eng.bookJson(id)!) as BookData;
    await tx('books', 'readwrite', s => s.put(eng.save(id)!, id));
    // its file, to be read again by a later importer (an extract is made again instead)
    if (!chapters) await tx('sources', 'readwrite', s => s.put({ name, bytes }, id));
    const cover = eng.cover(id);
    if (cover) await tx('covers', 'readwrite', s => s.put(cover, id));
    // (a book read again: the images of its earlier reading go)
    await tx('images', 'readwrite', s => s.delete(IDBKeyRange.bound(`${id}/`, `${id}/\uffff`)));
    for (let i = 0, n = eng.imageCount(id); i < n; i++) {
      const bytes = eng.imageBytes(id, i), mime = eng.imageMime(id, i);
      if (bytes && mime) await tx('images', 'readwrite', s => s.put({ mime, bytes }, `${id}/${i}`));
    }
    return { id, title: book.title, author: book.author, year: book.year, words: book.words, chapters: book.sections.filter(s => s.k === 1).length, added: Date.now(), sample, cover: !!cover, importer: importerVersion(), source: !chapters } satisfies LibEntry;
  },
  async open(id: string) {
    await ensure(id);
    return eng.bookJson(id);
  },
  async layout(id: string, sections: number[], p: any) {
    await ensure(id);
    await Promise.all([families(p.font, id), patterns(id)]);
    return eng.layout(id, new Uint32Array(sections), JSON.stringify(p)).buffer;
  },
  async loadFamily(name: string): Promise<FamilyLoad> {
    await family(name);
    const info = eng.familyInfo(name);
    if (!info) throw new Error(`${name} is not available in the web build.`);
    const i = JSON.parse(info);
    return { bundled: true, smcp: i.smcp, italic: i.italic, files: [] };
  },
  async find(id: string, query: string, limit: number) {
    await ensure(id);
    return eng.find(id, query, limit) ?? new Uint32Array(2);
  },
  async fontNeeds(id: string, family_: string) {
    await ensure(id);
    await family(family_);
    if (eng.extWanted(id)) await family(family_ + '~ext');
    return JSON.parse(eng.fontNeeds(id, family_) ?? '{"fallback":"","pre":false}');
  },
  async place(id: string, anchors: unknown[]) {
    await ensure(id);
    return JSON.parse(eng.place(id, JSON.stringify(anchors)));
  },
  /** Library search: every saved book in turn (the desktop has an index instead). */
  async searchLibrary(query: string): Promise<BookHits[]> {
    await ready;
    const out: BookHits[] = [];
    for (const e of await library()) {
      const blob = await tx<Uint8Array | undefined>('books', 'readonly', s => s.get(e.id));
      const json = blob && eng.searchSaved(blob, query, 3);
      if (json) out.push(JSON.parse(json));
    }
    // a phrase found anywhere outranks every-word matches, as on the desktop
    const phrase = out.some(h => h.phrase);
    return out.filter(h => h.phrase === phrase).sort((a, z) => z.total - a.total);
  },
  /** Sizes the reader measured for rich blocks: in the engine, and kept with the book. */
  async setImageSizes(id: string, flat: number[]) {
    await ensure(id);
    if (eng.setImageSizes(id, new Uint32Array(flat))) await tx('books', 'readwrite', s => s.put(eng.save(id)!, id));
  },
  /** Readers' notes as Word comments in a Word file (crates/ingest/src/annotate.rs). */
  async annotateDocx(docx: Uint8Array, notes: string) {
    await ready;
    const a = annotateDocx(docx, notes);
    return { bytes: a.bytes, report: a.report };
  },
  /** Chapters of a file as an EPUB of their own (crates/ingest/src/write.rs). */
  async epubOf(bytes: Uint8Array, name: string, from: number, to: number) {
    await ready;
    return epubOf(bytes, name, from, to);
  },
  /** A book removed from the library, or imported again: the engine's copy goes. */
  async forget(id: string) {
    await ready;
    if (eng.has(id)) eng.forget(id);
  },
  async probe(p: any, texts: string[]) {
    await ready;
    await families(p.font);
    return [...eng.probe(JSON.stringify(p), texts)];
  },
  /** What the engine holds (bench/memory.mjs). */
  async memory() { await ready; return { wasm: wasm.memory.buffer.byteLength }; },
  /** (tests: the engine failing) */
  async faultForTest() { await ready; faultForTest(); },
  async fetched() { return [...fetched]; },
};

self.onmessage = async (e: MessageEvent) => {
  const { n, op, args } = e.data;
  try {
    const value = await ops[op](...args);
    const transfer = value instanceof ArrayBuffer ? [value] : value instanceof Uint32Array ? [value.buffer] : [];
    (self as unknown as Worker).postMessage({ n, ok: true, value }, transfer);
  } catch (err) {
    const f = fault(err);
    // after a fault this instance is unusable: the page starts another (web.ts)
    (self as unknown as Worker).postMessage({ n, ok: false, error: f ?? String((err as Error)?.message || err), fatal: !!f });
  }
};

/** A fault inside the engine (a Rust panic, or memory running out) stops the WebAssembly
 *  instance: says what it was, as plainly as it can be said. */
function fault(err: unknown): string | null {
  if (!(err instanceof WebAssembly.RuntimeError)) return null;
  const p = lastPanic();
  const m = /panicked at (?:.*[\\/])?([^\\/:]+:\d+):\d+:\s*([\s\S]*)/.exec(p);
  if (m) return `Volumen hit a bug of its own (${m[2].trim()}, ${m[1]}).`;
  const mb = Math.round(wasm.memory.buffer.byteLength / 1048576);
  return `Volumen’s engine stopped (${(err as Error).message}; ${mb} MB in use).`;
}
