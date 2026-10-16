/** What arrives by address: a book sent as a link, an invitation to share. */
import type { Core } from '../core/types';
import { kv } from '../core/kv';
import { linkOf, canSeal, unseal } from '../core/share';
import { fetchSealed, joinedOf } from '../core/service';
import { ui, toast } from '../state.svelte';
import type { Reader } from '../reader/reader.svelte';

/** A book sent as a link (core/share.ts): fetched, opened with the key in the link, added
 *  and opened; the key is taken out of the address at once (history, a shared screen).
 *  An invitation to share books (scripts/service.sh) is taken out of it too. */
export async function openFromLink(core: Core, reader: Reader) {
  const inv = /^#invite=([\w-]{22,64})$/.exec(location.hash);
  if (inv) {
    history.replaceState(history.state, '', location.pathname + location.search);
    if (ui.view === 'reader') reader.close();
    ui.invite = inv[1];
    ui.sheet = 'invite';
    return;
  }
  const l = linkOf(location.hash);
  if (!l) return;
  history.replaceState(history.state, '', location.pathname + location.search);
  if (!canSeal()) { toast('A book sent as a link opens only over https.', 6000); return; }
  toast('Opening the book you were sent…', 15000);
  try {
    let sealed: Uint8Array;
    if (l.at === 'service') sealed = await fetchSealed(l.id);
    else {
      const r = await fetch(l.url);
      if (!r.ok) throw new Error(`it is not where the link says (${r.status})`);
      sealed = new Uint8Array(await r.arrayBuffer());
    }
    const f = await unseal(sealed, l.key);
    if (typeof f === 'string') { toast(f, 6000); return; }
    const e = await core.importFile(f.bytes, f.name);
    // (a writer opening their own link is not one of its readers)
    const own = !!kv.get('share.' + e.id, null);
    if (l.at === 'service' && !own) kv.set('joined.' + e.id, { ...(joinedOf(e.id) ?? {}), id: l.id, key: l.key });
    ui.libVersion++;
    ui.toastOn = false;
    await reader.open(e.id);
    // the first time: who sent it, and how notes are made and sent (WelcomeSheet)
    if (!own && !kv.get<number>('welcomed.' + e.id, 0)) {
      kv.set('welcomed.' + e.id, Date.now());
      ui.welcome = { by: f.by ?? '' };
      ui.sheet = 'welcome';
    }
  } catch (e) {
    toast(`Couldn’t open the book you were sent: ${(e as Error).message}`, 6000);
  }
}
