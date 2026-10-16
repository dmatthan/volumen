<script lang="ts">
  import Sheet from './Sheet.svelte';
  import { type Reader } from '../reader/reader.svelte';
  import { ui } from '../state.svelte';
  import { chapTitle } from '../reader/render';

  let { reader }: { reader: Reader } = $props();
  // svelte-ignore state_referenced_locally
  const a = reader.ann?.list.find(x => x.id === ui.noteFor);
  let text = $state(a?.note ?? '');
  let ta: HTMLTextAreaElement | undefined = $state();
  $effect(() => { ta?.focus(); });
  // svelte-ignore state_referenced_locally
  const where = a ? chapTitle(reader.book!, reader.strip!.keyIndex.get(a.key)?.[0] ?? 0) : '';

  function done() { if (a) reader.setNote(a.id, text.trim()); ui.sheet = null; ui.noteFor = ''; }
  function removeAll() { if (a) reader.unhighlight(a.id); ui.sheet = null; ui.noteFor = ''; }
  function keys(e: KeyboardEvent) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done(); } }
</script>

<Sheet label="Note" onclose={done} wide>
  <div><p class="eyebrow">{where}</p><h2>Note</h2></div>
  {#if a}<blockquote class="q h{a.color}">{a.quote}</blockquote>{/if}
  <textarea bind:this={ta} bind:value={text} onkeydown={keys} rows="6" placeholder="Your thoughts. Markdown is fine."></textarea>
  <div class="acts two">
    <button class="btn quiet" onclick={removeAll}>Remove highlight</button>
    <button class="btn primary" onclick={done}>Done <kbd>Ctrl+Enter</kbd></button>
  </div>
</Sheet>

<style>
  .q { margin: 0; padding: 12px 14px; border-radius: var(--r-m); font: 400 17px/1.55 var(--f-book); color: var(--ink); max-height: 9em; overflow: auto; }
  .q.h1 { background: var(--hl1); } .q.h2 { background: var(--hl2); } .q.h3 { background: var(--hl3); } .q.h4 { background: var(--hl4); }
  textarea { box-sizing: border-box; width: 100%; resize: vertical; min-height: 8em; border: 1.5px solid var(--rule); border-radius: var(--r-m); background: var(--surface); color: var(--ink); font: 500 var(--t-m)/1.55 var(--f-ui); padding: 12px 14px; outline: none; }
  textarea:focus { border-color: var(--accent); }
</style>
