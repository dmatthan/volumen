<script lang="ts">
  import { copyText } from './clipboard';
  import { keyHint } from './touch';
  import { onMount, tick } from 'svelte';
  import type { LibEntry } from '../core/types';
  import type { Reader } from '../reader/reader.svelte';
  import { toast } from '../reader/reader.svelte';
  import { digests, fold, markdownOf, type NoteEntry } from '../reader/notebook';
  import { notesMarkdown } from '../reader/notesmd';
  import { shell } from '../core/shell';

  /** Every book's notebook at once: highlights, notes, marked paragraphs and chapter
   *  lines, grouped by book, the one written in last first. One field filters them all, folded as
   *  find folds (case, accents, curly quotes). An entry opens its book at its place. */
  let { books, reader }: { books: LibEntry[]; reader: Reader } = $props();
  let field: HTMLInputElement;
  let listEl: HTMLElement;
  let query = $state('');
  const LIMIT = 400;

  interface Group { id: string; title: string; author: string; items: (NoteEntry & { hay: string })[] }
  // read once when shown: the notebook changes only while a book is open
  const all: Group[] = (() => {
    const d = digests();
    const out: (Group & { updated: number })[] = [];
    for (const b of books) {
      const g = d.get(b.id);
      if (!g) continue;
      out.push({ id: b.id, title: b.title, author: b.author, updated: g.updated, items: g.items.map(it => ({ ...it, hay: fold(`${it.quote} ${it.note} ${it.where} ${b.title} ${b.author}`) })) });
    }
    // the book written in most recently first
    return out.sort((a, z) => z.updated - a.updated);
  })();
  const total = all.reduce((n, g) => n + g.items.length, 0);
  const shown = $derived.by(() => {
    const words = fold(query).split(/\s+/).filter(Boolean);
    let n = 0;
    const out: Group[] = [];
    for (const g of all) {
      if (n >= LIMIT) break;
      const items = words.length ? g.items.filter(it => words.every(w => it.hay.includes(w))) : g.items;
      if (!items.length) continue;
      out.push({ ...g, items: items.slice(0, LIMIT - n) });
      n += items.length;
    }
    return { groups: out, count: n };
  });

  onMount(() => { if (total) field?.focus(); });

  function open(g: Group, it: NoteEntry) { reader.open(g.id, it.at); }

  const md = () => notesMarkdown(shown.groups.map(g => markdownOf({ id: g.id, title: g.title, author: g.author }, g.items)));
  async function copy() {
    toast((await copyText(md())) ? 'Copied' : 'This browser would not copy. Select the text instead.');
  }
  async function exportMd() {
    if (await shell.saveText('Notebook.md', md())) toast('Notebook exported.');
  }

  /** Keys while the notebook shows: / filters, arrows and J K move, Enter opens. */
  export function key(e: KeyboardEvent): boolean {
    const k = e.key;
    if (k === '/') { field.focus(); field.select(); return true; }
    const items = [...listEl.querySelectorAll<HTMLElement>('.nb-item')];
    if (!items.length) return false;
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (k === 'ArrowDown' || k === 'j') { items[Math.min(items.length - 1, i + 1)].focus(); return true; }
    if (k === 'ArrowUp' || k === 'k') { (i <= 0 ? field : items[i - 1]).focus(); return true; }
    return false;
  }
  function fieldKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      // the first Esc clears the filter, the next leaves the field
      e.preventDefault(); e.stopPropagation();
      if (query) query = ''; else field.blur();
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      const first = listEl.querySelector<HTMLElement>('.nb-item');
      if (first) { e.preventDefault(); e.stopPropagation(); e.key === 'Enter' ? first.click() : first.focus(); }
    }
  }
  $effect(() => { query; tick().then(() => listEl?.scrollTo({ top: 0 })); });
</script>

