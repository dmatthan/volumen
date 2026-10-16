<script lang="ts">
  import type { Reader } from '../reader/reader.svelte';
  import { ui } from '../state.svelte';
  import { fold } from '../reader/notebook';
  import { REACTION_LABEL } from '../reader/annotations';

  /** Other readers' notes on this book, gathered by passage: the words, then every
   *  reader's say on them, in reading order. A reader's chip shows or hides their notes
   *  everywhere (here, in the text, in the gutter). */
  let { reader, filter, go }: { reader: Reader; filter: string; go: (key: string, s: number) => void } = $props();
  // svelte-ignore state_referenced_locally
  const fb = reader.fb!;
  let version = $state(0);
  const readers = $derived.by(() => { version; ui.annVersion; return fb.list(); });
  const reactions = $derived.by(() => { version; ui.annVersion; return fb.reactions(); });
  /** Reading order, or the passages most readers stopped at first (where it matters
   *  most); all, or only those not yet dealt with. Kept for the session. */
  let order: 'book' | 'most' = $state('book');
  let openOnly = $state(false);
  const groups = $derived.by(() => {
    version; ui.annVersion;
    const words = fold(filter).split(/\s+/).filter(Boolean);
    let all = fb.gathered().map(g => ({ ...g, readers: new Set(g.voices.map(v => v.rid)).size, st: fb.status[fb.passageId(g)] }));
    if (words.length) all = all.filter(g => { const h = fold(g.quote + ' ' + g.where + ' ' + g.voices.map(v => `${v.reader} ${v.note ?? ''}`).join(' ')); return words.every(w => h.includes(w)); });
    if (openOnly) all = all.filter(g => !g.st);
    if (order === 'most') all = all.map((g, i) => ({ g, i })).sort((a, b) => b.g.readers - a.g.readers || a.i - b.i).map(x => x.g);
    return all;
  });
  function mark(g: { key: string; s: number; st?: string }, st: 'done' | 'wont') {
    fb.setStatus(g, g.st === st ? null : st);
    version++;
  }
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
  {#if readers.some(r => r.progress)}
    <!-- how far each reader got (D7), as they last sent it -->
    <p class="far">{readers.filter(r => r.progress).map(r => r.progress!.done ? `${r.name} finished it` : `${r.name} has read ${Math.round(r.progress!.furthest * 100)}%${r.progress!.where ? `, and is at ${r.progress!.where}` : ''}`).join('; ')}.</p>
  {/if}
  {#if reactions.length}
    <!-- the readers' reactions (D6), counted -->
    <p class="far">{reactions.map(([r, n]) => `${REACTION_LABEL[r]} ${n}`).join(' · ')}</p>
  {/if}
  {#if readers.some(r => r.lost)}
    <p class="lost">{readers.filter(r => r.lost).map(r => `${r.lost} of ${r.name}’s`).join(', ')} {readers.reduce((n, r) => n + r.lost, 0) === 1 ? 'is' : 'are'} on words no longer in this version, and not shown.</p>
  {/if}
  {#if !groups.length}
    <p class="empty">{filter ? `Nothing matches “${filter}”.` : 'Every reader is hidden.'}</p>
  {/if}
  {#if readers.length}
    <div class="ctl">
      <div class="seg" role="group" aria-label="Order">
        <button aria-pressed={order === 'book'} onclick={() => (order = 'book')}>In reading order</button>
        <button aria-pressed={order === 'most'} onclick={() => (order = 'most')}>Most readers first</button>
      </div>
      <span class="r">
        <button class="tg" aria-pressed={openOnly} onclick={() => (openOnly = !openOnly)}>Open only</button>
        <button class="tg" onclick={() => (ui.sheet = 'fbexport')}>Export…</button>
      </span>
    </div>
  {/if}
  {#each groups as g, i (g.key + ':' + g.s + ':' + i)}
    {#if order === 'book' && (i === 0 || groups[i - 1].sec !== g.sec)}<h3 class="ch">{g.where}</h3>{/if}
    <div class="pas" class:settled={!!g.st}>
      <button class="grp" onclick={() => go(g.key, g.s)}>
        {#if order === 'most'}<span class="wh">{g.where}{g.readers > 1 ? ` · ${g.readers} readers` : ''}</span>{/if}
        {#if g.quote}<span class="q">{g.quote}</span>{/if}
        {#each g.voices as v}
          <span class="v" style="--rc:var(--r{v.colour})">
            <span class="nm">{v.reader}</span>
            {#if v.react}<span class="t re">{REACTION_LABEL[v.react]}</span>{/if}
            {#if v.note}<span class="t">{v.note}</span>{:else if kindLabel[v.kind]}<span class="t k">{kindLabel[v.kind]}</span>{:else if !v.react}<span class="t k">Highlighted</span>{/if}
            {#if v.was}<span class="was">on earlier words: “{v.was}”</span>{/if}
          </span>
        {/each}
      </button>
      <div class="st" role="group" aria-label="This passage">
        <button aria-pressed={g.st === 'done'} onclick={() => mark(g, 'done')}>Done</button>
        <button aria-pressed={g.st === 'wont'} onclick={() => mark(g, 'wont')}>Won’t change</button>
      </div>
    </div>
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
  .x.sure { width: auto; padding: 0 10px; font: 650 13px/1 var(--f-ui); color: var(--ink); background: var(--hover); }
  .far, .lost, .empty { margin: 0; font: 500 var(--t-s)/1.5 var(--f-ui); color: var(--ink-3); }
  .ch { margin: 8px 0 -6px; font: 650 var(--t-s)/1.3 var(--f-ui); color: var(--ink-3); }
  .grp { all: unset; box-sizing: border-box; cursor: pointer; display: grid; gap: 8px; padding: 8px 12px; border-radius: var(--r-s); }
  :global(html:not(.touchui)) .grp:hover { background: var(--hover); }
  .grp:focus-visible { outline: 2px solid var(--focus); outline-offset: 0; }
  .q { font: 400 17px/1.55 var(--f-book); color: var(--ink); display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
  .v { display: grid; gap: 2px; padding-left: 12px; border-left: 3px solid var(--rc); }
  .nm { font: 650 13px/1.2 var(--f-ui); color: var(--rc); }
  .ctl { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
  .seg { display: inline-flex; border: 1.5px solid var(--rule); border-radius: var(--r-m); overflow: hidden; }
  .seg button, .tg, .st button { appearance: none; border: 0; background: none; cursor: pointer; font: 600 13px/1 var(--f-ui); color: var(--ink-2); padding: 0 12px; min-height: 34px; }
  .seg button[aria-pressed="true"], .tg[aria-pressed="true"] { background: var(--wash); color: var(--accent); }
  .tg { border: 1.5px solid var(--rule); border-radius: var(--r-m); }
  .ctl .r { display: inline-flex; gap: 8px; }
  .pas { display: grid; gap: 2px; }
  .pas.settled .grp { opacity: .55; }
  .wh { font: 600 13px/1.3 var(--f-ui); color: var(--ink-3); }
  .st { display: flex; gap: 4px; padding-left: 8px; }
  .st button { min-height: 30px; padding: 0 8px; border-radius: var(--r-s); color: var(--ink-3); }
  .st button[aria-pressed="true"] { color: var(--accent); background: var(--wash); }
  :global(html:not(.touchui)) .st button:hover { color: var(--ink); background: var(--hover); }
  .t { font: 500 var(--t-m)/1.45 var(--f-ui); color: var(--ink); white-space: pre-wrap; }
  .t.k { color: var(--ink-3); font-size: var(--t-s); }
  .t.re { color: var(--rc, var(--accent)); font-weight: 650; font-size: var(--t-s); }
  .was { font: 500 13px/1.4 var(--f-ui); color: var(--ink-3); font-style: italic; }
</style>
