import type { BookData, BookHits, Core, FamilyLoad, LayoutParams, LibEntry, Placed } from './types';
import * as db from './db';

const imageURLs = new Map<string, Promise<string>>();

/** How long the engine stays with no book open before it is ended (its memory, and the
 *  layouts it keeps, given back). */
const IDLE_MS = 5 * 60_000;

/** The engine in a Web Worker (WASM), started when it is first needed; the library, its
 *  covers and images are read from IndexedDB here and need no engine. */
export function webCore(): Core & { importSample(bytes: Uint8Array): Promise<LibEntry>; faultForTest(): Promise<void>; memory(): Promise<{ wasm: number }>; idle(ms?: number): void; running(): boolean } {
  let n = 0;
  type Call = { op: string; args: unknown[]; once: boolean; res: (v: any) => void; rej: (e: Error) => void };
  const pending = new Map<number, Call>();
  let w: Worker | null = null;
  /** With no book open, the engine ends at a set time: calls meanwhile (a library search,
   *  the offline cache's question every 30 s) neither cancel nor delay it; opening a
   *  book does. */
  let idleT = 0, idleAt = 0;
  const endIdle = () => {
    clearTimeout(idleT);
    if (!idleAt || !w) return;
    const left = idleAt - Date.now();
    if (left > 0 || pending.size) { idleT = window.setTimeout(endIdle, Math.max(left, 1000)); return; }
    w.terminate(); w = null; idleAt = 0;
  };
  /** A fault in the engine leaves its instance unusable: the worker is replaced, and the
   *  calls it had not answered go to the new one (except those whose bytes were handed
   *  over, which cannot be sent twice). Books, fonts and patterns load again as asked. */
  function spawn(): Worker {
    const me = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w = me;
    me.onmessage = e => {
      const p = pending.get(e.data.n);
      if (!p) return;
      pending.delete(e.data.n);
      e.data.ok ? p.res(e.data.value) : p.rej(new Error(e.data.error));
      if (e.data.fatal) {
        me.terminate();
        const next = spawn();
        for (const [id, c] of pending) {
          if (c.once) { pending.delete(id); c.rej(new Error(e.data.error)); } else next.postMessage({ n: id, op: c.op, args: c.args });
        }
      }
    };
    // a worker that fails outside any call (it could not load, it ran out of memory):
    // what it was asked fails, and the next call has a new one (nothing is sent again,
    // so a worker that cannot start fails each call once rather than looping)
    me.onerror = ev => {
      ev.preventDefault();
      const err = new Error(`Volumen’s engine stopped (${ev.message || 'it could not start'}).`);
      me.terminate();
      if (w === me) w = null;
      for (const [id, c] of pending) { pending.delete(id); c.rej(err); }
    };
    return me;
  }
  const call = <T>(op: string, args: unknown[], transfer: Transferable[] = []) => {
    if (op === 'open') { idleAt = 0; clearTimeout(idleT); }
    return new Promise<T>((res, rej) => { const id = ++n; pending.set(id, { op, args, once: transfer.length > 0, res, rej }); (w ?? spawn()).postMessage({ n: id, op, args }, transfer); });
  };

  /** Imports run one at a time, each in a worker of its own, ended once the book is
   *  stored: reading a large file grows a WebAssembly memory, which never shrinks, and
   *  the reading engine's stays small; a fault while importing ends only that worker. */
  let importing: Promise<unknown> = Promise.resolve();
  const importIn = (bytes: Uint8Array, name: string, sample: boolean, again?: LibEntry) => {
    const run = importing.then(() => new Promise<LibEntry>((res, rej) => {
      const iw = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      const end = () => iw.terminate();
      iw.onmessage = e => { end(); e.data.ok ? res(e.data.value) : rej(new Error(e.data.error)); };
      iw.onerror = ev => { ev.preventDefault(); end(); rej(new Error(`Volumen’s engine stopped (${ev.message || 'it could not start'}).`)); };
      iw.postMessage({ n: 0, op: 'importFile', args: [bytes, name, sample] }, [bytes.buffer]);
    })).then(async read => {
      // (a book read again keeps its date and its place among the samples)
      const entry = again ? { ...read, added: again.added, sample: again.sample } : read;
      await db.changeList(lib => [...lib.filter(e => e.id !== entry.id), entry]);
      // (a book imported again is read again: the engine's copy is the old one)
      if (w) await call('forget', [entry.id]);
      return entry;
    });
    importing = run.catch(() => {});
    return run;
  };

  return {
    importFile: (bytes, name) => importIn(bytes, name, false),
    source: id => db.source(id),
    reimport: async id => {
      const src = await db.source(id);
      const old = (await db.library()).find(e => e.id === id);
      if (!src || !old) throw new Error('its file was not kept');
      return importIn(src.bytes, src.name, !!old.sample, old);
    },
    // (the sample is small, and the reading engine is starting anyway: one engine to
    // compile on a first visit, not two)
    importSample: async bytes => {
      const entry = await call<LibEntry>('importFile', [bytes, 'sample.epub', true], [bytes.buffer]);
      await db.changeList(lib => [...lib.filter(e => e.id !== entry.id), entry]);
      return entry;
    },
    open: async id => JSON.parse(await call<string>('open', [id])) as BookData,
    layout: (id, sections, p: LayoutParams) => call<ArrayBuffer>('layout', [id, sections, p]),
    remove: async id => { await db.removeBook(id); if (w) await call('forget', [id]); },
    find: (id, query, limit) => call<Uint32Array>('find', [id, query, limit]),
    searchLibrary: query => call<BookHits[]>('searchLibrary', [query]),
    fetched: async () => (w ? call<string[]>('fetched', []) : []),
    place: (id, anchors) => call<Placed[]>('place', [id, anchors]),
    fontNeeds: (id, family) => call<{ fallback: string; pre: boolean }>('fontNeeds', [id, family]),
    library: db.library,
    cover: db.cover,
    setCover: db.setCover,
    imageURL: async (id, idx) => {
      const key = `${id}/${idx}`;
      let u = imageURLs.get(key);
      if (!u) {
        u = db.image(id, idx).then(v => (v ? URL.createObjectURL(new Blob([v.bytes], { type: v.mime })) : ''));
        imageURLs.set(key, u);
      }
      return u;
    },
    probe: (p, texts) => call<number[]>('probe', [p, texts]),
    setImageSizes: (id, sizes) => call<void>('setImageSizes', [id, sizes.flat()]),
    annotateDocx: async (docx, notes) => {
      const r = await call<{ bytes: Uint8Array; report: string }>('annotateDocx', [docx, JSON.stringify(notes)]);
      return { bytes: r.bytes, ...JSON.parse(r.report) };
    },
    imageBytes: async (id, idx) => (await db.image(id, idx))?.bytes ?? new ArrayBuffer(0),
    loadFamily: name => call<FamilyLoad>('loadFamily', [name]),
    faultForTest: () => call<void>('faultForTest', []),
    memory: async () => (w ? call<{ wasm: number }>('memory', []) : { wasm: 0 }),
    /** No book is open: the engine ends after a while unless asked for something. */
    idle: (ms: number = IDLE_MS) => {
      idleAt = Date.now() + ms;
      clearTimeout(idleT);
      idleT = window.setTimeout(endIdle, ms);
    },
    running: () => !!w,
  };
}

/** Adds the sample book on first run, and again if it predates covers. */
export async function seedSample(core: ReturnType<typeof webCore>) {
  const lib = await core.library();
  if (lib.length && !lib.some(e => e.sample && !e.cover)) return;
  const bytes = new Uint8Array(await (await fetch('/sample.epub')).arrayBuffer());
  await core.importSample(bytes);
}
