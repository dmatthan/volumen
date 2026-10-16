<script lang="ts">
  import { toWebAnno } from '../reader/webanno';
  import { FORMAT, type NotesFile } from '../reader/feedback';
  import { me } from '../core/identity';
  import { keyHint } from './touch';
  import { onMount, untrack } from 'svelte';
  import { type Reader } from '../reader/reader.svelte';
  import { ui, toast } from '../state.svelte';
  import { mp, type MapCtl, type NoteItem } from '../reader/map.svelte';
  import { fold } from '../reader/notebook';
  import FeedbackList from './FeedbackList.svelte';
  /** The notebook shows one's own notes, or (when there are any) other readers'. */
  let nbMode: 'mine' | 'feedback' = $state('mine');

  let { map, reader }: { map: MapCtl; reader: Reader } = $props();
  let el: HTMLElement, cv: HTMLCanvasElement, strip: HTMLElement, win: HTMLElement, bg: HTMLElement, gauge: HTMLElement;
  onMount(() => map.mount(el, cv, strip, win, bg));

  let gOn = false;
  function gdown(e: PointerEvent) { if (map.busy) return; gOn = true; try { gauge.setPointerCapture(e.pointerId); } catch {} map.gaugeAt(e.clientX, gauge.getBoundingClientRect()); }
  function gmove(e: PointerEvent) { if (gOn) map.gaugeAt(e.clientX, gauge.getBoundingClientRect()); }

  import { shell } from '../core/shell';
  let filter = $state('');
  const shown = $derived.by(() => {
    const words = fold(filter).split(/\s+/).filter(Boolean);
    return words.length ? mp.notes.filter(n => { const h = fold(n.quote + ' ' + n.note + ' ' + n.where); return words.every(w => h.includes(w)); }) : mp.notes;
  });
  function goto(it: NoteItem) { map.setView('strip'); map.close(map.columnOf(it)); }
  function editNote(id: string) { ui.noteFor = id; ui.sheet = 'note'; }
  async function exportMd() {
    const name = (reader.book?.title || 'Notes').replace(/[\\/:*?"<>|]+/g, ' ').trim() + ' — notes.md';
    if (await shell.saveText(name, map.markdown(shown))) toast('Notebook exported.');
  }
  /** The same notes as W3C Web Annotations, for other tools (reader/webanno.ts). */
  async function exportAnno() {
    const book = reader.book!, m = me();
    const f: NotesFile = { format: FORMAT, book: { id: book.id, title: book.title, author: book.author }, from: { id: m.id, name: m.name }, sent: Date.now(), notes: shown.flatMap(i => (i.file ? [i.file] : [])) };
    const name = (book.title || 'Notes').replace(/[\\/:*?"<>|]+/g, ' ').trim() + ' — annotations.json';
    if (await shell.saveText(name, JSON.stringify(toWebAnno(f), null, 1), 'json')) toast('Notebook exported as Web Annotations.');
  }
  // find, from the map: results choose their column; Enter in the field travels there
  // svelte-ignore state_referenced_locally
  const f = reader.finder;
  $effect(() => { f.hits; untrack(() => map.hitsChanged()); });
  function findKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || (e.key === 'Tab' && f.hits.length)) {
      e.preventDefault(); e.stopPropagation();
      map.stepHit(e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1);
    } else if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      if (mp.sel != null) map.close(mp.sel);
    } else if (e.key === 'Escape') {
      // the first Esc leaves the field (the matches stay); the next closes the map
      e.preventDefault(); e.stopPropagation();
      if (!f.query) mp.find = false;
      el.focus({ preventScroll: true });
    }
  }
  const findCount = $derived(!f.query.trim() ? '' : !f.total ? 'None' : `${f.cur + 1}/${f.total}`);
  // a note edited from here refreshes the list when its sheet closes
  $effect(() => { if (ui.sheet === null && mp.view === 'marks' && ui.mapOpen) { ui.annVersion; map.buildNotebook(); } });
</script>

<section class="map" bind:this={el} hidden={!ui.mapOpen} class:ui-in={mp.uiIn} aria-label="Map of the book. Left and right choose a column, Enter travels." tabindex="-1">
  <div class="m-bg" bind:this={bg}></div>
  <canvas bind:this={cv} aria-hidden="true"></canvas>
  <div class="m-head m-ui">
    <div><button class="ibtn" id="mBack" onclick={() => map.close()} aria-label="Back to reading (Esc)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button></div>
    <div class="seg" role="group" aria-label="Map view">
      <button aria-pressed={mp.view === 'strip'} onclick={() => map.setView('strip')}>Book</button>
      <button aria-pressed={mp.view === 'marks'} onclick={() => map.setView('marks')}>Notebook</button>
    </div>
    <div class="m-find-cell">
      {#if mp.view === 'strip'}
        {#if mp.find}
          <div class="m-find">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
            <input type="search" value={f.query} oninput={e => f.type((e.target as HTMLInputElement).value)} onkeydown={findKey}
              placeholder="Find in book" aria-label="Find in book. Up and down choose a match, Enter travels to it." spellcheck="false" autocomplete="off" />
            <span class="m-count" aria-live="polite">{findCount}</span>
          </div>
        {:else}
          <button class="ibtn" onclick={() => map.focusFind()} aria-label="Find in book (/)"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg></button>
        {/if}
      {/if}
    </div>
  </div>
  <div class="m-info m-ui" style:visibility={mp.view === 'marks' ? 'hidden' : null}><div class="mi-t">{mp.infoT}</div><div class="mi-s">{mp.infoS}</div></div>
  <div class="m-strip m-ui" bind:this={strip}></div>
  <div class="m-gauge m-ui" style:visibility={mp.view === 'marks' ? 'hidden' : null}>
    <div class="g-track" bind:this={gauge} aria-hidden="true" onpointerdown={gdown} onpointermove={gmove} onpointerup={() => (gOn = false)} onpointercancel={() => (gOn = false)}>
      <div class="g-line"></div>
      <div class="g-read" style:width="{mp.gauge.read}%"></div>
      {#each mp.gauge.ticks as t}<div class="g-tick" style:left="{t}%"></div>{/each}
      {#each mp.gauge.marks as t}<div class="g-mark" style:left="{t}%"></div>{/each}
      {#each mp.gauge.hits as t}<div class="g-hit" style:left="{t}%"></div>{/each}
      <div class="g-win" bind:this={win}></div>
      <div class="g-here" style:left="{mp.gauge.here}%"></div>
    </div>
  </div>
  <div class="m-list m-ui" style:visibility={mp.view === 'marks' ? 'hidden' : null}>
    <ol>
      {#each mp.chapters as c (c.sec)}
        <li><button class="ch-row" class:read={c.read} aria-current={c.current} onclick={() => map.select(reader.strip!.secStart[c.sec], 'center')}>
          <span class="ch-num">{c.num}</span><span class="ch-title">{c.title}</span>
          {#if mp.secHits[c.sec]}<span class="ch-hits">{mp.secHits[c.sec]} found</span>{:else if c.feedback}<span class="ch-fb" title="Readers' notes in this chapter">{c.feedback}</span>{/if}</button></li>
      {/each}
    </ol>
  </div>
  <div class="m-foot m-ui">
    <button class="btn" onclick={() => map.close(mp.here)}>Back to my place <kbd>Esc</kbd></button>
    {#if mp.view === 'strip'}
      <button class="btn primary go" disabled={mp.sel == null || mp.sel === mp.here} onclick={() => mp.sel != null && map.close(mp.sel)} title={mp.goLabel}><span class="go-l">{mp.goLabel}</span> <kbd>Enter</kbd></button>
    {/if}
  </div>
  {#if mp.view === 'marks'}
    <div class="m-marks m-ui">
      <div class="mk-inner">
        <div class="nb-head">
          {#if reader.fb?.size}
            <div class="seg nb-mode" role="group" aria-label="Whose notes">
              <button aria-pressed={nbMode === 'mine'} onclick={() => (nbMode = 'mine')}>Mine</button>
              <button aria-pressed={nbMode === 'feedback'} onclick={() => (nbMode = 'feedback')}>Feedback · {reader.fb.size}</button>
            </div>
          {/if}
          <input class="nb-filter" type="search" placeholder={(nbMode === 'mine' ? 'Filter your notes' : 'Filter the feedback') + keyHint('/')} bind:value={filter} aria-label="Filter the notebook" />
          {#if nbMode === 'mine'}
            <button class="btn quiet" disabled={!shown.length} onclick={() => map.copy(map.markdown(shown))}>Copy as Markdown</button>
            <button class="btn quiet" disabled={!shown.length} onclick={exportMd}>Export…</button>
            <button class="btn quiet" disabled={!shown.length} onclick={exportAnno} title="W3C Web Annotations, for other annotation tools">As annotations…</button>
            <button class="btn" disabled={!mp.notes.length} onclick={() => (ui.sheet = 'send')}>Send my notes…</button>
          {/if}
        </div>
        {#if nbMode === 'feedback' && reader.fb?.size}
          <FeedbackList {reader} {filter} go={(key, s) => { map.setView('strip'); map.close(reader.strip!.resolve({ key, off: s })); }} />
        {:else}
        {#if !mp.notes.length}
          <p class="mk-empty">Nothing here yet. While reading, hold a moment and drag to select a passage, then press 1–4 to highlight it or N to add a note. Press V to choose a whole paragraph from the keyboard.</p>
        {:else if !shown.length}
          <p class="mk-empty">Nothing matches “{filter}”.</p>
        {/if}
        {#each shown as it, i (it.id)}
          {#if i === 0 || shown[i - 1].sec !== it.sec}<h3 class="nb-ch">{it.where}</h3>{/if}
          <div class="mk-item {it.kind} h{it.color}">
            <p class="mk-text">{it.quote}</p>
            {#if it.note}<p class="nb-note">{it.note}</p>{/if}
            <div class="mk-acts">
              <button class="btn quiet" onclick={() => goto(it)}>Go to it</button>
              {#if it.kind === 'ann'}
                <button class="btn quiet" onclick={() => editNote(it.id)}>{it.note ? 'Edit note' : 'Add note'}</button>
                <button class="btn quiet" onclick={() => map.copy(map.citeEntry(it))}>Copy</button>
                <button class="btn quiet" onclick={() => { reader.unhighlight(it.id); map.buildNotebook(); }}>Remove</button>
              {:else if it.kind === 'mark'}
                <button class="btn quiet" onclick={() => map.copy(map.cite(it.id))}>Copy with reference</button>
                <button class="btn quiet" onclick={() => { reader.toggleMark(it.id); map.buildNotebook(); }}>Unmark</button>
              {/if}
            </div>
          </div>
        {/each}
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .map:focus { outline: none; }
  .map { position: absolute; inset: 0; z-index: 30; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto minmax(160px, 1fr) auto minmax(0, auto) auto; }
  .m-bg { position: absolute; inset: 0; background: var(--ground); opacity: 0; }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; cursor: grab; }
  canvas:active { cursor: grabbing; }
  .m-ui { grid-column: 1; position: relative; z-index: 2; opacity: 0; pointer-events: none; transition: opacity .25s ease; }
  .ui-in .m-ui { opacity: 1; pointer-events: auto; }
  .m-strip { grid-row: 3; pointer-events: none !important; }
  .m-head { grid-row: 1; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; height: 56px; padding: env(safe-area-inset-top) 10px 0; }
  .ibtn { appearance: none; border: 0; background: none; cursor: pointer; height: 40px; min-width: 40px; border-radius: var(--r-s); display: inline-flex; align-items: center; justify-content: center; color: var(--ink-2); }
  :global(html:not(.touchui)) .ibtn:hover { background: var(--hover); color: var(--ink); }
  .ibtn svg { width: 22px; height: 22px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; }
  .m-find-cell { display: flex; justify-content: flex-end; min-width: 0; }
  .m-find { display: flex; align-items: center; gap: 6px; width: min(280px, 100%); height: 40px; box-sizing: border-box; padding: 0 12px; border-radius: var(--r-m); border: 1.5px solid var(--rule); background: var(--surface); color: var(--ink-3); }
  .m-find:focus-within { border-color: var(--accent); }
  .m-find svg { width: 17px; height: 17px; flex: none; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; }
  .m-find input { flex: 1; min-width: 0; height: 100%; border: 0; outline: none; background: transparent; color: var(--ink); font: 500 var(--t-m)/1 var(--f-ui); padding: 0; }
  .m-find input::-webkit-search-cancel-button { display: none; }
  .m-find input::placeholder { color: var(--ink-3); }
  .m-count { font: 600 13px/1 var(--f-ui); color: var(--ink-3); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .seg { display: inline-flex; padding: 3px; border-radius: var(--r-m); background: var(--read); }
  .seg button { appearance: none; border: 0; background: none; cursor: pointer; padding: 8px 16px; border-radius: 9px; font: 600 var(--t-s)/1.2 var(--f-ui); color: var(--ink-2); }
  .seg button[aria-pressed="true"] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px oklch(0 0 0 / 0.12); }
  .m-info { grid-row: 2; text-align: center; padding: 6px 16px 0; display: grid; gap: 4px; }
  .mi-t { font: 650 var(--t-l)/1.25 var(--f-ui); color: var(--ink); text-wrap: balance; }
  .mi-s { font: 500 var(--t-s)/1.3 var(--f-ui); color: var(--ink-3); font-variant-numeric: tabular-nums; }
  .m-gauge { grid-row: 4; padding: 4px 18px 12px; }
  .g-track { position: relative; height: 28px; cursor: pointer; touch-action: none; }
  .g-line { position: absolute; left: 0; right: 0; top: 13px; height: 2px; border-radius: 2px; background: var(--rule); }
  .g-read { position: absolute; left: 0; top: 13px; height: 2px; border-radius: 2px; background: var(--ink-3); }
  .g-tick { position: absolute; top: 8px; width: 1px; height: 12px; background: var(--ink-3); opacity: .7; }
  .g-mark { position: absolute; top: 19px; width: 2px; height: 7px; background: var(--accent); border-radius: 1px; }
  .g-hit { position: absolute; top: 4px; width: 2px; height: 7px; margin-left: -1px; background: var(--accent); border-radius: 1px; }
  .g-win { position: absolute; top: 3px; height: 22px; border: 2px solid var(--ink-2); border-radius: 6px; box-sizing: border-box; }
  .g-here { position: absolute; top: 9px; width: 10px; height: 10px; margin-left: -5px; border-radius: 50%; background: var(--accent); }
  .m-list { grid-row: 5; overflow-y: auto; overflow-x: hidden; touch-action: pan-y; max-height: 34vh; padding: 0 18px; border-top: 1px solid var(--rule); background: var(--ground); }
  ol { list-style: none; margin: 0 auto; padding: 4px 0; max-width: 820px; columns: 2 320px; column-gap: 28px; }
  /* a chapter: its number, its title (two lines if it needs them), and how many matches
     a search found in it; a chapter read through is quieter */
  .ch-row { all: unset; box-sizing: border-box; cursor: pointer; width: 100%; display: grid; grid-template-columns: 2.2em minmax(0, 1fr) auto; gap: 10px; align-items: baseline; padding: 9px 6px; border-bottom: 1px solid var(--rule); break-inside: avoid; }
  .ch-row.read .ch-title { color: var(--ink-2); font-weight: 500; }
  :global(html:not(.touchui)) .ch-row:hover .ch-title, .ch-row[aria-current="true"] .ch-title { color: var(--accent); }
  .ch-row:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; border-radius: 6px; }
  .ch-num { font: 650 var(--t-s)/1.3 var(--f-ui); color: var(--ink-3); text-align: right; font-variant-numeric: tabular-nums; }
  .ch-title { font: 600 var(--t-m)/1.3 var(--f-ui); color: var(--ink); overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; text-wrap: pretty; }
  .ch-hits { font: 650 var(--t-xs)/1.3 var(--f-ui); color: var(--accent); font-variant-numeric: tabular-nums; white-space: nowrap; }
  /* readers' notes in the chapter: a quiet count in a pill, only where there are some */
  .ch-fb { font: 650 var(--t-xs)/1 var(--f-ui); color: var(--ink-2); background: var(--read); border-radius: 999px; padding: 3px 7px; font-variant-numeric: tabular-nums; }
  .m-foot { grid-row: 6; display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; padding: 12px 18px calc(18px + env(safe-area-inset-bottom)); background: var(--ground); }
  /* both buttons keep one size; a long chapter name is cut short instead of stretching it */
  .m-foot :global(.btn) { flex: 0 1 300px; min-width: 0; padding: 0 14px; }
  /* a phone: the two side by side */
  @media (max-width: 640px) { .m-foot { flex-wrap: nowrap; padding-top: 10px; } .m-foot :global(.btn) { flex: 1 1 0; } }
  .go { justify-content: space-between; }
  /* (with no key hint beside it, the label is centred like every other button) */
  @media (max-width: 640px), (pointer: coarse) { .go { justify-content: center; } }
  :global(.touchui) .go { justify-content: center; }
  .go-l { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  /* (on a narrow phone its label wraps, as the button beside it does, rather than being cut) */
  @media (max-width: 380px) { .go-l { white-space: normal; text-overflow: clip; } }
  .go :global(kbd) { flex: none; }
  .m-marks { grid-row: 2 / 6; overflow-y: auto; overflow-x: hidden; touch-action: pan-y; background: var(--ground); padding: 8px 18px 24px; }
  .mk-inner { max-width: 680px; margin: 0 auto; display: grid; gap: 22px; }
  .mk-item { display: grid; gap: 8px; }
  .mk-where { font: 650 var(--t-s)/1.3 var(--f-ui); color: var(--ink-3); }
  .mk-text { margin: 0; font: 400 17px/1.55 var(--f-book); color: var(--ink); display: -webkit-box; -webkit-line-clamp: 6; line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden; }
  .mk-acts { display: flex; flex-wrap: wrap; gap: 6px; }
  .mk-acts :global(.btn) { min-height: 38px; padding: 0 14px; font-size: var(--t-s); }
  .nb-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; position: sticky; top: 0; padding: 6px 0 10px; background: var(--ground); z-index: 1; }
  .nb-mode { flex: none; }
  .nb-filter { flex: 1 1 220px; min-width: 0; height: 42px; box-sizing: border-box; border: 1.5px solid var(--rule); border-radius: var(--r-m); background: var(--surface); color: var(--ink); font: 500 var(--t-m)/1 var(--f-ui); padding: 0 14px; outline: none; }
  .nb-filter:focus { border-color: var(--accent); }
  .nb-ch { margin: 10px 0 -8px; font: 650 var(--t-s)/1.3 var(--f-ui); color: var(--ink-3); }
  .mk-item { padding-left: 14px; border-left: 4px solid var(--rule); }
  .mk-item.h1 { border-left-color: var(--hs1); } .mk-item.h2 { border-left-color: var(--hs2); } .mk-item.h3 { border-left-color: var(--hs3); } .mk-item.h4 { border-left-color: var(--hs4); }
  .mk-item.mark { border-left-color: var(--accent); }
  .nb-note { margin: 0; font: 500 var(--t-m)/1.5 var(--f-ui); color: var(--ink); white-space: pre-wrap; }
  .tag { font: 650 var(--t-xs)/1 var(--f-ui); font-style: normal; color: var(--ink-3); text-transform: uppercase; letter-spacing: .05em; margin-right: 6px; }
  .mk-empty { color: var(--ink-3); font: 500 var(--t-m)/1.5 var(--f-ui); max-width: 52ch; margin: 0; }
  :global(.touchui) .seg button { padding-block: 12px; }
</style>
