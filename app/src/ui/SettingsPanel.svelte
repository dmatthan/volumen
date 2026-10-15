<script lang="ts">
  import { copyText } from './clipboard';
  import { onMount, tick } from 'svelte';
  import { touchUI } from './touch';
  import type { Reader } from '../reader/reader.svelte';
  import { ui, toast } from '../reader/reader.svelte';
  import { settings, save, SIZES, type Settings, type Layout } from '../reader/settings.svelte';
  import { themes, allThemes, themeById, optionsOf, optionChanged, anyOptionChanged, setOption, resetOptions, resolve, loadFamily, deleteUserTheme, exportTheme, type Options, type Theme } from '../reader/themes.svelte';
  import { editor } from './editor.svelte';
  import { shell } from '../core/shell';

  /** Themes and settings, as one small panel under the Aa button: the main page holds
   *  what is changed often; the theme's own options and the rare reading switches are
   *  one level down. Nothing here scrolls, nothing blurs. */
  let { reader, page: startPage = 'main' }: { reader: Reader; page?: Page } = $props();
  type Page = 'main' | 'theme' | 'reading';
  // svelte-ignore state_referenced_locally
  let page = $state<Page>(startPage);
  let panel: HTMLElement;
  const prev = document.activeElement as HTMLElement | null;

  const theme = $derived(themeById(settings.theme));
  const o = $derived(optionsOf(theme));
  const dark = $derived(reader.isDark());
  const size = $derived(settings.size ?? (reader.M?.phone ? 18 : 20));

  $effect(() => { for (const t of themes.user) loadFamily(reader.core, t.type.family); });
  onMount(() => {
    focusFirst();
    const away = (e: PointerEvent) => {
      const t = e.target as Element;
      if (panel.contains(t) || t.closest?.('[data-settings-toggle]') || t.closest?.('.wrap')) return;
      // a tap beside the panel only puts it away (on a phone it would turn the page too)
      if (e.pointerType !== 'mouse') e.stopPropagation();
      close();
    };
    window.addEventListener('pointerdown', away, true);
    // keys reach the panel wherever focus is while it is open
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', key, true); prev?.focus?.({ preventScroll: true }); };
  });
  function focusFirst() { panel?.querySelector<HTMLElement>('[data-first]')?.focus({ preventScroll: true }); }
  async function go(p: Page) { page = p; await tick(); focusFirst(); }
  function close() { ui.sheet = null; }

  let relayT = 0;
  const relayout = () => { clearTimeout(relayT); relayT = window.setTimeout(() => reader.settingsChanged('layout'), 60); };
  function setSize(d: number) {
    let i = SIZES.indexOf(size);
    if (i < 0) i = SIZES.findIndex(s => s >= size);
    const v = SIZES[Math.max(0, Math.min(SIZES.length - 1, i + d))];
    if (v === size) return;
    settings.size = v; save(); relayout();
  }
  function set<K extends keyof Settings>(k: K, v: Settings[K]) {
    if (settings[k] === v) return;
    settings[k] = v; save();
    if (k === 'layout' || k === 'view' || k === 'theme') relayout();
  }
  function opt<K extends keyof Options>(k: K, v: Options[K]) {
    if (o[k] === v) return;
    setOption(theme, k, v); relayout();
  }
  const R = { lineSpacing: [1.15, 2.2, 0.05], charSpacing: [-5, 15, 1], wordSpacing: [-10, 50, 2], margins: [-2, 3, 1] } as const;
  function step(k: keyof typeof R, d: number) {
    const [lo, hi, s] = R[k];
    opt(k, Math.round(Math.min(hi, Math.max(lo, o[k] + d * s)) * 100) / 100);
  }
  const MARGINS = ['Narrowest', 'Narrow', 'Designed', 'Wide', 'Wider', 'Widest'];
  const pct = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + '%';

  function cycleTheme(d: number) {
    const list = allThemes(), i = list.findIndex(t => t.id === theme.id);
    set('theme', list[(i + d + list.length) % list.length].id);
  }
  function newTheme() { editor.start(theme, true); ui.sheet = 'theme'; }
  function editTheme() { editor.start(theme, false); ui.sheet = 'theme'; }
  async function exportIt() {
    const text = exportTheme({ ...theme, options: o });
    if (await copyText(text)) toast('Theme copied as text');
    await shell.saveText(`${theme.name}.theme.json`, text, 'json').catch(() => {});
  }
  function deleteIt() {
    const name = theme.name;
    set('theme', 'original'); deleteUserTheme(theme.id); go('main');
    toast(`${name} deleted`);
  }

  const APPEAR: Settings['appearance'][] = ['auto', 'light', 'dark'];
  const LAYOUTS: Layout[] = ['auto', 1, 2, 3];

  function key(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey || ui.sheet !== 'settings') return;
    const k = e.key;
    const typing = (e.target as Element).closest?.('input[type=text], input:not([type]), textarea, [contenteditable]');
    if (typing) return;
    let done = true;
    if (k === 'Escape') { if (page !== 'main') go('main'); else close(); }
    else if ((k === 'Backspace' || k === 'ArrowLeft' || k === 'h') && page !== 'main') go('main');
    else if (k === 's' || k === 'S') close();
    else if (k === '-' || k === '_') setSize(-1);
    else if (k === '=' || k === '+') setSize(1);
    else if (k === 't') cycleTheme(1);
    else if (k === 'T') cycleTheme(-1);
    else if (k === 'p') set('appearance', APPEAR[(APPEAR.indexOf(settings.appearance) + 1) % 3]);
    else if (k === 'e') set('view', settings.view === 'flow' ? 'minimal' : 'flow');
    else if (k === '1' || k === '2' || k === '3') set('layout', +k as Layout);
    else if (k === 'a') set('layout', 'auto');
    else if (k === 'c') go(page === 'theme' ? 'main' : 'theme');
    else if (k === 'o') go(page === 'reading' ? 'main' : 'reading');
    else if (k === 'b') opt('boldText', !o.boldText);
    else if (k === 'j') opt('justify', !o.justify);
    else if (k === 'y') opt('hyphenate', !o.hyphenate);
    else if (k === '0' && page === 'theme') { resetOptions(theme); relayout(); }
    else if (k === 'n') newTheme();
    else if (k === 'v') set('veil', !settings.veil);
    else if (k === 'Tab') { trap(e); done = false; }
    else done = false;
    if (done) { e.preventDefault(); e.stopImmediatePropagation(); }
  }
  function trap(e: KeyboardEvent) {
    const f = [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), input')];
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }

  const card = (t: Theme) => {
    const p = resolve(t, dark).palette;
    return p ? `--pp:${p.paper};--pi:${p.ink};--pa:${p.accent}` : '';
  };
  const face = (t: Theme) => {
    const r = resolve(t, dark);
    const ax = r.axes.map(([k, v]) => `"${k}" ${v}, `).join('');
    return `font-family:${r.css};font-weight:${r.wght};font-variation-settings:${ax}"wght" ${r.wght}`;
  };
