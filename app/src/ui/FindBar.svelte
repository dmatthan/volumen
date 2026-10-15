<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { Reader } from '../reader/reader.svelte';

  /** Find in book: a field over the top band, the count, previous and next, and while
   *  typing the results beneath, grouped by chapter. Enter steps through the hits;
   *  arrows walk the list; Esc ends the search and clears its marks. */
  let { reader }: { reader: Reader } = $props();
  // svelte-ignore state_referenced_locally
  const f = reader.finder;
  let input: HTMLInputElement;
  let list = $state<HTMLElement>();
  let focused = $state(true);
  /** The list shows while choosing (typing, arrows); a step with Enter puts it away so
   *  the match can be read in place. */
  let listing = $state(true);
  const rows = $derived(f.hits.length ? f.rows() : []);
  const curRow = $derived.by(() => {
    let r = -1;
    for (let j = 0; j < rows.length && rows[j].i <= f.cur; j++) r = j;
    return r;
  });

  onMount(() => { input.focus(); input.select(); });
  export function refocus() { input?.focus(); input?.select(); }

  $effect(() => {
    curRow;
    tick().then(() => list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
  });

  function key(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); listing = false; e.shiftKey ? f.prev() : f.next(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!listing) { listing = true; return; }
      if (!rows.length) return;
      const j = Math.max(0, Math.min(rows.length - 1, curRow + (e.key === 'ArrowDown' ? 1 : -1)));
      f.go(rows[j].i);
    }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }
  function close() {
    f.hide();
    reader.stage?.focus({ preventScroll: true });
  }
  const count = $derived(!f.query.trim() ? '' : !f.total ? 'No matches' : f.phrase ? `${f.cur + 1} of ${f.total}` : `${f.total} paragraph${f.total === 1 ? '' : 's'} with every word`);
</script>

<div class="find" role="search">
  <div class="field lift r12">
    <svg class="mag" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
    <input bind:this={input} value={f.query} oninput={e => { listing = true; f.type((e.target as HTMLInputElement).value); }} onkeydown={key}
      onfocus={() => (focused = true)} onblur={() => setTimeout(() => (focused = !!list?.matches(':hover')), 120)}
      placeholder="Find in book" aria-label="Find in book" spellcheck="false" autocomplete="off" />
    <span class="count" aria-live="polite">{count}</span>
    <button onclick={() => { listing = false; f.prev(); }} disabled={!f.hits.length} aria-label="Previous match (Shift+Enter)"><svg viewBox="0 0 24 24"><path d="m7 14 5-5 5 5" /></svg></button>
    <button onclick={() => { listing = false; f.next(); }} disabled={!f.hits.length} aria-label="Next match (Enter)"><svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5" /></svg></button>
    <button onclick={close} aria-label="End the search (Esc)"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17" /></svg></button>
  </div>
  {#if focused && listing && rows.length}
    <!-- the frame casts the shadow and stays still; the list scrolls inside it -->
    <div class="frame lift r12"><div class="list" bind:this={list} role="listbox" aria-label="Matches">
      {#each rows as r, j (r.i)}
        {#if j === 0 || rows[j - 1].sec !== r.sec}<div class="ch">{r.chapter}</div>{/if}
        <button class="hit" role="option" aria-selected={j === curRow} onmousedown={e => e.preventDefault()} onclick={() => f.go(r.i)}>
          <span class="snip">{r.before}<b>{r.match}</b>{r.after}</span>
          {#if r.count > 1}<span class="n">{r.count}</span>{/if}
        </button>
      {/each}
      {#if f.hits.length < f.total || rows.length >= 400}<div class="more">Showing the first {rows.length} paragraphs. Refine the search to see the rest.</div>{/if}
    </div></div>
  {/if}
</div>

<style>
  .find { position: absolute; z-index: 44; top: 10px; left: 50%; transform: translateX(-50%); width: min(600px, calc(100% - 28px)); display: grid; gap: 8px; }
  .field { display: flex; align-items: center; gap: 4px; height: 44px; padding: 0 6px 0 12px; border-radius: 12px; background: var(--sheet); border: 1px solid var(--rule); color: var(--ink); }
  .mag { width: 18px; height: 18px; color: var(--ink-3); flex: none; }
  svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  input { flex: 1; min-width: 0; height: 100%; border: 0; outline: none; background: transparent; color: var(--ink); font: 500 var(--t-m)/1 var(--f-ui); padding: 0 6px; }
  input::placeholder { color: var(--ink-3); }
  .count { font: 600 13px/1 var(--f-ui); color: var(--ink-3); white-space: nowrap; font-variant-numeric: tabular-nums; padding: 0 4px; }
  button { appearance: none; border: 0; background: none; color: var(--ink-2); cursor: pointer; padding: 0; font: inherit; }
  .field button { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; flex: none; }
  :global(html:not(.touchui)) .field button:hover:not(:disabled) { background: var(--hover); }
  .field button:disabled { opacity: .35; cursor: default; }
  .frame { border-radius: 12px; background: var(--sheet); border: 1px solid var(--rule); }
  .list { max-height: min(56vh, 520px); overflow-y: auto; overflow-x: hidden; touch-action: pan-y; overscroll-behavior: contain; border-radius: inherit; padding: 6px; }
  .ch { position: sticky; top: -6px; background: var(--sheet); padding: 8px 10px 4px; font: 650 12.5px/1.2 var(--f-ui); color: var(--ink-3); z-index: 1; }
  .hit { display: flex; gap: 10px; align-items: baseline; width: 100%; text-align: left; padding: 8px 10px; border-radius: 9px; }
  :global(html:not(.touchui)) .hit:not([aria-selected="true"]):hover { background: var(--hover); }
  .hit[aria-selected="true"] { background: var(--wash); }
  .snip { flex: 1; font: 400 15px/1.4 var(--f-book); color: var(--ink-2); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .snip b { color: var(--ink); font-weight: 650; background: color-mix(in srgb, var(--accent) 16%, transparent); border-radius: 3px; padding: 0 1px; }
  .n { font: 600 13px/1 var(--f-ui); color: var(--ink-3); }
  .more { padding: 8px 10px; font: 500 13px/1.4 var(--f-ui); color: var(--ink-3); }
</style>
