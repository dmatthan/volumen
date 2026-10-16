<script lang="ts">
  import { copyText } from '../core/clipboard';
  import Sheet from './Sheet.svelte';
  import type { Reader } from '../reader/reader.svelte';
  import { ui, toast } from '../state.svelte';
  import { settings, save } from '../reader/settings.svelte';
  import { bundledFamilies, systemFamilies, loadFamily, chainOf, cssFamily, saveUserTheme, resetOptions, parseTheme, aiBrief, type Palette } from '../reader/themes.svelte';
  import { contrast } from '../reader/color';
  import { editor } from './editor.svelte';

  let { reader }: { reader: Reader } = $props();
  const d = $derived(editor.draft!);
  // svelte-ignore state_referenced_locally
  let mode = $state<'light' | 'dark'>(reader.isDark() ? 'dark' : 'light');
  let importing = $state(false);
  let pasted = $state('');
  let importError = $state('');
  let missing = $state(false);
  let installed = $state<string[]>([]);
  let fileInput = $state<HTMLInputElement>();

  // svelte-ignore state_referenced_locally
  systemFamilies(reader.core).then(v => (installed = v));
  // the chosen face, loaded for the preview (installed ones come over as FontFaces)
  $effect(() => {
    const fam = d.type.family;
    loadFamily(reader.core, fam).then(info => { if (editor.draft?.type.family === fam) missing = !info; });
  });

  const families = $derived([...bundledFamilies(), ...installed]);
  const pal = $derived(d[mode] as Palette);
  const previewStyle = $derived.by(() => {
    const t = d.type, o = d.options;
    const w = o.boldText ? t.boldText : t.weight;
    const ax = Object.entries(t.axes).map(([k, v]) => `"${k}" ${v}, `).join('');
    const fs = 19 * t.scale;
    return [
      `background:${pal.paper}`, `color:${pal.ink}`, `--acc:${pal.accent}`,
      `font-family:${cssFamily(chainOf(t), t.fallback)}`, `font-size:${fs}px`, `line-height:${Math.round(fs * o.lineSpacing)}px`,
      `font-weight:${w}`, `font-variation-settings:${ax}"wght" ${w}`, `--wB:${Math.min(1000, t.bold + (w - t.weight))}`, `--ax:${ax}`,
      `letter-spacing:${(o.charSpacing / 100) * fs}px`, `word-spacing:${(o.wordSpacing / 100) * fs}px`,
      `text-align:${o.justify ? 'justify' : 'left'}`,
    ].join(';');
  });

  const R = { lineSpacing: [1.15, 2.2, 0.05], charSpacing: [-5, 15, 1], wordSpacing: [-10, 50, 2], margins: [-2, 3, 1] } as const;
  function step(k: keyof typeof R, dir: number) {
    const [lo, hi, s] = R[k];
    d.options[k] = Math.round(Math.min(hi, Math.max(lo, d.options[k] + dir * s)) * 100) / 100;
  }
  function stepType(k: 'scale' | 'weight' | 'bold' | 'boldText', dir: number) {
    const t = d.type;
    if (k === 'scale') t.scale = Math.round(Math.min(1.3, Math.max(0.8, t.scale + dir * 0.02)) * 100) / 100;
    else if (k === 'weight') { t.weight = Math.min(700, Math.max(200, t.weight + dir * 10)); t.boldText = Math.max(t.boldText, t.weight); t.bold = Math.max(t.bold, t.weight + 100); }
    else if (k === 'bold') t.bold = Math.min(1000, Math.max(t.weight + 100, t.bold + dir * 10));
    else t.boldText = Math.min(900, Math.max(t.weight, t.boldText + dir * 10));
  }
  const MARGINS = ['Narrowest', 'Narrow', 'Designed', 'Wide', 'Wider', 'Widest'];
  const pct = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + '%';
  const ratio = (a: string, b: string) => contrast(a, b).toFixed(1);

  function saveIt() {
    const t = $state.snapshot(d);
    t.name = t.name.trim() || 'My theme';
    saveUserTheme(t);
    // the design now carries any customisation it started from
    resetOptions(t);
    settings.theme = t.id; save();
    reader.settingsChanged('layout');
    toast(`${t.name} saved`);
    ui.sheet = 'settings';
  }

  function useImport(text: string) {
    const r = parseTheme(text);
    if ('error' in r) { importError = r.error; return; }
    const keep = editor.isNew ? r.theme.id : d.id;
    editor.draft = { ...r.theme, id: keep };
    editor.notes = r.notes;
    importError = ''; importing = false; pasted = '';
  }
  async function pickFile(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) useImport(await f.text());
    (e.target as HTMLInputElement).value = '';
  }
  async function copyBrief() {
    const text = aiBrief(installed);
    if (await copyText(text)) toast('Brief copied: paste it into an AI chat, then paste its answer here');
    else { pasted = text; importing = true; toast('Copy the brief from the box'); }
  }
