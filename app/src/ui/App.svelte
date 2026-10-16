<script lang="ts">
  import { untrack } from 'svelte';
  import { joinedOf, newerDraft } from '../core/service';
  import { openFromLink } from './links';
  import { embedded, embeddedBook, embedOpts } from '../core/embed';
  import type { Core } from '../core/types';
  import { Reader } from '../reader/reader.svelte';
  import { ui, toast } from '../state.svelte';
  import { MapCtl } from '../reader/map.svelte';
  import { settings, save, type Layout } from '../reader/settings.svelte';
  import { themes, readDesktop, setOption, resetOptions, themeById } from '../reader/themes.svelte';
  import { fitStats, resetFitStats, residual } from '../reader/verify';
  import { shell, isTauri } from '../core/shell';
  import { seedSample, type webCore } from '../core/web';
  import { flushKV, kv } from '../core/kv';
  import { setHints } from '../reader/hints';
  import Library from './Library.svelte';
  import ReaderView from './ReaderView.svelte';
  import Toast from './Toast.svelte';

  let { core }: { core: Core } = $props();
  // svelte-ignore state_referenced_locally
  const reader = new Reader(core);
  const map = new MapCtl(reader);
  reader.onMapOpen = () => map.open();
  shell.beforeQuit = async () => {
    reader.flush();
    await flushKV();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  };
  shell.watchClose();
  // tests drive the reader directly in development builds
  if (import.meta.env.DEV) {
    (window as any).__vol = { reader, map, ui, kv, settings, themes, setOption, resetOptions, themeById, fitStats, resetFitStats, residual, setHints };
    if (isTauri) (async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      if (!(await invoke<boolean>('selftest_mode'))) return;
      setHints(false);
      const t = await import('../selftest');
      const arg = await invoke<string>('selftest_arg');
      const log = (s: string) => invoke<void>('dev_log', { msg: s });
      // VOLUMEN_SELFTEST=<name>: one of these; anything else, the full test
      const probes: Record<string, () => Promise<unknown>> = {
        wheel: () => t.wheelProbe(reader, log), sheet: () => t.sheetProbe(reader, log), content: () => t.contentProbe(reader, log),
        library: () => t.libraryProbe(reader, log), search: () => t.searchProbe(reader, log), probe: () => t.probeStrings(reader, log), scale: () => t.scaleProbe(reader, log),
      };
      // a self-test must always end: on failure it says why, and a watchdog quits a stall
      const dog = setTimeout(async () => { await log('{"error":"watchdog: the self-test ran over its time"}'); shell.quit(); }, arg === 'wheel' ? 90000 : arg === 'scale' ? 480000 : 180000);
      try { await (probes[arg] ?? (() => t.selftest(reader, map, log)))(); }
      catch (e) { await log(JSON.stringify({ error: String((e as Error)?.message || e) })); }
      finally { clearTimeout(dog); await shell.quit(); }
    })();
  }
  let library: Library | undefined = $state();
  let findBar: any = $state();
  function openFind() {
    ui.sheet = null; ui.chip = null;
    if (reader.finder.open) findBar?.refocus(); else reader.finder.show();
  }
  let chip: any = $state();

  // a book that came by link: has the writer sent a newer draft? (asked each time it
  // opens, one small request; never while it is read)
  let draftAskedFor = '';
  $effect(() => {
    // (the view and title are what change as a book opens; the reader's book is not state)
    const id = ui.view === 'reader' && ui.title ? reader.book?.id : undefined;
    if (!id) { draftAskedFor = ''; return; }
    if (draftAskedFor === id || embedded || !joinedOf(id)) return;
    draftAskedFor = id;
    newerDraft(id).then(v => {
      if (v && reader.book?.id === id && !ui.sheet) { ui.newDraft = v; ui.sheet = 'newdraft'; }
    }).catch(() => {});
  });

  // the colour around the page: at once between views, with the map's fade for the map
  let edgeView = '';
  $effect(() => {
    const v = `${ui.view}/${ui.mapOpen}/${!!ui.lightbox}`;
    const viewChanged = edgeView.split('/')[0] !== ui.view;
    edgeView = v;
    untrack(() => reader.paintEdges(viewChanged ? 0 : 250));
  });

  // The phone's back gesture (and the browser's back): closes what is on top, a sheet, a
  // large image, the map, then the book. Each layer that opens adds a history entry; one
  // the app closes itself takes its entry back, so history holds only what is open.
  const layers = () => (ui.view === 'reader' ? 1 : 0) + (ui.mapOpen ? 1 : 0) + (ui.sheet ? 1 : 0) + (ui.lightbox ? 1 : 0);
  let shown = 0, popped = 0, unwinding = 0;
  $effect(() => {
    const n = layers();
    // (in another site's page, the frame's history would be the host page's back button)
    if (embedded) return;
    if (n > shown) for (let i = shown; i < n; i++) history.pushState({ vol: i + 1 }, '');
    else if (n < shown) {
      // closed by back: its entry is gone already; closed by the app: take it back
      const own = shown - n - Math.min(popped, shown - n);
      popped = Math.max(0, popped - (shown - n));
      // (one popstate however many steps)
      if (own > 0) { unwinding++; history.go(-own); }
    }
    shown = n;
  });
  addEventListener('popstate', () => {
    if (unwinding > 0) { unwinding--; return; }
    if (!layers()) return;
    popped++;
    if (ui.lightbox) ui.lightbox = null;
    else if (ui.sheet) ui.sheet = null;
    else if (ui.mapOpen) map.close();
    else if (ui.view === 'reader') reader.close();
  });

  // appearance and the desktop's colours repaint; a theme change relays out (settings sheet)
  $effect(() => { settings.appearance; themes.desktop; reader.themeChanged(); });
  // svelte-ignore state_referenced_locally
  readDesktop(core);
  // one book in another site's page (core/embed.ts), or the app
  let embedError = $state('');
  if (embedded) {
    // the theme the page asked for, if there is one by that name (kept for this visit)
    if (embedOpts.theme && themeById(embedOpts.theme)) settings.theme = embedOpts.theme;
    // svelte-ignore state_referenced_locally
    embeddedBook(core).then(async r => { if ('error' in r) embedError = r.error; else await reader.open(r.id); })
      .catch(e => { embedError = `The book could not be opened (${(e as Error).message}).`; });
  } else {
    // svelte-ignore state_referenced_locally
    const fromLink = () => openFromLink(core, reader);
    fromLink();
    addEventListener('hashchange', fromLink);
  }

  // the web build's first run: the sample book, added while the library already shows
  // svelte-ignore state_referenced_locally
  if ('importSample' in core && !embedded) {
    // svelte-ignore state_referenced_locally
    seedSample(core as ReturnType<typeof webCore>)
      .then(() => ui.libVersion++)
      .catch(e => toast(`The sample book could not be added (${(e as Error).message}).`, 6000));
  }
  if (isTauri) import('@tauri-apps/api/event').then(({ listen }) => listen('volumen://desktop', () => readDesktop(core)));

  const ORDER: Layout[] = ['auto', 1, 2, 3];
  const NAMES = ['one column', 'two columns', 'three columns'];
  async function cycleLayout() {
    settings.layout = ORDER[(ORDER.indexOf(settings.layout) + 1) % ORDER.length];
    save();
    await reader.settingsChanged('layout');
    const name = NAMES[ui.cols - 1];
    toast(settings.layout === 'auto' ? `Auto: ${name}` : ui.colsReduced ? `${NAMES[(settings.layout as number) - 1]} need a wider window: ${name}` : name[0].toUpperCase() + name.slice(1));
  }

  const typing = (t: EventTarget | null) => !!(t as Element)?.closest?.('textarea, input:not([type=checkbox]):not([type=radio]), select, [contenteditable]');

  function onKey(e: KeyboardEvent) {
    if (e.metaKey || e.altKey) return;
    if (e.ctrlKey) {
      if (e.key === 'q') { e.preventDefault(); reader.flush(); shell.quit(); }
      if ((e.key === 'f' || e.key === 'F') && ui.view === 'reader') { e.preventDefault(); ui.mapOpen ? map.focusFind() : openFind(); }
      return;
    }
    if (typing(e.target)) {
      if (e.key === 'Escape') { (e.target as HTMLElement).blur(); reader.stage?.focus({ preventScroll: true }); e.preventDefault(); }
      return;
    }
    if (e.key === 'F11' || (e.key === 'f' && !ui.sheet)) { e.preventDefault(); shell.toggleFullscreen(); return; }
    if (ui.sheet) return;                 // the open sheet handles its own keys
    if (ui.view === 'library') { if (library?.key(e)) e.preventDefault(); return; }
    if (ui.mapOpen) { if (map.key(e)) e.preventDefault(); return; }
    if (ui.chip) { if (chip?.key(e)) e.preventDefault(); return; }
    if (reader.input.key(e)) { e.preventDefault(); return; }
    const k = e.key;
    if (k === 'm' || k === 'M') { e.preventDefault(); map.open(); }
    else if (k === 's' || k === 'S') { e.preventDefault(); ui.sheet = 'settings'; }
    else if (k === '?') { e.preventDefault(); ui.sheet = 'help'; }
    else if (k === '/') { e.preventDefault(); openFind(); }
    else if (k === 'q' || k === 'Q') { e.preventDefault(); reader.close(); }
    else if (k === 'v' || k === 'V') { e.preventDefault(); reader.cursor.start(); }
    else if (k === 'c' || k === 'C') { e.preventDefault(); cycleLayout(); }
    else if (k === 'Tab' && !e.shiftKey && document.activeElement === reader.stage) { /* let Tab reach the bar */ }
  }
</script>

<svelte:window onkeydown={onKey} onkeyup={e => reader.input.keyUp(e)} onblur={() => reader.input.blur()} />

<div class="app">
  {#if embedded}
    {#if ui.view !== 'reader'}<p class="failed embed-wait" role="status">{embedError || 'Opening the book…'}</p>{/if}
  {:else}
    <Library bind:this={library} {core} {reader} hidden={ui.view !== 'library'} />
  {/if}
  <ReaderView {reader} {map} hidden={ui.view !== 'reader'} bind:chip bind:findBar />
  {#if ui.busy}<div class="busy" role="status">{ui.busy}</div>{/if}
  <Toast />
</div>

<style>
  /* clipped, never scrolled: shadows of things at the window's edge reach past it, and a
     frame that merely hides its overflow can still be scrolled (focus moving to a control
     did, and on a phone the whole page shifted by a shadow's width) */
  .app { position: relative; height: 100%; overflow: clip; }
  .busy { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); font: 600 var(--t-m)/1 var(--f-ui); color: var(--ink-3); }
</style>