<div class="nb">
  <div class="nb-head">
    <input bind:this={field} class="nb-filter" type="search" bind:value={query} onkeydown={fieldKey}
      placeholder={(total ? `Filter ${total} entr${total === 1 ? 'y' : 'ies'}` : 'Filter') + keyHint('/')} aria-label="Filter the notebook" spellcheck="false" autocomplete="off" />
    <button class="btn quiet" disabled={!shown.count} onclick={copy}>Copy as Markdown</button>
    <button class="btn" disabled={!shown.count} onclick={exportMd}>Export…</button>
  </div>
  <div class="nb-list" bind:this={listEl}>
    {#if !total}
      <p class="empty">Nothing here yet. While reading, hold a moment and drag to select a passage, then press 1–4 to highlight it or N to add a note; V chooses a whole paragraph from the keyboard. Everything you add, in every book, collects here.</p>
    {:else if !shown.count}
      <p class="empty">Nothing matches “{query}”.</p>
    {/if}
    {#each shown.groups as g (g.id)}
      <section class="nb-book">
        <h2><span class="bt">{g.title}</span>{#if g.author}<span class="ba">{g.author}</span>{/if}</h2>
        {#each g.items as it, i (it.id)}
          {#if i === 0 || g.items[i - 1].sec !== it.sec}<h3>{it.where}</h3>{/if}
          <button class="nb-item {it.kind} h{it.color}" onclick={() => open(g, it)} aria-label="{it.quote.slice(0, 80)}. Opens {g.title} here.">
            <span class="q">{it.quote}</span>
            {#if it.note}<span class="n">{it.note}</span>{/if}
          </button>
        {/each}
      </section>
    {/each}
    {#if shown.count >= LIMIT}<p class="empty">Showing the first {LIMIT}. Filter to find the rest.</p>{/if}
  </div>
</div>

<style>
  .nb { max-width: 760px; display: grid; gap: 8px; }
  .nb-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; position: sticky; top: 0; padding: 6px 0 12px; background: var(--ground); z-index: 1; }
  .nb-filter { flex: 1 1 260px; min-width: 0; height: 44px; box-sizing: border-box; border: 1.5px solid var(--rule); border-radius: var(--r-m); background: var(--surface); color: var(--ink); font: 500 var(--t-m)/1 var(--f-ui); padding: 0 14px; outline: none; }
  .nb-filter:focus { border-color: var(--accent); }
  .nb-list { display: grid; gap: 34px; }
  .nb-book { display: grid; gap: 14px; }
  h2 { margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
  .bt { font: 700 var(--t-l)/1.25 var(--f-ui); color: var(--ink); letter-spacing: -0.01em; }
  .ba { font: 500 var(--t-s)/1.3 var(--f-ui); color: var(--ink-3); }
  h3 { margin: 6px 0 -4px; font: 650 var(--t-s)/1.3 var(--f-ui); color: var(--ink-3); }
  .nb-item { all: unset; box-sizing: border-box; cursor: pointer; display: grid; gap: 8px; padding: 6px 12px 6px 14px; border-left: 4px solid var(--rule); border-radius: 0 var(--r-s) var(--r-s) 0; }
  :global(html:not(.touchui)) .nb-item:hover { background: var(--hover); }
  .nb-item:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .nb-item.h1 { border-left-color: var(--hs1); } .nb-item.h2 { border-left-color: var(--hs2); } .nb-item.h3 { border-left-color: var(--hs3); } .nb-item.h4 { border-left-color: var(--hs4); }
  .nb-item.mark { border-left-color: var(--accent); }
  .q { font: 400 17px/1.55 var(--f-book); color: var(--ink); display: -webkit-box; -webkit-line-clamp: 5; line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }
  .n { font: 500 var(--t-m)/1.5 var(--f-ui); color: var(--ink); white-space: pre-wrap; }
  .tag { font: 650 var(--t-xs)/1 var(--f-ui); font-style: normal; color: var(--ink-3); text-transform: uppercase; letter-spacing: .05em; margin-right: 6px; }
  .empty { color: var(--ink-3); font: 500 var(--t-m)/1.5 var(--f-ui); max-width: 56ch; margin: 0; }
</style>
