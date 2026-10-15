<script lang="ts">
  import Sheet from './Sheet.svelte';
  import { ui, toast } from '../reader/reader.svelte';
  import { kv } from '../core/kv';
  import { carryOver } from '../reader/draft';
  import type { Core, LibEntry } from '../core/types';

  /** A book just added that looks like a new draft of one in the library (reader/
   *  draft.ts): carry everything over to it, and keep or remove the earlier draft. */
  let { core, from, to, remove, onclose }: { core: Core; from: LibEntry; to: LibEntry; remove: (b: LibEntry) => Promise<void>; onclose: () => void } = $props();
  let busy = $state(false);
  // svelte-ignore state_referenced_locally
  const readers = Object.keys(kv.get<Record<string, unknown>>('fb.' + from.id, {})).length;
  // svelte-ignore state_referenced_locally
  const mine = kv.get<unknown[]>('ann.' + from.id, []).length;
  // svelte-ignore state_referenced_locally
  const shared = !!kv.get('share.' + from.id, null);
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const what = [readers ? `notes from ${n(readers, 'reader', 'readers')}` : '', mine ? n(mine, 'note of yours', 'notes of yours') : '', shared ? 'a share link' : ''].filter(Boolean);

  async function go(drop: boolean) {
    busy = true;
    try {
      const c = await carryOver(core, from, to);
      if (drop) await remove(from);
      const said = [
        c.readers ? `${n(c.theirs, 'reader’s note', 'readers’ notes')} from ${n(c.readers, 'reader', 'readers')}${c.theirsLost ? ` (${c.theirsLost} not found in this draft, kept)` : ''}` : '',
        c.mine ? `${n(c.mine, 'note of yours', 'notes of yours')}${c.mineLost ? ` (${c.mineLost} not found)` : ''}` : '',
        c.shared ? 'the share link' : '',
      ].filter(Boolean);
      toast(`Carried over to the new draft: ${said.join(', ') || 'nothing to carry'}.`, 6400);
      ui.libVersion++;
      onclose();
    } catch (e) { toast(`Could not carry it over: ${(e as Error).message}`, 6000); }
    finally { busy = false; }
  }
</script>

<Sheet label="A new draft" onclose={onclose}>
  <div>
    <p class="eyebrow">A new draft?</p>
    <h2>{to.title}</h2>
    <p class="where">This book is in your library already, with {what.join(', ')}. The file you added can take its place: everything comes with it, found again by its words; what is not found is kept, marked as on the earlier draft.</p>
  </div>
  <div class="acts">
    <button class="btn primary" disabled={busy} data-autofocus onclick={() => go(true)}>{busy ? 'Carrying over…' : 'Carry over, and remove the earlier draft'}</button>
    <button class="btn" disabled={busy} onclick={() => go(false)}>Carry over, keep both</button>
    <button class="btn quiet" disabled={busy} onclick={onclose}>Keep them apart</button>
  </div>
</Sheet>