</script>

{#snippet stepper(label: string, k: keyof typeof R, value: string)}
  <div class="row">
    <span class="lbl">{label}{#if optionChanged(theme, k)}<span class="dot" title="Changed from {theme.name}’s design"></span>{/if}</span>
    <span class="stp" role="group" aria-label={label}>
      <button onclick={() => step(k, -1)} aria-label="Less {label.toLowerCase()}">−</button>
      <output>{value}</output>
      <button onclick={() => step(k, 1)} aria-label="More {label.toLowerCase()}">+</button>
    </span>
  </div>
{/snippet}
{#snippet toggle(label: string, on: boolean, flip: () => void, keyName: string, changed = false)}
  <button class="row tg" role="switch" aria-checked={on} onclick={flip}>
    <span class="lbl">{label} <kbd>{keyName}</kbd>{#if changed}<span class="dot"></span>{/if}</span>
    <span class="sw" aria-hidden="true"></span>
  </button>
{/snippet}
{#snippet seg<T>(label: string, items: { v: T; t: string; k?: string }[], cur: T, pick: (v: T) => void)}
  <div class="seg" role="radiogroup" aria-label={label}>
    {#each items as it}
      <button role="radio" aria-checked={cur === it.v} onclick={() => pick(it.v)} title={it.k ? `${it.t} (${it.k})` : it.t}>{it.t}</button>
    {/each}
  </div>
{/snippet}

<div class="panel lift" bind:this={panel} role="dialog" aria-label="Themes and settings" tabindex="-1">
  {#key page}
    <div class="page">
      {#if page === 'main'}
        <header class="ph">
          <h2>Themes &amp; Settings</h2>
          <button class="x" onclick={close} aria-label="Close (Esc)"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17" /></svg></button>
        </header>
        <div class="top">
          <div class="pill size" role="group" aria-label="Size">
            <button data-first onclick={() => setSize(-1)} aria-label="Smaller type (−)" disabled={size <= SIZES[0]}><span class="a1">A</span></button>
            <button onclick={() => setSize(1)} aria-label="Larger type (+)" disabled={size >= SIZES[SIZES.length - 1]}><span class="a2">A</span></button>
          </div>
          <div class="pill appear" role="radiogroup" aria-label="Appearance (P)">
            <button role="radio" aria-checked={settings.appearance === 'auto'} onclick={() => set('appearance', 'auto')} title={themes.desktop ? 'Match the desktop' : 'Match the system'} aria-label="Automatic">
              <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.5" /><path d="M12 4.5v15a7.5 7.5 0 0 0 0-15z" class="fill" /></svg>
            </button>
            <button role="radio" aria-checked={settings.appearance === 'light'} onclick={() => set('appearance', 'light')} title="Light" aria-label="Light">
              <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></svg>
            </button>
            <button role="radio" aria-checked={settings.appearance === 'dark'} onclick={() => set('appearance', 'dark')} title="Dark" aria-label="Dark">
              <svg viewBox="0 0 24 24"><path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" /></svg>
            </button>
          </div>
        </div>
        <div class="themes" role="radiogroup" aria-label="Theme (T)">
          {#each allThemes() as t (t.id)}
            <button class="th" role="radio" aria-checked={t.id === theme.id} style={card(t)} onclick={() => set('theme', t.id)}
              title={t.desktop && themes.desktop ? `${t.name}: colours from ${themes.desktop.name}` : t.name}>
              <span class="aa" style={face(t)}>Aa</span>
              <span class="nm">{t.name}</span>
            </button>
          {/each}
          <button class="th add" onclick={newTheme} title="New theme (N)" aria-label="New theme">
            <svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12" /></svg><span class="nm">New</span>
          </button>
        </div>
        <button class="row nav" onclick={() => go('theme')}>
          <span class="lbl"><svg class="ic" viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>Customise {theme.name} <kbd>C</kbd>{#if anyOptionChanged(theme)}<span class="dot"></span>{/if}</span>
          <svg class="chev" viewBox="0 0 24 24"><path d="m10 7 5 5-5 5" /></svg>
        </button>
        <!-- (a phone shows one page, whatever the view and the columns) -->
        {#if !ui.phone}
        <div class="row">
          <span class="lbl">View <kbd>E</kbd></span>
          {@render seg('View', [{ v: 'flow', t: 'Flow' }, { v: 'minimal', t: 'Minimal' }], settings.view, v => set('view', v as Settings['view']))}
        </div>
        <div class="row">
          <span class="lbl">Columns</span>
          {@render seg('Columns', LAYOUTS.map(v => ({ v, t: v === 'auto' ? 'Auto' : String(v), k: v === 'auto' ? 'A' : String(v) })), settings.layout, v => set('layout', v as Layout))}
        </div>
        {#if settings.layout !== 'auto' && ui.colsReduced}<p class="note">Too narrow for {settings.layout} here; showing {ui.cols}.</p>{/if}
        {/if}
        <button class="row nav" onclick={() => go('reading')}>
          <span class="lbl"><svg class="ic" viewBox="0 0 24 24"><path d="M5 5.5h5.5a2 2 0 0 1 1.5.7 2 2 0 0 1 1.5-.7H19v13h-5.5a2 2 0 0 0-1.5.7 2 2 0 0 0-1.5-.7H5z" /><path d="M12 6.2v13" /></svg>Reading <kbd>O</kbd></span>
          <svg class="chev" viewBox="0 0 24 24"><path d="m10 7 5 5-5 5" /></svg>
        </button>
        {#if touchUI()}
          <button class="row nav" onclick={() => (ui.sheet = 'help')}>
            <span class="lbl"><svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M9.8 9.6a2.3 2.3 0 1 1 3.2 2.1c-.6.3-1 .8-1 1.5v.4M12 16.6v.1" /></svg>Gestures</span>
            <svg class="chev" viewBox="0 0 24 24"><path d="m10 7 5 5-5 5" /></svg>
          </button>
        {/if}
      {:else if page === 'theme'}
        <header class="ph sub">
          <button class="back" data-first onclick={() => go('main')} aria-label="Back (Esc)"><svg viewBox="0 0 24 24"><path d="m14 7-5 5 5 5" /></svg></button>
          <h2>Customise {theme.name}</h2>
          <button class="txt" disabled={!anyOptionChanged(theme)} onclick={() => { resetOptions(theme); relayout(); }} title="Back to {theme.name}’s design (0)">Reset</button>
        </header>
        <div class="list">
          {@render toggle('Bold text', o.boldText, () => opt('boldText', !o.boldText), 'B', optionChanged(theme, 'boldText'))}
          {@render stepper('Line spacing', 'lineSpacing', o.lineSpacing.toFixed(2))}
          {@render stepper('Character spacing', 'charSpacing', pct(o.charSpacing))}
          {@render stepper('Word spacing', 'wordSpacing', pct(o.wordSpacing))}
          {@render stepper('Margins', 'margins', MARGINS[o.margins + 2])}
          {@render toggle('Justify text', o.justify, () => opt('justify', !o.justify), 'J', optionChanged(theme, 'justify'))}
          {@render toggle('Hyphenation', o.hyphenate, () => opt('hyphenate', !o.hyphenate), 'Y', optionChanged(theme, 'hyphenate'))}
        </div>
        <div class="foot">
          <button class="txt" onclick={newTheme}>New theme from this <kbd>N</kbd></button>
          {#if !theme.builtin}
            <span class="sp"></span>
            <button class="txt" onclick={editTheme}>Edit</button>
            <button class="txt" onclick={exportIt}>Export</button>
            <button class="txt danger" onclick={deleteIt}>Delete</button>
          {/if}
        </div>
      {:else}
        <header class="ph sub">
          <button class="back" data-first onclick={() => go('main')} aria-label="Back (Esc)"><svg viewBox="0 0 24 24"><path d="m14 7-5 5 5 5" /></svg></button>
          <h2>Reading</h2>
          <span></span>
        </header>
        <div class="list">
          {#if !ui.phone}{@render toggle('Veil the neighbouring columns', settings.veil, () => set('veil', !settings.veil), 'V')}{/if}
          <div class="row">
            <span class="lbl">Motion</span>
            {@render seg('Motion', [{ v: 'system', t: 'As system' }, { v: 'reduce', t: 'Reduced' }], settings.motion, v => set('motion', v as Settings['motion']))}
          </div>
        </div>
      {/if}
    </div>
  {/key}
</div>

<style>
  .panel {
    position: absolute; z-index: 45; top: 54px; right: 14px; width: 344px; max-width: calc(100% - 28px); box-sizing: border-box;
    /* never past the window: the page scrolls inside the still frame (whose shadow is an
       image, so scrolling repaints nothing costly) */
    max-height: calc(100% - 66px); display: flex; flex-direction: column;
    background: var(--sheet); color: var(--ink); border-radius: var(--r-l); border: 1px solid var(--rule);
    outline: none; animation: open .2s cubic-bezier(.2, .8, .2, 1);
  }
  @keyframes open { from { opacity: 0; transform: translateY(-6px) scale(.98); transform-origin: top right; } }
  .page { padding: 14px 14px 12px; display: grid; gap: 10px; animation: page .18s cubic-bezier(.2, .8, .2, 1); min-height: 0; overflow-y: auto; overflow-x: hidden; touch-action: pan-y; overscroll-behavior: contain; border-radius: inherit; }
  @keyframes page { from { opacity: 0; transform: translateX(10px); } }
  .ph { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 30px; padding: 0 2px; }
  .ph h2 { margin: 0; font: 650 var(--t-m)/1.2 var(--f-ui); color: var(--ink); flex: 1; }
  .ph.sub h2 { text-align: center; }
  .ph.sub > :last-child { min-width: 52px; text-align: right; }
  button { appearance: none; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; padding: 0; }
  button:disabled { opacity: .35; cursor: default; }
  svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .x, .back { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; color: var(--ink-2); background: var(--read); }
  :global(html:not(.touchui)) .x:hover, :global(html:not(.touchui)) .back:hover { background: var(--hover); }
  .txt { font: 600 var(--t-s)/1 var(--f-ui); color: var(--accent); padding: 6px 4px; border-radius: 6px; }
  .txt.danger { color: oklch(0.58 0.16 28); }

  .top { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .pill { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; background: var(--read); border-radius: 12px; padding: 3px; gap: 3px; }
  .pill button { height: 38px; border-radius: 9px; display: grid; place-items: center; color: var(--ink-2); }
  :global(html:not(.touchui)) .pill button:hover:not(:disabled) { background: var(--hover); }
  .pill button[aria-checked="true"] { background: var(--sheet); color: var(--ink); box-shadow: 0 0 0 1px var(--rule); }
  .a1 { font: 600 14px/1 var(--f-book); }
  .a2 { font: 600 22px/1 var(--f-book); }
  .appear .fill { fill: currentColor; stroke: none; }

  .themes { display: grid; grid-template-columns: repeat(4, 1fr); gap: 7px; }
  .th {
    --pp: oklch(0.965 0.008 96); --pi: var(--ink); --pa: var(--accent);
    height: 70px; border-radius: 12px; background: var(--pp); color: var(--pi); display: grid; grid-template-rows: 1fr auto; justify-items: center; align-items: end;
    padding: 6px 4px 8px; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--pi) 14%, transparent);
  }
  :global([data-theme="dark"]) .th { --pp: oklch(0.205 0.006 96); }
  @media (prefers-color-scheme: dark) { :global(:root:not([data-theme="light"])) .th { --pp: oklch(0.205 0.006 96); } }
  .th .aa { font-size: 25px; line-height: 1; }
  .th .nm { font: 600 13px/1.2 var(--f-ui); opacity: .8; margin-top: 4px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .th[aria-checked="true"] { box-shadow: 0 0 0 2px var(--sheet), 0 0 0 4px var(--accent); }
  .th.add { --pp: transparent; color: var(--ink-2); box-shadow: inset 0 0 0 1.5px var(--rule); align-items: center; }
  .th.add svg { width: 24px; height: 24px; align-self: center; }
  .th.add .nm { opacity: 1; }
  .th:focus-visible { outline-offset: 3px; }

  .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 42px; padding: 0 4px; width: 100%; box-sizing: border-box; text-align: left; border-radius: 10px; }
  .row.nav, .row.tg { cursor: pointer; }
  :global(html:not(.touchui)) .row.nav:hover, :global(html:not(.touchui)) .row.tg:hover { background: var(--hover); }
  .lbl { display: inline-flex; align-items: center; gap: 8px; font: 600 var(--t-s)/1.25 var(--f-ui); color: var(--ink); }
  .lbl kbd { font-size: 11px; padding: 2px 5px; opacity: .45; }
  .ic { width: 18px; height: 18px; color: var(--ink-2); }
  .chev { width: 18px; height: 18px; color: var(--ink-3); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
  .seg { display: inline-grid; grid-auto-flow: column; background: var(--read); border-radius: 10px; padding: 3px; gap: 2px; }
  .seg button { height: 30px; min-width: 40px; padding: 0 10px; border-radius: 8px; font: 600 13px/1 var(--f-ui); color: var(--ink-2); }
  :global(html:not(.touchui)) .seg button:not([aria-checked="true"]):hover { background: var(--hover); }
  .seg button[aria-checked="true"] { background: var(--sheet); color: var(--ink); box-shadow: 0 0 0 1px var(--rule); }
  .note { margin: -4px 4px 0; font: 500 13px/1.4 var(--f-ui); color: var(--ink-3); }

  .list { display: grid; }
  .list > :global(*) + :global(*) { border-top: 1px solid var(--rule); border-radius: 0; }
  .stp { display: inline-grid; grid-template-columns: 34px auto 34px; align-items: center; background: var(--read); border-radius: 10px; padding: 3px; }
  .stp button { height: 30px; border-radius: 8px; font: 600 17px/1 var(--f-ui); color: var(--ink-2); }
  :global(html:not(.touchui)) .stp button:hover { background: var(--hover); }
  .stp output { min-width: 5.6em; text-align: center; font: 650 13px/1 var(--f-ui); font-variant-numeric: tabular-nums; color: var(--ink); }
  .sw { flex: none; width: 40px; height: 24px; border-radius: 12px; background: var(--rule); position: relative; transition: background-color .16s; }
  .sw::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: var(--surface); box-shadow: 0 1px 2px oklch(0 0 0 / .25); transition: transform .16s; }
  [aria-checked="true"] > .sw { background: var(--accent); }
  [aria-checked="true"] > .sw::after { transform: translateX(16px); }
  .foot { display: flex; align-items: center; gap: 4px; padding: 2px 0 0; border-top: 1px solid var(--rule); padding-top: 8px; }
  .foot .sp { flex: 1; }
  /* short windows (a laptop at 200%): denser, so it still fits without scrolling */
  @media (max-height: 700px) {
    .page { gap: 6px; padding: 10px 12px 10px; }
    .th { height: 58px; }
    .th .aa { font-size: 22px; }
    .row { min-height: 36px; }
    .pill button { height: 32px; }
  }
  /* a phone: a sheet from the bottom edge, the width of the screen, above the home
     indicator; controls a finger can hit (44 px) */
  @media (max-width: 640px) {
    .panel {
      top: auto; left: 0; right: 0; bottom: var(--kb, 0px); width: auto; max-width: none;
      max-height: calc(100% - 52px - env(safe-area-inset-top));
      border-radius: var(--r-l) var(--r-l) 0 0; border-width: 1px 0 0;
      animation: rise .28s cubic-bezier(.2, .8, .2, 1);
    }
    .page { padding: 14px 16px calc(12px + env(safe-area-inset-bottom)); gap: 10px; }
    .th { height: 60px; }
    .th .aa { font-size: 22px; }
  }
  @keyframes rise { from { transform: translateY(24px); opacity: 0; } }
  :global(.touchui) .x, :global(.touchui) .back { width: 40px; height: 40px; }
  :global(.touchui) .pill button { height: 42px; }
  :global(.touchui) .row { min-height: 44px; }
  :global(.touchui) .seg button { height: 38px; min-width: 46px; }
  :global(.touchui) .stp { grid-template-columns: 44px auto 44px; }
  :global(.touchui) .stp button { height: 40px; font-size: 20px; }
  :global(.touchui) .txt { padding: 12px 6px; }
</style>
