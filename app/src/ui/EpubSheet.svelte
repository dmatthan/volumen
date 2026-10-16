<script lang="ts">
  import Sheet from './Sheet.svelte';
  import { toast } from '../state.svelte';
  import { shell } from '../core/shell';
  import type { Core, LibEntry } from '../core/types';

  /** A book as an EPUB file (crates/ingest/src/write.rs): all of it (a Word or Markdown
   *  manuscript as an EPUB), or some chapters, a sample to put online, so that the whole
   *  book never has to be. */
  let { core, book, onclose }: { core: Core; book: LibEntry; onclose: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const n = Math.max(1, book.chapters);
  let from = $state(1), to = $state(n), busy = $state(false);
  const whole = $derived(from <= 1 && to >= n);
  const ok = $derived(Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to >= from && from <= n);
  async function save() {
    if (!ok) return;
    busy = true;
    try {
      const src = await core.source(book.id);
      if (!src) { toast('This book’s file was not kept: add it again, then save it.', 5200); return; }
      const bytes = await core.epubOf(src.bytes, src.name, from, Math.min(to, n));
      const base = book.title.replace(/[\\/:*?"<>|]+/g, ' ').trim();
      const name = whole ? `${base}.epub` : `${base} — ${from === to ? `chapter ${from}` : `chapters ${from} to ${Math.min(to, n)}`}.epub`;
      if (await shell.saveBytes(name, bytes)) { toast(whole ? 'Saved as an EPUB.' : 'Saved the sample: only these chapters are in it.', 4200); onclose(); }
    } catch (e) { toast(`It could not be saved as an EPUB: ${(e as Error).message}`, 6000); }
    finally { busy = false; }
  }
</script>

<Sheet label="Save as EPUB" {onclose}>
  <div>
    <p class="eyebrow">Save as EPUB</p>
    <h2>{book.title}</h2>
    <p class="where">The whole book, or some chapters as a sample to put online: the file holds only those, so the rest of the book never leaves your hands.</p>
  </div>
  <div class="range">
    <label>Chapters from <input type="number" min="1" max={n} bind:value={from} /></label>
    <label>to <input type="number" min="1" max={n} bind:value={to} /></label>
    <span class="of">of {n}</span>
  </div>
  <div class="acts two">
    <button class="btn" onclick={onclose}>Not now <kbd>Esc</kbd></button>
    <button class="btn primary" disabled={busy || !ok} onclick={save}>{busy ? 'Saving…' : whole ? 'Save the book' : 'Save the sample'}</button>
  </div>
</Sheet>

<style>
  .range { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; font: 600 var(--t-m)/1 var(--f-ui); color: var(--ink-2); }
  .range label { display: inline-flex; align-items: center; gap: 8px; }
  .range input { width: 4.5em; height: 42px; box-sizing: border-box; border: 1.5px solid var(--rule); border-radius: var(--r-m); background: var(--surface); color: var(--ink); font: 500 var(--t-m)/1 var(--f-ui); padding: 0 10px; }
  .of { color: var(--ink-3); font-weight: 500; }
</style>