</script>

{#snippet stepper(label: string, value: string, dec: () => void, inc: () => void)}
  <div class="row">
    <span class="r-l">{label}</span>
    <span class="stp">
      <button class="mini" onclick={dec} aria-label="Less {label.toLowerCase()}">−</button>
      <output>{value}</output>
      <button class="mini" onclick={inc} aria-label="More {label.toLowerCase()}">+</button>
    </span>
  </div>
{/snippet}
{#snippet colour(label: string, k: keyof Palette, against?: string)}
  <label class="clr">
    <input type="color" value={pal[k]} oninput={e => (d[mode]![k] = (e.target as HTMLInputElement).value)} />
    <span class="c-l">{label}</span>
    {#if against}<span class="c-r" class:low={contrast(pal.paper, pal[k]) < (k === 'ink' ? 7 : 3)}>{ratio(pal.paper, pal[k])}:1</span>{/if}
  </label>
{/snippet}

<Sheet label={editor.isNew ? 'New theme' : 'Edit theme'} onclose={() => (ui.sheet = 'settings')} wide>
  <div class="top">
    <div class="ttl">
      <p class="eyebrow">{editor.isNew ? 'New theme' : 'Edit theme'}</p>
      <input class="name" bind:value={d.name} maxlength="40" aria-label="Theme name" spellcheck="false" />
    </div>
    <div class="tools">
      <button class="btn quiet" onclick={() => { importing = !importing; importError = ''; }} aria-expanded={importing}>Import</button>
      <button class="btn quiet" onclick={copyBrief} title="A brief an AI can follow to design a theme you can paste back here">Copy AI brief</button>
    </div>
  </div>

  {#if importing}
    <div class="import">
      <textarea bind:value={pasted} rows="6" spellcheck="false" placeholder="Paste a theme here: a file’s contents, or an AI’s answer to the brief." aria-label="Theme to import"></textarea>
      {#if importError}<p class="err">{importError}</p>{/if}
      <div class="i-acts">
        <button class="btn quiet" onclick={() => fileInput?.click()}>Open a file…</button>
        <button class="btn primary" disabled={!pasted.trim()} onclick={() => useImport(pasted)}>Use this theme</button>
      </div>
      <input type="file" accept=".json,application/json,text/plain" hidden bind:this={fileInput} onchange={pickFile} />
    </div>
  {/if}
  {#if editor.notes.length}<div class="notes">{#each editor.notes as n}<p>{n}</p>{/each}</div>{/if}

  <div class="body">
    <div class="form">
      <div class="group">
        <div class="legend"><span>Typeface</span></div>
        <input class="field" list="vol-families" bind:value={d.type.family} spellcheck="false" aria-label="Font family" />
        <datalist id="vol-families">{#each families as f}<option value={f}></option>{/each}</datalist>
        {#if missing}<p class="hint warn">{d.type.family} is not installed here; {d.type.fallback === 'sans' ? 'Inter' : 'Literata'} stands in.</p>{/if}
        <div class="chips">
          <button class="chip" aria-pressed={d.type.fallback === 'serif'} onclick={() => (d.type.fallback = 'serif')}>Serif</button>
          <button class="chip" aria-pressed={d.type.fallback === 'sans'} onclick={() => (d.type.fallback = 'sans')}>Sans</button>
        </div>
        {@render stepper('Size adjust', '×' + d.type.scale.toFixed(2), () => stepType('scale', -1), () => stepType('scale', 1))}
        {@render stepper('Weight', String(d.type.weight), () => stepType('weight', -1), () => stepType('weight', 1))}
        {@render stepper('Bold weight', String(d.type.bold), () => stepType('bold', -1), () => stepType('bold', 1))}
        {@render stepper('Bold Text weight', String(d.type.boldText), () => stepType('boldText', -1), () => stepType('boldText', 1))}
        {#if Object.keys(d.type.axes).length}<p class="hint">Axes: {Object.entries(d.type.axes).map(([k, v]) => `${k} ${v}`).join(', ')}</p>{/if}
      </div>

      <div class="group">
        <div class="legend"><span>Colours</span>
          <span class="chips sm">
            <button class="chip" aria-pressed={mode === 'light'} onclick={() => (mode = 'light')}>Light</button>
            <button class="chip" aria-pressed={mode === 'dark'} onclick={() => (mode = 'dark')}>Dark</button>
          </span>
        </div>
        <div class="clrs">
          {@render colour('Paper', 'paper')}
          {@render colour('Ink', 'ink', pal.paper)}
          {@render colour('Accent', 'accent', pal.paper)}
        </div>
      </div>

      <div class="group">
        <div class="legend"><span>Layout</span></div>
        <label class="row"><span class="r-l">Bold text</span><span class="tog"><input type="checkbox" bind:checked={d.options.boldText} /></span></label>
        {@render stepper('Line spacing', d.options.lineSpacing.toFixed(2), () => step('lineSpacing', -1), () => step('lineSpacing', 1))}
        {@render stepper('Character spacing', pct(d.options.charSpacing), () => step('charSpacing', -1), () => step('charSpacing', 1))}
        {@render stepper('Word spacing', pct(d.options.wordSpacing), () => step('wordSpacing', -1), () => step('wordSpacing', 1))}
        {@render stepper('Margins', MARGINS[d.options.margins + 2], () => step('margins', -1), () => step('margins', 1))}
        <label class="row"><span class="r-l">Justify text</span><span class="tog"><input type="checkbox" bind:checked={d.options.justify} /></span></label>
      </div>
    </div>

    <div class="preview" style={previewStyle} aria-label="Preview">
      <p class="pv-h">Chapter I</p>
      <p>Miss Brooke had that kind of beauty which seems to be thrown into relief by poor dress. Her hand and wrist were so finely formed that she could wear sleeves not less bare of style than those in which the Blessed Virgin appeared to <i>Italian painters</i>.</p>
      <p class="ind">She was usually spoken of as being <mark>remarkably clever</mark>, but with the addition that her sister Celia had more <b>common-sense</b>.</p>
    </div>
  </div>

  <div class="acts two">
    <button class="btn quiet" onclick={() => (ui.sheet = 'settings')}>Cancel <kbd>Esc</kbd></button>
    <button class="btn primary" onclick={saveIt}>{editor.isNew ? 'Save theme' : 'Save changes'}</button>
  </div>
</Sheet>

<style>
  .top { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .ttl { display: grid; gap: 4px; min-width: 0; flex: 1; }
  .name { font: 650 var(--t-xl)/1.2 var(--f-ui); color: var(--ink); background: transparent; border: 0; border-bottom: 1.5px solid var(--rule); padding: 2px 0 4px; outline: none; min-width: 0; }
  .name:focus { border-bottom-color: var(--accent); }
  .tools { display: flex; gap: 4px; }
  .tools :global(.btn), .i-acts :global(.btn) { min-height: 38px; padding: 0 12px; font-size: var(--t-s); }
  .import { display: grid; gap: 8px; }
  .import textarea { box-sizing: border-box; width: 100%; resize: vertical; border-radius: var(--r-m); border: 1.5px solid var(--rule); background: var(--surface); color: var(--ink); font: 500 13px/1.45 ui-monospace, "JetBrains Mono", monospace; padding: 10px 12px; outline: none; }
  .import textarea:focus { border-color: var(--accent); }
  .i-acts { display: flex; justify-content: flex-end; gap: 6px; }
  .err { margin: 0; font: 600 var(--t-s)/1.4 var(--f-ui); color: oklch(0.55 0.17 30); }
  .notes { border-radius: var(--r-m); background: var(--wash); padding: 8px 12px; }
  .notes p { margin: 2px 0; font: 500 var(--t-s)/1.45 var(--f-ui); color: var(--ink-2); }
  .body { display: grid; gap: 20px; }
  @media (min-width: 720px) { .body { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; } .preview { position: sticky; top: 0; } }
  .form { display: grid; gap: 18px; }
  .field { box-sizing: border-box; width: 100%; min-height: 42px; border-radius: var(--r-m); border: 1.5px solid var(--rule); background: transparent; color: var(--ink); font: 600 var(--t-m)/1 var(--f-ui); padding: 0 12px; outline: none; }
  .field:focus { border-color: var(--accent); }
  .warn { color: oklch(0.58 0.14 60); }
  .chips.sm :global(.chip) { min-height: 30px; padding: 0 10px; font-size: var(--t-s); }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 42px; }
  label.row { cursor: pointer; }
  .r-l { font: 600 var(--t-m)/1.2 var(--f-ui); color: var(--ink); }
  .stp { display: inline-flex; align-items: center; gap: 4px; }
  .stp output { min-width: 6.2em; text-align: center; font: 650 var(--t-s)/1 var(--f-ui); font-variant-numeric: tabular-nums; }
  .mini { appearance: none; cursor: pointer; width: 36px; height: 34px; border-radius: var(--r-s); border: 1.5px solid var(--rule); background: transparent; color: var(--ink-2); font: 600 18px/1 var(--f-ui); }
  :global(html:not(.touchui)) .mini:hover { background: var(--hover); }
  .tog input { appearance: none; margin: 0; width: 46px; height: 28px; border-radius: 14px; background: var(--rule); position: relative; cursor: pointer; transition: background-color .2s; display: block; }
  .tog input::after { content: ""; position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: var(--surface); box-shadow: 0 1px 3px oklch(0 0 0 / 0.25); transition: transform .2s; }
  .tog input:checked { background: var(--accent); }
  .tog input:checked::after { transform: translateX(18px); }
  .clrs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .clr { display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto; column-gap: 10px; align-items: center; padding: 8px; border-radius: var(--r-m); border: 1.5px solid var(--rule); cursor: pointer; }
  .clr input { grid-row: span 2; appearance: none; width: 34px; height: 34px; padding: 0; border: 0; border-radius: 50%; background: none; cursor: pointer; }
  .clr input::-webkit-color-swatch-wrapper { padding: 0; }
  .clr input::-webkit-color-swatch { border: 1px solid color-mix(in srgb, var(--ink) 20%, transparent); border-radius: 50%; }
  .c-l { font: 600 var(--t-s)/1.2 var(--f-ui); color: var(--ink); }
  .c-r { font: 600 var(--t-xs)/1.2 var(--f-ui); color: var(--ink-3); font-variant-numeric: tabular-nums; }
  .c-r.low { color: oklch(0.58 0.16 35); }
  .preview { border-radius: var(--r-l); padding: 24px 26px 28px; box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 10%, transparent); hyphens: auto; font-synthesis: none; transition: background-color .3s, color .3s; }
  .preview p { margin: 0; }
  .preview .ind { text-indent: 1.3em; }
  .preview .pv-h { font-size: 1.3em; line-height: 1.25; margin-bottom: 0.7em; font-weight: var(--wB); font-variation-settings: var(--ax) "wght" var(--wB); text-align: left; }
  .preview b { font-weight: var(--wB); font-variation-settings: var(--ax) "wght" var(--wB); }
  .preview mark { color: inherit; background: color-mix(in srgb, var(--acc) 26%, transparent); border-radius: 0.25em; padding: 0 0.08em; }
</style>
