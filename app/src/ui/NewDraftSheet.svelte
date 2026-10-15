<script lang="ts">
  import Sheet from './Sheet.svelte';
  import { ui, toast, type Reader } from '../reader/reader.svelte';
  import { takeNewDraft, forgetState } from '../reader/draft';

  /** The writer has sent a newer draft to the link this book came by (D8): read it, with
   *  this reader's notes carried over, or later. Asked when the book opens, never while
   *  it is being read. */
  let { reader }: { reader: Reader } = $props();
  let busy = $state(false);
  // svelte-ignore state_referenced_locally
  const version = ui.newDraft ?? 0;
  function later() { ui.sheet = null; ui.newDraft = null; }
  async function take() {
    busy = true;
    try {
      const old = (await reader.core.library()).find(e => e.id === reader.book?.id);
      if (!old) return;
      const { entry, carried } = await takeNewDraft(reader.core, old, version);
      ui.sheet = null; ui.newDraft = null;
      reader.close();
      await reader.core.remove(old.id);
      forgetState(old.id);
      ui.libVersion++;
      await reader.open(entry.id);
      const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
      toast(`The new draft. ${carried.mine ? `${n(carried.mine, 'note of yours', 'notes of yours')} carried over${carried.mineLost ? `; ${carried.mineLost} on words no longer there, kept in your notebook` : ''}.` : ''}`, 6000);
    } catch (e) { toast(`The new draft could not be opened: ${(e as Error).message}`, 6000); busy = false; }
  }
</script>

<Sheet label="A new draft" onclose={later}>
  <div>
    <p class="eyebrow">A new draft</p>
    <h2>{reader.book?.title}</h2>
    <p class="where">The writer has sent a newer draft of this book. Your highlights and notes come with you, found again by their words; any whose words are gone are kept.</p>
  </div>
  <div class="acts two">
    <button class="btn" disabled={busy} onclick={later}>Later</button>
    <button class="btn primary" disabled={busy} data-autofocus onclick={take}>{busy ? 'Opening…' : 'Read the new draft'}</button>
  </div>
</Sheet>
