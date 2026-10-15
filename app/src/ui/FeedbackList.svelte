<script lang="ts">
  import type { Reader } from '../reader/reader.svelte';
  import { ui } from '../reader/reader.svelte';
  import { fold } from '../reader/notebook';

  /** Other readers' notes on this book, gathered by passage: the words, then every
   *  reader's say on them, in reading order. A reader's chip shows or hides their notes
   *  everywhere (here, in the text, in the gutter). */
  let { reader, filter, go }: { reader: Reader; filter: string; go: (key: string, s: number) => void } = $props();
  // svelte-ignore state_referenced_locally
  const fb = reader.fb!;
  let version = $state(0);
  const readers = $derived.by(() => { version; ui.annVersion; return fb.list(); });
  const groups = $derived.by(() => {
    version; ui.annVersion;
    const words = fold(filter).split(/\s+/).filter(Boolean);
    const all = fb.gathered();
    return words.length ? all.filter(g => { const h = fold(g.quote + ' ' + g.where + ' ' + g.voices.map(v => `${v.reader} ${v.note ?? ''}`).join(' ')); return words.every(w => h.includes(w)); }) : all;
  });
  function toggle(id: string) {
    fb.toggle(id);
    version++;
    for (const [k] of reader.surface.rendered()) reader.surface.refresh(k);
  }
  /** Removing a reader's notes takes a second press (the × becomes "Remove"). */
  let confirming = $state('');
  function remove(id: string) {
    if (confirming !== id) { confirming = id; return; }
    confirming = '';
    fb.remove(id);
    version++;
    for (const [k] of reader.surface.rendered()) reader.surface.refresh(k);
  }
  const kindLabel = { highlight: '', mark: 'Marked this paragraph' } as const;
</script>

<div class="fbl">
  <div class="who" role="group" aria-label="Readers">
    {#each readers as r (r.id)}
      <span class="rd" class:off={fb.hidden.has(r.id)} style="--rc:var(--r{r.colour})">
        <button class="chip" aria-pressed={!fb.hidden.has(r.id)} onclick={() => toggle(r.id)} title={fb.hidden.has(r.id) ? 'Show their notes' : 'Hide their notes'}>
          <span class="sw" aria-hidden="true"></span>{r.name}<span class="n">{r.count}</span>
        </button>
        <button class="x" class:sure={confirming === r.id} onclick={() => remove(r.id)} onblur={() => confirming === r.id && (confirming = '')} aria-label="Remove {r.name}’s notes">{confirming === r.id ? 'Remove' : '×'}</button>
      </span>
    {/each}
  </div>
  {#if readers.some(r => r.lost)}
    <p class="lost">{readers.filter(r => r.lost).map(r => `${r.lost} of ${r.name}’s`).join(', ')} {readers.reduce((n, r) => n + r.lost, 0) === 1 ? 'is' : 'are'} on words no longer in this version, and not shown.</p>
  {/if}
  {#if !groups.length}
    <p class="empty">{filter ? `Nothing matches “${filter}”.` : 'Every reader is hidden.'}</p>
  {/if}
  {#each groups as g, i (g.key + ':' + g.s + ':' + i)}
    {#if i === 0 || groups[i - 1].sec !== g.sec}<h3 class="ch">{g.where}</h3>{/if}
    <button class="grp" onclick={() => go(g.key, g.s)}>
      {#if g.quote}<span class="q">{g.quote}</span>{/if}
      {#each g.voices as v}
        <span class="v" style="--rc:var(--r{v.colour})">
          <span class="nm">{v.reader}</span>
          {#if v.note}<span class="t">{v.note}</span>{:else if kindLabel[v.kind]}<span class="t k">{kindLabel[v.kind]}</span>{:else}<span class="t k">Highlighted</span>{/if}
          {#if v.was}<span class="was">on earlier words: “{v.was}”</span>{/if}
        </span>
      {/each}
    </button>
  {/each}
</div>

<style>
  .fbl { display: grid; gap: 14px; }
  .who { display: flex; flex-wrap: wrap; gap: 8px; }
  .rd { display: inline-flex; align-items: center; border: 1.5px solid var(--rule); border-radius: 18px; padding-right: 2px; }
  .rd.off { opacity: .5; }
  .chip { appearance: none; border: 0; background: none; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 6px 0 12px; font: 600 var(--t-s)/1 var(--f-ui); color: var(--ink); }
  .sw { width: 10px; height: 10px; border-radius: 50%; background: var(--rc); }
  .rd.off .sw { background: none; box-shadow: inset 0 0 0 2px var(--rc); }
  .n { font: 600 13px/1 var(--f-ui); color: var(--ink-3); font-variant-numeric: tabular-nums; }
  .x { appearance: none; border: 0; background: none; cursor: pointer; width: 28px; height: 28px; border-radius: 14px; color: var(--ink-3); font: 500 18px/1 var(--f-ui); }
  :global(html:not(.touchui)) .x:hover { background: var(--hover); color: var(--ink); }
  .x.sure { width: auto; padding: 0 10px; font: 650 12.5px/1 var(--f-ui); color: var(--ink); background: var(--hover); }
  .lost, .empty { margin: 0; font: 500 var(--t-s)/1.5 var(--f-ui); color: var(--ink-3); }
  .ch { margin: 8px 0 -6px; font: 650 var(--t-s)/1.3 var(--f-ui); color: var(--ink-3); }
  .grp { all: unset; box-sizing: border-box; cursor: pointer; display: grid; gap: 8px; padding: 8px 12px; border-radius: var(--r-s); }
  :global(html:not(.touchui)) .grp:hover { background: var(--hover); }
  .grp:focus-visible { outline: 2px solid var(--focus); outline-offset: 0; }
  .q { font: 400 17px/1.55 var(--f-book); color: var(--ink); display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
  .v { display: grid; gap: 2px; padding-left: 12px; border-left: 3px solid var(--rc); }
  .nm { font: 650 12.5px/1.2 var(--f-ui); color: var(--rc); }
  .t { font: 500 var(--t-m)/1.45 var(--f-ui); color: var(--ink); white-space: pre-wrap; }
  .t.k { color: var(--ink-3); font-size: var(--t-s); }
  .was { font: 500 12.5px/1.4 var(--f-ui); color: var(--ink-3); font-style: italic; }
</style>
