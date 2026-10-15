<script lang="ts">
  import { onMount } from 'svelte';
  import { ui, type Reader } from '../reader/reader.svelte';
  import { noteHTML } from '../reader/render';

  /** A book's footnote or endnote, beside its marker, in the book's own type. Esc or a
   *  click elsewhere closes it; G or Enter goes to where the note is printed. */
  let { reader }: { reader: Reader } = $props();
  let card: HTMLElement;
  const n = $derived(ui.bookNote!);
  const note = $derived(reader.book!.notes[n.i]);
  const home = $derived(reader.noteHome(n.i));
  const W = 380;
  const left = $derived(Math.max(12, Math.min(n.x - W / 2, reader.stage.clientWidth - W - 12)));

  function close() { ui.bookNote = null; }
  function goHome() { const k = home; if (k != null) { close(); reader.travelTo(k); } }
  onMount(() => {
    const away = (e: PointerEvent) => { if (!card.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
      else if ((e.key === 'g' || e.key === 'Enter') && home != null) { e.preventDefault(); e.stopImmediatePropagation(); goHome(); }
    };
    setTimeout(() => window.addEventListener('pointerdown', away, true));
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', key, true); };
  });
</script>

<div class="bn lift r12" class:below={n.below} bind:this={card} style="left:{left}px;top:{n.y}px;width:{W}px" role="dialog" aria-label="Note {note.label}">
  <header>
    <span class="lab">Note {note.label}</span>
    {#if home != null}<button onclick={goHome}>Go to note <kbd>G</kbd></button>{/if}
  </header>
  <div class="body">{@html noteHTML(note.t, note.r)}</div>
</div>

<style>
  .bn {
    position: absolute; z-index: 30; box-sizing: border-box; max-width: calc(100% - 24px);
    background: var(--paper); color: var(--ink); border: 1px solid var(--rule); border-radius: 12px;
    transform: translateY(-100%); animation: in .16s ease-out;
  }
  .bn.below { transform: none; }
  @keyframes in { from { opacity: 0; } }
  header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px 0; }
  .lab { font: 600 13px/1.2 var(--f-ui); color: var(--ink-3); }
  button { appearance: none; border: 0; background: none; cursor: pointer; font: 600 13px/1 var(--f-ui); color: var(--accent); padding: 4px 2px; }
  button kbd { font-size: 10.5px; padding: 1px 4px; opacity: .55; }
  .body {
    max-height: min(46vh, 420px); overflow-y: auto; overflow-x: hidden; touch-action: pan-y; overscroll-behavior: contain; padding: 6px 14px 14px; border-radius: 0 0 12px 12px;
    font: var(--wb, 400) calc(var(--fs) * 0.88)/1.45 var(--f-text, var(--f-book)); font-variation-settings: var(--fvs, "wght" 400,) "opsz" 14, "wght" var(--wb, 400);
    font-synthesis: none; hyphens: auto;
  }
  .body :global(p) { margin: 0; }
  .body :global(p + p) { margin-top: 0.5em; }
  .body :global(sup) { font-size: 0.7em; line-height: 0; }
</style>
