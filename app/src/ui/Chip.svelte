<script lang="ts">
  import { copyText } from '../core/clipboard';
  import { type Reader } from '../reader/reader.svelte';
  import { ui, toast } from '../state.svelte';
  import { chapName } from '../reader/render';
  import { REACTIONS, REACTION_LABEL, type Reaction } from '../reader/annotations';
  import { kv } from '../core/kv';

  let { reader }: { reader: Reader } = $props();
  const ann = $derived(ui.chip?.ann ? reader.ann?.list.find(a => a.id === ui.chip!.ann) ?? null : null);

  function color(c: number) {
    const chip = ui.chip; if (!chip) return;
    if (chip.ann) reader.recolor(chip.ann, c);
    else if (chip.sel) reader.highlight(chip.sel, c);
    ui.chip = null;
  }
  function note() {
    const chip = ui.chip; if (!chip) return;
    const id = chip.ann ?? (chip.sel ? reader.highlight(chip.sel, 1) : null);
    ui.chip = null;
    if (id) { ui.noteFor = id; ui.sheet = 'note'; }
  }
  async function copy() {
    const chip = ui.chip; if (!chip) return;
    const book = reader.book!;
    const text = chip.ann ? ann?.quote ?? '' : chip.sel ? reader.selText(chip.sel) : '';
    const sec = chip.sel ? chip.sel.a[0] : ann ? reader.strip!.keyIndex.get(ann.key)?.[0] ?? 0 : 0;
    toast((await copyText(`“${text}”\n— ${book.author ? book.author + ', ' : ''}${book.title}, ${chapName(book, sec)}`)) ? 'Copied with reference' : 'This browser would not copy.');
    ui.chip = null;
  }
  function remove() { if (ui.chip?.ann) reader.unhighlight(ui.chip.ann); ui.chip = null; }
  // a manuscript sent by link: the reader's quick reactions for its writer (D6)
  // (looked up each time the chip opens: the link's record is not reactive)
  const asked = $derived(!!ui.chip && !!reader.book && !!kv.get('joined.' + reader.book.id, null));
  function react(r: Reaction) {
    const chip = ui.chip; if (!chip) return;
    const id = reader.react(chip, r);
    ui.chip = null;
    const a = id ? reader.ann?.list.find(x => x.id === id) : null;
    if (a) toast(a.react ? `${REACTION_LABEL[r]}: noted for the writer.` : 'Reaction taken off.', 2400);
  }

  /** Keys while the chip is up. */
  export function key(e: KeyboardEvent): boolean {
    const k = e.key;
    if (k >= '1' && k <= '4') { color(+k); return true; }
    if (asked && k >= '5' && k <= '8') { react(REACTIONS[+k - 5]); return true; }
    if (k === 'n' || k === 'N') { note(); return true; }
    if (k === 'c' || k === 'C') { copy(); return true; }
    if ((k === 'x' || k === 'Delete' || k === 'Backspace') && ui.chip?.ann) { remove(); return true; }
    if (k === 'Escape') { ui.chip = null; return true; }
    return false;
  }
  // kept inside the window: moved sideways by what it would overhang, and below the
  // point pressed when there is no room above it
  let pop: HTMLElement | undefined = $state();
  let dx = $state(0), below = $state(false);
  $effect(() => {
    const c = ui.chip; if (!c || !pop) return;
    dx = 0; below = false;
    requestAnimationFrame(() => {
      if (!pop || matchMedia('(max-width: 640px)').matches) return;
      const host = (pop.offsetParent as HTMLElement | null)?.getBoundingClientRect() ?? { left: 0, top: 0, width: innerWidth };
      const w = pop.offsetWidth, h = pop.offsetHeight, m = 10;
      const left = host.left + c.x - w / 2;
      dx = Math.max(m - left, Math.min(0, innerWidth - m - (left + w)));
      below = host.top + c.y - h - 18 < m + 44;
    });
  });
</script>

{#if ui.chip}
  {@const c = ui.chip}
  <div class="chip-pop lift r12" bind:this={pop} style:left="{c.x}px" style:top="{c.y}px" style:--dx="{dx}px" class:below role="toolbar" aria-label="Highlight">
    {#each [1, 2, 3, 4] as n}
      <button class="dot h{n}" class:on={ann?.color === n} onclick={() => color(n)} aria-label="Highlight colour {n}"><kbd>{n}</kbd></button>
    {/each}
    <span class="sep"></span>
    <button class="act" onclick={note}>{ann?.note ? 'Edit note' : 'Note'} <kbd>N</kbd></button>
    <button class="act" onclick={copy}>Copy <kbd>C</kbd></button>
    {#if c.ann}<button class="act" onclick={remove}>Remove <kbd>X</kbd></button>{/if}
    {#if asked}
      <div class="reacts" role="group" aria-label="Tell the writer">
        {#each REACTIONS as r, i}
          <button class="act" aria-pressed={ann?.react === r} onclick={() => react(r)} title={REACTION_LABEL[r]}>{r[0].toUpperCase() + r.slice(1)} <kbd>{i + 5}</kbd></button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* above the point pressed (below it if there is no room), kept inside the window */
  .chip-pop {
    position: absolute; z-index: 20; transform: translate(calc(-50% + var(--dx, 0px)), calc(-100% - 18px));
    display: flex; align-items: center; gap: 4px; padding: 6px; border-radius: var(--r-m);
    background: var(--sheet); border: 1px solid var(--rule);
    animation: pop .16s cubic-bezier(.2,.8,.2,1); flex-wrap: wrap;
  }
  /* the reactions for a manuscript's writer (D6): a row of their own */
  .reacts { flex-basis: 100%; display: flex; justify-content: space-between; gap: 2px; border-top: 1px solid var(--rule); padding-top: 4px; margin-top: 2px; }
  .reacts .act[aria-pressed="true"] { background: var(--hover); }
  .chip-pop.below { transform: translate(calc(-50% + var(--dx, 0px)), 26px); }
  @keyframes pop { from { opacity: 0; } }
  /* a phone: a bar along the bottom, clear of the finger and of the screen's edges */
  @media (max-width: 640px) {
    .chip-pop, .chip-pop.below {
      position: fixed; left: 10px !important; right: 10px; top: auto !important; bottom: calc(10px + env(safe-area-inset-bottom));
      transform: none; justify-content: space-between; padding: 6px 8px;
    }
    .dot { width: 38px; height: 38px; }
    .act { height: 40px; padding: 0 8px; }
  }
  .dot { appearance: none; cursor: pointer; width: 34px; height: 34px; border-radius: 50%; border: 2px solid transparent; display: grid; place-items: center; }
  .dot.on { border-color: var(--ink-2); }
  .dot.h1 { background: var(--hs1); } .dot.h2 { background: var(--hs2); } .dot.h3 { background: var(--hs3); } .dot.h4 { background: var(--hs4); }
  .dot kbd { border: 0; font-size: 12px; opacity: .75; }
  .sep { width: 1px; height: 24px; background: var(--rule); margin: 0 4px; }
  .act { appearance: none; cursor: pointer; border: 0; background: none; border-radius: var(--r-s); height: 34px; padding: 0 10px; font: 600 var(--t-s)/1 var(--f-ui); color: var(--ink); display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  :global(html:not(.touchui)) .act:hover { background: var(--hover); }
</style>
