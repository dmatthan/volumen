// The web build's library in IndexedDB, read and written by the page (the library, its
// covers and images: nothing there needs the engine) and by the engine's workers (books
// as they are imported and opened).
import type { LibEntry } from './types';

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((res, rej) => {
    // (4: each book's file kept, `sources`, to be read again by a later importer)
    const q = indexedDB.open('volumen', 4);
    q.onupgradeneeded = () => {
      const d = q.result;
      for (const s of ['books', 'meta', 'covers', 'images', 'sources']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
    };
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  }));
}

export async function tx<T>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const r = f(t.objectStore(store));
    t.oncomplete = () => res(r.result);
    t.onerror = () => rej(t.error);
  });
}

export async function library(): Promise<LibEntry[]> {
  return (await tx<LibEntry[] | undefined>('meta', 'readonly', s => s.get('library'))) || [];
}

/** Changes to the library's list, one at a time (made only by the page: two imports at
 *  once each read the list and wrote it back, and one was lost). */
let listLock: Promise<unknown> = Promise.resolve();
export function changeList(f: (lib: LibEntry[]) => LibEntry[]): Promise<void> {
  const r = listLock.then(async () => { const next = f(await library()); await tx('meta', 'readwrite', s => s.put(next, 'library')); });
  listLock = r.catch(() => {});
  return r;
}

export async function cover(id: string): Promise<ArrayBuffer> {
  const c = await tx<Uint8Array | undefined>('covers', 'readonly', s => s.get(id));
  return c ? c.slice().buffer : new ArrayBuffer(0);
}

export async function setCover(id: string, bytes: ArrayBuffer) {
  await tx('covers', 'readwrite', s => s.put(new Uint8Array(bytes), id));
}

export async function image(id: string, idx: number) {
  const v = await tx<{ mime: string; bytes: Uint8Array } | undefined>('images', 'readonly', s => s.get(`${id}/${idx}`));
  return v ? { mime: v.mime, bytes: v.bytes.slice().buffer } : null;
}

/** A book's file as added, and its name (which tells its kind). */
export async function source(id: string) {
  return (await tx<{ name: string; bytes: Uint8Array } | undefined>('sources', 'readonly', s => s.get(id))) ?? null;
}

/** A book and everything kept with it: its model, cover, images, file, its place in the list. */
export async function removeBook(id: string) {
  await tx('books', 'readwrite', s => s.delete(id));
  await tx('sources', 'readwrite', s => s.delete(id));
  await tx('covers', 'readwrite', s => s.delete(id));
  await tx('images', 'readwrite', s => s.delete(IDBKeyRange.bound(`${id}/`, `${id}/￿`)));
  await changeList(lib => lib.filter(e => e.id !== id));
}
