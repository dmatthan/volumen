<script lang="ts">
  import { untrack } from 'svelte';
  import { linkOf, canSeal, unseal } from '../core/share';
  import { fetchSealed, joinedOf } from '../core/service';
  import type { Core } from '../core/types';
  import { ui, Reader, toast } from '../reader/reader.svelte';
  import { MapCtl } from '../reader/map.svelte';
  import { settings, save, type Layout } from '../reader/settings.svelte';
  import { themes, readDesktop, setOption, resetOptions, themeById } from '../reader/themes.svelte';
  import { fitStats, resetFitStats, residual } from '../reader/verify';
  import { shell } from '../core/shell';
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
    import('../core/shell').then(async ({ isTauri }) => {
      if (!isTauri) return;
      const { invoke } = await import('@tauri-apps/api/core');
      if (!(await invoke<boolean>('selftest_mode'))) return;
      setHints(false);
      const { selftest, wheelProbe, sheetProbe, contentProbe, libraryProbe, searchProbe, probeStrings, scaleProbe } = await import('../selftest');
      const arg = await invoke<string>('selftest_arg');
      const log = (s: string) => invoke<void>('dev_log', { msg: s });
      // a self-test must always end: on failure it says why, and a watchdog quits a stall
      const dog = setTimeout(async () => { await log('{"error":"watchdog: the self-test ran over 3 minutes"}'); shell.quit(); }, arg === 'wheel' ? 90000 : arg === 'scale' ? 480000 : 180000);
      try { await (arg === 'wheel' ? wheelProbe(reader, log) : arg === 'sheet' ? sheetProbe(reader, log) : arg === 'content' ? contentProbe(reader, log) : arg === 'library' ? libraryProbe(reader, log) : arg === 'search' ? searchProbe(reader, log) : arg === 'probe' ? probeStrings(reader, log) : arg === 'scale' ? scaleProbe(reader, log) : selftest(reader, map, log)); }
      catch (e) { await log(JSON.stringify({ error: String((e as Error)?.message || e) })); }
      finally { clearTimeout(dog); await shell.quit(); }
    });
  }
  let library: Library | undefined = $state();
  let findBar: any = $state();
  function openFind() {
    ui.sheet = null; ui.chip = null;
    if (reader.finder.open) findBar?.refocus(); else reader.finder.show();
  }
  let chip: any = $state();

  // The phone's back gesture (and the browser's back): closes what is on top, a sheet, a
  // large image, the map, then the book. Each layer that opens adds a history entry; one
  // the app closes itself takes its entry back, so history holds only what is open.
  // the colour around the page: at once between views, with the map's fade for the map
  let edgeView = '';
  $effect(() => {
    const v = `${ui.view}/${ui.mapOpen}/${!!ui.lightbox}`;
    const viewChanged = edgeView.split('/')[0] !== ui.view;
    edgeView = v;
    untrack(() => reader.paintEdges(viewChanged ? 0 : 250));
  });

  const layers = () => (ui.view === 'reader' ? 1 : 0) + (ui.mapOpen ? 1 : 0) + (ui.sheet ? 1 : 0) + (ui.lightbox ? 1 : 0);
  let shown = 0, popped = 0, unwinding = 0;
  $effect(() => {
    const n = layers();
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
  // a book sent as a link (core/share.ts): fetched, opened with the key in the link, added
  // and opened; the key is taken out of the address at once (history, a shared screen)
  async function openFromLink() {
    // an invitation to share books (scripts/service.sh): kept out of the address too
    const inv = /^#invite=([\w-]{22,64})$/.exec(location.hash);
    if (inv) {
      history.replaceState(history.state, '', location.pathname + location.search);
      if (ui.view === 'reader') reader.close();
      ui.invite = inv[1];
      ui.sheet = 'invite';
      return;
    }
    const l = linkOf(location.hash);
    if (!l) return;
    history.replaceState(history.state, '', location.pathname + location.search);
    if (!canSeal()) { toast('A book sent as a link opens only over https.', 6000); return; }
    toast('Opening the book you were sent…', 15000);
    try {
      let sealed: Uint8Array;
      if (l.at === 'service') sealed = await fetchSealed(l.id);
      else {
        const r = await fetch(l.url);
        if (!r.ok) throw new Error(`it is not where the link says (${r.status})`);
        sealed = new Uint8Array(await r.arrayBuffer());
      }
      const f = await unseal(sealed, l.key);
      if (typeof f === 'string') { toast(f, 6000); return; }
      const e = await core.importFile(f.bytes, f.name);
      // (a writer opening their own link is not one of its readers)
      const own = !!kv.get('share.' + e.id, null);
      if (l.at === 'service' && !own) kv.set('joined.' + e.id, { ...(joinedOf(e.id) ?? {}), id: l.id, key: l.key });
      ui.libVersion++;
      ui.toastOn = false;
      await reader.open(e.id);
      // the first time: who sent it, and how notes are made and sent (WelcomeSheet)
      if (!own && !kv.get<number>('welcomed.' + e.id, 0)) {
        kv.set('welcomed.' + e.id, Date.now());
        ui.welcome = { by: f.by ?? '' };
        ui.sheet = 'welcome';
      }
    } catch (e) {
      toast(`Couldn’t open the book you were sent: ${(e as Error).message}`, 6000);
    }
  }
  openFromLink();
  addEventListener('hashchange', openFromLink);

  // the web build's first run: the sample book, added while the library already shows
  // svelte-ignore state_referenced_locally
  if ('importSample' in core) {
    // svelte-ignore state_referenced_locally
    const web = core as ReturnType<typeof import('../core/web').webCore>;
    import('../core/web').then(({ seedSample }) => seedSample(web))
      .then(() => ui.libVersion++)
      .catch(e => toast(`The sample book could not be added (${(e as Error).message}).`, 6000));
  }
  import('../core/shell').then(async ({ isTauri }) => {
    if (!isTauri) return;
    const { listen } = await import('@tauri-apps/api/event');
    // svelte-ignore state_referenced_locally
    await listen('volumen://desktop', () => readDesktop(core));
  });

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
    if (reader.key(e)) { e.preventDefault(); return; }
    const k = e.key;
    if (k === 'm' || k === 'M') { e.preventDefault(); map.open(); }
    else if (k === 's' || k === 'S') { e.preventDefault(); ui.sheet = 'settings'; }
    else if (k === '?') { e.preventDefault(); ui.sheet = 'help'; }
    else if (k === '/') { e.preventDefault(); openFind(); }
    else if (k === 'q' || k === 'Q') { e.preventDefault(); reader.close(); }
    else if (k === 'v' || k === 'V') { e.preventDefault(); reader.pickStart(); }
    else if (k === 'c' || k === 'C') { e.preventDefault(); cycleLayout(); }
    else if (k === 'Tab' && !e.shiftKey && document.activeElement === reader.stage) { /* let Tab reach the bar */ }
  }
</script>

<svelte:window onkeydown={onKey} onkeyup={e => reader.keyUp(e)} onblur={() => reader.blur()} />

<div class="app">
  <Library bind:this={library} {core} {reader} hidden={ui.view !== 'library'} />
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
