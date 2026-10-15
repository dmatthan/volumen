<script lang="ts">
  import { embedded } from '../core/embed';
  import { isNotesMarkdown } from '../reader/notesmd';
  import { isWebAnno } from '../reader/webanno';
  import { onMount, untrack } from 'svelte';
  import { ui, toast, type Reader } from '../reader/reader.svelte';
  import type { MapCtl } from '../reader/map.svelte';
  import { settings } from '../reader/settings.svelte';
  import MapView from './MapView.svelte';
  import SettingsPanel from './SettingsPanel.svelte';
  import FindBar from './FindBar.svelte';
  import BookNote from './BookNote.svelte';
  import SideNotes from './SideNotes.svelte';
  import Lightbox from './Lightbox.svelte';
  import ThemeEditor from './ThemeEditor.svelte';
  import { editor } from './editor.svelte';
  import Help from './Help.svelte';
  import Chip from './Chip.svelte';
  import NoteSheet from './NoteSheet.svelte';
  import SendSheet from './SendSheet.svelte';
  import WelcomeSheet from './WelcomeSheet.svelte';

  let { reader, map, hidden, chip = $bindable(), findBar = $bindable() }: { reader: Reader; map: MapCtl; hidden: boolean; chip?: Chip; findBar?: FindBar } = $props();
  let stage: HTMLElement, track: HTMLElement, bar: HTMLElement;
  onMount(() => reader.mount(stage, track));

  // The bar's controls fade away while reading and come back when the pointer seeks the
  // top band or keyboard focus reaches them. The chapter name stays. Nothing here changes
  // the page's layout: the bar floats over a band the text never uses.
  const ZONE = 76;
  let away = $state(false);
  let hideT = 0;
  const show = () => { clearTimeout(hideT); away = false; };
  const hideSoon = (ms = 700) => { clearTimeout(hideT); hideT = window.setTimeout(() => { if (!bar?.matches(':hover, :focus-within')) away = true; }, ms); };
  function onMove(e: PointerEvent) {
    if (hidden || e.buttons) return;
    if (e.clientY - (bar?.getBoundingClientRect().top ?? 0) < ZONE) show();
    else if (!away) hideSoon();
  }
  // a book opening shows the bar for a moment, then it steps aside
  $effect(() => { if (!hidden && !ui.sheet) { show(); hideSoon(1800); } });
  // a finger's tap in the middle of the page shows the bar (for a few seconds), or puts it
  // away (reader.svelte.ts)
  $effect(() => {
    if (!ui.barToggle) return;
    untrack(() => { if (away) { show(); hideSoon(4000); } else { clearTimeout(hideT); away = true; } });
  });
</script>

<svelte:window onpointermove={onMove} />

