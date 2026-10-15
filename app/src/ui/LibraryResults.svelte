<script lang="ts">
  import type { BookHits, Core, LibEntry, LibHit } from '../core/types';
  import type { Reader } from '../reader/reader.svelte';

  /** Library search in the books' text: books with the most matches first, each with its
   *  first few in context. A match opens its book there, the search going on in the
   *  reader (N steps through the rest). */
  let { core, reader, query, books }: { core: Core; reader: Reader; query: string; books: LibEntry[] } = $props();
  let results: BookHits[] = $state([]);
  let pending = $state(false);
  let seq = 0, t = 0;
  let list = $state<HTMLElement>();

  $effect(() => {
    const q = query.trim();
    clearTimeout(t);
    const n = ++seq;
    if (q.length < 2) { results = []; pending = false; return; }
    pending = true;
    // a moment after typing pauses: each search reads every book's index
    t = window.setTimeout(async () => {
      const r = await core.searchLibrary(q).catch(() => [] as BookHits[]);
      if (n !== seq) return;
      results = r; pending = false;
    }, 160);
  });

  const titleOf = (id: string) => books.find(b => b.id === id);
  const shown = $derived(results.filter(r => titleOf(r.id)));
  const total = $derived(shown.reduce((n, r) => n + r.total, 0));
  const phrase = $derived(shown.every(r => r.phrase));

  function open(r: BookHits, h: LibHit) { reader.openAt(r.id, { key: h.key, off: h.s }, query.trim()); }

  /** Arrows and J K move through the matches; returns whether it handled the key. */
  export function key(e: KeyboardEvent): boolean {
    const rows = [...(list?.querySelectorAll<HTMLElement>('.hit') ?? [])];
    if (!rows.length) return false;
    const i = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'j') { rows[Math.min(rows.length - 1, i + 1)].focus(); return true; }
    if ((e.key === 'ArrowUp' || e.key === 'k') && i > 0) { rows[i - 1].focus(); return true; }
    return false;
  }
  export function focusFirst() { list?.querySelector<HTMLElement>('.hit')?.focus(); return !!list?.querySelector('.hit'); }
</script>

{#if query.trim().length >= 2}
  <section class="res" bind:this={list} aria-label="Matches in the books' text" aria-busy={pending}>
    <h2>In the text
      <span class="sum">{#if pending && !shown.length}Searching…{:else if !shown.length}Nothing found{:else}{total} {phrase ? (total === 1 ? 'match' : 'matches') : `paragraph${total === 1 ? '' : 's'} with every word`} in {shown.length} book{shown.length === 1 ? '' : 's'}{/if}</span>
    </h2>
    {#each shown as r (r.id)}
      {@const b = titleOf(r.id)!}
      <div class="bk">
        <h3><span class="bt">{b.title}</span>{#if b.author}<span class="ba">{b.author}</span>{/if}<span class="n">{r.total}</span></h3>
        {#each r.hits as h (h.key + ':' + h.s)}
          <button class="hit" onclick={() => open(r, h)}>
            <span class="ch">{h.chapter}</span>
            <span class="snip">{h.before}<b>{h.matched}</b>{h.after}</span>
          </button>
        {/each}
        {#if r.total > r.hits.length}<p class="more">{r.total - r.hits.length} more in this book: open one and press N for the next.</p>{/if}
      </div>
    {/each}
  </section>
{/if}

<style>
  .res { max-width: 1040px; margin-top: 40px; display: grid; gap: 26px; }
  h2 { margin: 0; display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; font: 700 var(--t-l)/1.25 var(--f-ui); color: var(--ink); }
  .sum { font: 500 var(--t-s)/1.3 var(--f-ui); color: var(--ink-3); }
  .bk { display: grid; gap: 4px; max-width: 760px; }
  h3 { margin: 0 0 4px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
  .bt { font: 650 var(--t-m)/1.3 var(--f-ui); color: var(--ink); }
  .ba { font: 500 var(--t-s)/1.3 var(--f-ui); color: var(--ink-3); }
  .n { font: 600 13px/1 var(--f-ui); color: var(--ink-3); font-variant-numeric: tabular-nums; }
  .hit { all: unset; box-sizing: border-box; cursor: pointer; display: grid; gap: 2px; padding: 8px 12px; border-radius: var(--r-s); }
  :global(html:not(.touchui)) .hit:hover { background: var(--hover); }
  .hit:focus-visible { outline: 2px solid var(--focus); outline-offset: 0; background: var(--hover); }
  .ch { font: 600 12.5px/1.3 var(--f-ui); color: var(--ink-3); }
  .snip { font: 400 16px/1.45 var(--f-book); color: var(--ink-2); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .snip b { color: var(--ink); font-weight: 650; background: color-mix(in srgb, var(--accent) 16%, transparent); border-radius: 3px; padding: 0 1px; }
  .more { margin: 2px 12px 0; font: 500 13px/1.4 var(--f-ui); color: var(--ink-3); }
</style>
