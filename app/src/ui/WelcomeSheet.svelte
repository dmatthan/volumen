<script lang="ts">
  import Sheet from './Sheet.svelte';
  import { ui, type Reader } from '../reader/reader.svelte';
  import { kv } from '../core/kv';

  /** A book that arrived by link, opened for the first time: who sent it, and the two
   *  things a reader asked for notes needs to know. Once per book. */
  let { reader }: { reader: Reader } = $props();
  const touch = document.documentElement.classList.contains('touchui');
  // svelte-ignore state_referenced_locally
  const by = ui.welcome?.by ?? '';

  function close() {
    ui.sheet = null; ui.welcome = null;
    // (what the select hint would say, said already)
    const seen = kv.get<string[]>('hints', []);
    if (!seen.includes('select')) kv.set('hints', [...seen, 'select']);
  }
</script>

<Sheet label="A book sent to you" onclose={close} onkey={e => { if (e.key === 'Enter') { close(); return true; } return false; }}>
  <div>
    <p class="eyebrow">{by ? `Sent to you by ${by}` : 'Sent to you'}</p>
    <h2>{reader.book?.title}</h2>
  </div>
  <ul class="how">
    {#if touch}
      <li>Hold a word to select it, drag to take more, then choose a colour. Tap a highlight to add a note.</li>
      <li>Your notes stay on this device until you send them: the map, then Notebook, then Send my notes.</li>
    {:else}
      <li>Hold on a word and drag to select; then 1–4 highlights it, N adds a note.</li>
      <li>Your notes stay on this device until you send them: M, then Notebook, then Send my notes.</li>
    {/if}
    <li>How far you have read goes with them; you can turn that off when you send.</li>
  </ul>
  <div class="acts"><button class="btn primary" data-autofocus onclick={close}>Start reading {#if !touch}<kbd>Enter</kbd>{/if}</button></div>
</Sheet>

<style>
  .how { margin: 0; padding: 0 0 0 1.1em; display: grid; gap: 8px; font: 500 var(--t-m)/1.45 var(--f-ui); color: var(--ink-2); }
</style>