<section class="reader" class:clear-veil={!settings.veil} class:view-minimal={settings.view === 'minimal' || ui.phone} {hidden} aria-label="Reader"
  ondragover={e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); }}
  ondrop={async e => {
    // notes on this book dropped onto it: a notes file, or a notebook exported as Markdown
    const f = [...(e.dataTransfer?.files ?? [])].find(f => /\.(vnotes|md|markdown|json|jsonld)$/i.test(f.name));
    if (!f) return;
    e.preventDefault();
    const text = await f.text();
    if (/\.vnotes$/i.test(f.name) || isNotesMarkdown(text) || isWebAnno(text)) toast(await reader.receiveNotes(text).catch(e => `These notes could not be taken: ${(e as Error).message}`), 5200);
  }}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- a tap in the bar’s band while it is away brings it back (a phone has no pointer to
       seek it with); its buttons take taps only once they show -->
  <header class="bar" class:away={(away && ui.sheet !== 'settings') || reader.finder.open} bind:this={bar} onfocusin={show} onfocusout={() => hideSoon()}
    onpointerup={e => { if (away && e.pointerType !== 'mouse') { show(); hideSoon(4000); } }}>
    <div class="side">
      {#if embedded}
        <a class="ibtn home" href="https://volumen.page" target="_blank" rel="noopener" aria-label="Volumen (opens in a new tab)"><span class="lbl">Volumen</span></a>
      {:else}
        <button class="ibtn" onclick={() => reader.close()} aria-label="Back to the library (Q)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5 8 12l6.5 6.5" /></svg><span class="lbl">Library</span>
        </button>
      {/if}
    </div>
    <div class="runhead" aria-live="polite">{ui.runhead}</div>
    <div class="side right">
      <button class="ibtn" onclick={() => map.open()} aria-label="Map of the book (M)">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="8" height="14" rx="1.5" /><rect x="13" y="5" width="8" height="14" rx="1.5" /><path d="M5.5 9h3M5.5 12h3M5.5 15h2M15.5 9h3M15.5 12h3M15.5 15h2" /></svg><span class="lbl">Map</span>
      </button>
      <button class="ibtn" data-settings-toggle aria-pressed={ui.sheet === 'settings'} onclick={() => (ui.sheet = ui.sheet === 'settings' ? null : 'settings')} aria-label="Themes and settings (S)"><span class="aa" aria-hidden="true">Aa</span></button>
    </div>
  </header>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="stage" bind:this={stage} tabindex="0" role="region" aria-label="Book text. Space turns the page, arrow keys move one column. Press ? for all keys.">
    <div class="track" bind:this={track}></div>
    <div class="veil l"></div>
    <div class="veil r"></div>
    <Chip {reader} bind:this={chip} />
    {#if ui.bookNote && reader.book}<BookNote {reader} />{/if}
    {#if ui.sideNotes && reader.book}<SideNotes {reader} />{/if}
  </div>
  {#if ui.lightbox && reader.book}<Lightbox {reader} />{/if}
  {#if !hidden && reader.finder.open}<FindBar {reader} bind:this={findBar} />{/if}
</section>

<MapView {map} {reader} />

{#if !hidden && ui.sheet === 'settings'}<SettingsPanel {reader} />{/if}
{#if !hidden && ui.sheet === 'theme' && editor.draft}<ThemeEditor {reader} />{/if}
{#if !hidden && ui.sheet === 'help'}<Help onclose={() => (ui.sheet = null)} />{/if}
{#if !hidden && ui.sheet === 'note'}<NoteSheet {reader} />{/if}
{#if !hidden && ui.sheet === 'send' && reader.book}<SendSheet {reader} />{/if}
{#if !hidden && ui.sheet === 'welcome' && reader.book}<WelcomeSheet {reader} />{/if}

<style>
  .bar { position: absolute; top: env(safe-area-inset-top); left: env(safe-area-inset-left); right: env(safe-area-inset-right); z-index: 5; height: 52px; will-change: transform; transform: translateZ(0); display: grid; grid-template-columns: 1fr minmax(0, auto) 1fr; align-items: center; padding-inline: 10px; gap: 8px; color: var(--ink-3); }
  .side { display: flex; align-items: center; gap: 4px; transition: opacity .3s ease; }
  .away .side { opacity: 0; pointer-events: none; }
  .runhead { transition: opacity .3s ease; }
  .away .runhead { opacity: .7; }
  .right { justify-content: flex-end; }
  .ibtn {
    appearance: none; border: 0; background: none; cursor: pointer; height: 40px; min-width: 40px; padding: 0 10px;
    border-radius: var(--r-s); display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    color: var(--ink-3); font: 600 var(--t-s)/1 var(--f-ui); transition: color .15s, background-color .15s;
  }
  :global(html:not(.touchui)) .ibtn:hover { color: var(--ink); background: var(--hover); }
  .ibtn svg { width: 22px; height: 22px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .aa { font: 650 18px/1 var(--f-ui); }
  .side, .runhead { position: relative; }
  .runhead { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: center; font: 600 var(--t-m)/1 var(--f-ui); color: var(--ink-3); }
  @media (max-width: 639px) { .lbl { display: none; } }
  /* (embedded: the way to Volumen itself, named on a phone too) */
  .ibtn.home { text-decoration: none; font-family: var(--f-book); }
  @media (max-width: 639px) { .ibtn.home .lbl { display: inline; } }
</style>
