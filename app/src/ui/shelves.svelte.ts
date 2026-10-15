import { kv } from '../core/kv';
import type { LibEntry } from '../core/types';

/** A collection the reader makes and names; a book may be in any number of them. */
export interface Collection { id: string; name: string; books: string[] }

/** The shelves above the library: three that fill themselves, then the reader's own. */
export const SMART = [
  { id: 'all', name: 'All' },
  { id: 'reading', name: 'Reading now' },
  { id: 'finished', name: 'Finished' },
  { id: 'new', name: 'Not started' },
] as const;

export const shelves = $state({ list: [] as Collection[], loaded: false });

/** Read once the per-user store is ready (it is not when this module loads). */
export function loadShelves() {
  if (shelves.loaded) return;
  shelves.list = kv.get<Collection[]>('collections', []);
  shelves.loaded = true;
}
const save = () => kv.set('collections', $state.snapshot(shelves.list));

export function createShelf(name: string): Collection | null {
  name = name.trim().replace(/\s+/g, ' ');
  if (!name) return null;
  const have = shelves.list.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (have) return have;
  const c: Collection = { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, books: [] };
  shelves.list.push(c);
  save();
  return c;
}
export function renameShelf(id: string, name: string) {
  const c = shelves.list.find(c => c.id === id);
  name = name.trim().replace(/\s+/g, ' ');
  if (!c || !name) return;
  c.name = name;
  save();
}
export function deleteShelf(id: string) {
  shelves.list = shelves.list.filter(c => c.id !== id);
  save();
}
/** Puts a book in a collection, or takes it out. */
export function toggleShelf(id: string, book: string) {
  const c = shelves.list.find(c => c.id === id);
  if (!c) return;
  c.books = c.books.includes(book) ? c.books.filter(b => b !== book) : [...c.books, book];
  save();
}
export function addToShelf(id: string, book: string) {
  const c = shelves.list.find(c => c.id === id);
  if (c && !c.books.includes(book)) { c.books = [...c.books, book]; save(); }
}
/** A book leaving the library leaves its collections too. */
export function forgetBook(book: string) {
  let changed = false;
  for (const c of shelves.list) if (c.books.includes(book)) { c.books = c.books.filter(b => b !== book); changed = true; }
  if (changed) save();
}

/** Where a book stands: never opened, being read, or finished. */
export function stateOf(b: LibEntry): 'new' | 'reading' | 'finished' {
  const s = kv.get<{ done: boolean } | null>('state.' + b.id, null);
  return !s ? 'new' : s.done ? 'finished' : 'reading';
}

export function onShelf(shelf: string, b: LibEntry): boolean {
  if (shelf === 'all') return true;
  if (shelf === 'reading' || shelf === 'finished' || shelf === 'new') return stateOf(b) === shelf;
  return !!shelves.list.find(c => c.id === shelf)?.books.includes(b.id);
}
