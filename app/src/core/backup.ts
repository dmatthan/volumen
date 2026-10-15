/** The whole library in one file, and back: each book's own file (read again on restore,
 *  by the importer as it is then), and everything kept about it and about the reader
 *  (places, highlights and notes, marks, collections, settings, themes, received
 *  feedback, who the reader is, so their own notes stay theirs).
 *
 *    file = "VOLBK1" | u32 manifest length | manifest JSON | each book's file, in order
 *    manifest = { v: 1, made, state: { key: value… }, books: [{ entry, name, size }] }
 */
import type { Core, LibEntry } from './types';
import { kv, flushKV } from './kv';

const MAGIC = new TextEncoder().encode('VOLBK1');

interface Manifest { v: 1; made: number; state: Record<string, unknown>; books: { entry: LibEntry; name: string; size: number }[] }

export async function backup(core: Core): Promise<{ blob: Blob; books: number; missing: string[] }> {
  const state: Record<string, unknown> = {};
  for (const k of kv.keys('')) state[k] = kv.get(k, null);
  const books: Manifest['books'] = [];
  const parts: Uint8Array[] = [];
  const missing: string[] = [];
  for (const entry of await core.library()) {
    const src = await core.source(entry.id);
    if (!src) { missing.push(entry.title); continue; }
    books.push({ entry, name: src.name, size: src.bytes.length });
    parts.push(src.bytes);
  }
  const head = new TextEncoder().encode(JSON.stringify({ v: 1, made: Date.now(), state, books } satisfies Manifest));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, head.length);
  return { blob: new Blob([MAGIC, len, head, ...parts] as BlobPart[]), books: books.length, missing };
}

export const isBackup = async (file: Blob) => {
  const b = new Uint8Array(await file.slice(0, MAGIC.length).arrayBuffer());
  return MAGIC.every((m, i) => b[i] === m);
};

/** Restores a backup into this library: books it lacks are added (read again from their
 *  files), and what was kept about them and about the reader is put back, over what is
 *  here. Returns how many books came back, or why it could not. */
export async function restore(core: Core, file: Blob): Promise<{ books: number; failed: string[] } | string> {
  if (!(await isBackup(file))) return 'This is not a Volumen backup.';
  const len = new DataView(await file.slice(MAGIC.length, MAGIC.length + 4).arrayBuffer()).getUint32(0);
  let m: Manifest;
  try { m = JSON.parse(new TextDecoder().decode(await file.slice(MAGIC.length + 4, MAGIC.length + 4 + len).arrayBuffer())); }
  catch { return 'This backup is damaged.'; }
  if (m.v !== 1) return 'This backup was made by a newer version of Volumen.';
  const have = new Set((await core.library()).map(e => e.id));
  let at = MAGIC.length + 4 + len, back = 0;
  const failed: string[] = [];
  for (const b of m.books) {
    const bytes = new Uint8Array(await file.slice(at, at + b.size).arrayBuffer());
    at += b.size;
    if (have.has(b.entry.id)) continue;
    try { await core.importFile(bytes, b.name); back++; } catch { failed.push(b.entry.title); }
  }
  for (const [k, v] of Object.entries(m.state ?? {})) if (v !== null) kv.set(k, v);
  await flushKV();
  return { books: back, failed };
}
