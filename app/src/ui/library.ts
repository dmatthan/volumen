/** What the library does with its books, apart from showing them (Library.svelte). */
import type { Core, LibEntry } from '../core/types';
import { kv } from '../core/kv';
import { isTauri } from '../core/shell';
import { isSafari, isInstalled } from '../core/env';
import { embedded } from '../core/embed';
import { syncShares, hasVault, sharedOf, service, withdraw } from '../core/service';
import { ui, toast } from '../state.svelte';
import { forgetBookState } from '../reader/bookstate';
import { collectNotes } from '../reader/intake';
import { hint } from '../reader/hints';
import { stale, reread } from '../reader/reread';
import { forgetBook } from './shelves.svelte';

/** A book gone from the library: its link withdrawn first if it is shared (or readers
 *  would go on sending notes to it, and the writer's other devices bring it back), then
 *  its files, what is kept about it, its collections. A link that cannot be withdrawn
 *  (offline, signed out) leaves the book as it was, and the error says why. */
export async function removeBook(core: Core, id: string) {
  if (sharedOf(id) && (await service())) await withdraw(id);
  await core.remove(id);
  forgetBookState(id);
  forgetBook(id);
}

/** The library kept for good: a browser may clear a site's storage when it is short of
 *  room, and Safari clears it after some days unvisited unless the site is installed.
 *  Asked once a book of one's own is added (Firefox asks the person; Chrome and Safari
 *  decide by themselves); where it is not granted in Safari, said once how to keep it. */
let keepAsked = false;
export async function keepLibrary() {
  if (keepAsked || isTauri || embedded || !navigator.storage?.persist) return;
  keepAsked = true;
  if (await navigator.storage.persisted().catch(() => false)) return;
  if (await navigator.storage.persist().catch(() => false)) return;
  if (!isSafari || isInstalled()) return;
  const touch = document.documentElement.classList.contains('touchui');
  setTimeout(() => hint(touch ? 'touch-keep' : 'keep', touch
    ? 'Safari may clear this library if Volumen is not opened for a week or so. To keep it: Share, then Add to Home Screen; or back it up, at the foot of the library.'
    : 'Safari may clear this library if Volumen is not opened for a week or so. To keep it: File, then Add to Dock; or back it up, at the foot of the library.', 9000), 4000);
}

/** Readers' notes on books shared through the service, fetched when the library shows
 *  (at most every few minutes; only for a writer with shared books). */
let collectedAt = 0;
export async function collectSoon(core: Core, titleOf: (id: string) => string) {
  if (Date.now() - collectedAt < 300_000 || (!kv.keys('share.').length && !hasVault())) return;
  collectedAt = Date.now();
  // shares made on the writer's other devices (their vault) first
  const added = await syncShares(core).catch(() => 0);
  if (added) { toast(`${added} shared book${added === 1 ? '' : 's'} from your other devices added to this library.`, 5200); ui.libVersion++; }
  const got = await collectNotes().catch(() => []);
  if (!got.length) return;
  const by = new Map<string, string[]>();
  for (const g of got) by.set(g.book, [...(by.get(g.book) ?? []), g.from]);
  const said = [...by].map(([id, from]) => `${from.join(', ')} on “${titleOf(id)}”`);
  toast(`New notes from your readers: ${said.join('; ')}. Open the book to see them.`, 6400);
  ui.libVersion++;
}

/** Books read by an earlier importer are read again from their kept files, one at a time,
 *  once a session, never the one open (reader/reread.ts). */
let rereading = false, rereadDone = false;
export async function rereadStale(core: Core, list: LibEntry[], openId: () => string | undefined) {
  if (rereading || rereadDone) return;
  const todo = list.filter(b => stale(b) && b.source);
  if (!todo.length) return;
  rereading = true;
  let n = 0;
  for (const b of todo) {
    if (openId() === b.id) continue;
    try { await reread(core, b); n++; } catch { /* left as it was: tried again next session */ }
    if (openId()) break;
  }
  if (!openId()) core.idle?.();
  rereading = false; rereadDone = true;
  if (n) { toast(n === 1 ? 'A book was read again with what Volumen now understands of it.' : `${n} books were read again with what Volumen now understands of them.`, 4200); ui.libVersion++; }
}
