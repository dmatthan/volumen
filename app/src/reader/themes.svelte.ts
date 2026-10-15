import { kv } from '../core/kv';
import type { Core, FamilyLoad } from '../core/types';
import { BUNDLED, BUNDLED_SMCP } from '../core/fonts';
import { contrast, fitContrast, fromOklch, hexToRgb, tame } from './color';

/** A theme: a typeface with its own settings, the layout options it is designed for, and
 *  a light and a dark palette. The reader may change any option; the change is kept per
 *  theme as a difference from its design, so resetting is deleting it. */
export interface Palette { paper: string; ink: string; accent: string }
export interface Options {
  boldText: boolean;
  /** Line height as a multiple of the size. */
  lineSpacing: number;
  /** Letter spacing and extra word spacing, in hundredths of the size (%). */
  charSpacing: number;
  wordSpacing: number;
  /** Steps from the designed margins: positive is wider margins, a shorter measure. */
  margins: number;
  justify: boolean;
  hyphenate: boolean;
}
export interface TypeSpec {
  family: string;
  /** Which bundled faces set the characters the family lacks. */
  fallback: 'serif' | 'sans';
  /** Size multiplier, so one Size setting looks alike in every face. */
  scale: number;
  weight: number;
  /** `<b>` and headings. */
  bold: number;
  /** Body weight with Bold Text on. */
  boldText: number;
  axes: Record<string, number>;
}
export interface Theme {
  id: string;
  name: string;
  builtin?: boolean;
  /** Takes its colours from the desktop where the desktop publishes them (Omarchy). */
  desktop?: boolean;
  type: TypeSpec;
  options: Options;
  /** null: the app's own paper (Original). */
  light: Palette | null;
  dark: Palette | null;
}

const opts = (lineSpacing: number, justify: boolean, boldText = false): Options => ({ boldText, lineSpacing, charSpacing: 0, wordSpacing: 0, margins: 0, justify, hyphenate: true });

export const BUILTIN: Theme[] = [
  {
    id: 'original', name: 'Original', builtin: true, desktop: true,
    type: { family: 'Literata', fallback: 'serif', scale: 1, weight: 400, bold: 650, boldText: 520, axes: {} },
    options: opts(1.5, true), light: null, dark: null,
  },
  {
    id: 'quiet', name: 'Quiet', builtin: true,
    type: { family: 'Newsreader', fallback: 'serif', scale: 1.12, weight: 400, bold: 600, boldText: 500, axes: {} },
    options: opts(1.4, true),
    light: { paper: '#e3e2df', ink: '#46443f', accent: '#5b6675' },
    dark: { paper: '#3c3c3f', ink: '#bebcb7', accent: '#a7b2c0' },
  },
  {
    id: 'paper', name: 'Paper', builtin: true,
    type: { family: 'Charis', fallback: 'serif', scale: 1.04, weight: 400, bold: 700, boldText: 500, axes: {} },
    options: opts(1.55, true),
    light: { paper: '#f5f1e8', ink: '#1f1d1a', accent: '#86572c' },
    dark: { paper: '#232220', ink: '#d8d3c8', accent: '#d3a46e' },
  },
  {
    id: 'bold', name: 'Bold', builtin: true,
    type: { family: 'Inter', fallback: 'sans', scale: 0.95, weight: 440, bold: 720, boldText: 560, axes: {} },
    options: opts(1.5, false, true),
    light: { paper: '#ffffff', ink: '#000000', accent: '#0a5fd0' },
    dark: { paper: '#0e0e0f', ink: '#f4f4f4', accent: '#5aa2ff' },
  },
  {
    id: 'calm', name: 'Calm', builtin: true,
    type: { family: 'Fraunces', fallback: 'serif', scale: 1.04, weight: 370, bold: 600, boldText: 470, axes: { SOFT: 50, WONK: 0 } },
    options: opts(1.55, true),
    light: { paper: '#f0e4cd', ink: '#3d3024', accent: '#985a2c' },
    dark: { paper: '#3a2f25', ink: '#e6d5bb', accent: '#e0a86a' },
  },
  {
    id: 'focus', name: 'Focus', builtin: true,
    type: { family: 'Nunito Sans', fallback: 'sans', scale: 1.03, weight: 430, bold: 720, boldText: 530, axes: { wdth: 102 } },
    options: opts(1.42, false),
    light: { paper: '#fbf6ea', ink: '#1e1a15', accent: '#b0502a' },
    dark: { paper: '#1a1713', ink: '#e8dfcf', accent: '#e89a5b' },
  },
];

/** The app's own paper, as hex (tokens.css has it in OKLCH, drifting in hue). */
export const STOCK = {
  light: { paper: fromOklch(0.965, 0.008, 96), ink: fromOklch(0.24, 0.014, 262), accent: fromOklch(0.47, 0.13, 262) },
  dark: { paper: fromOklch(0.205, 0.006, 96), ink: fromOklch(0.88, 0.012, 84), accent: fromOklch(0.76, 0.1, 262) },
};

export interface DesktopPalette { name: string; paper: string; ink: string; accent: string; dark: boolean }

export const themes = $state({
  user: kv.get<Theme[]>('themes', []),
  opts: kv.get<Record<string, Partial<Options>>>('themeOpts', {}),
  desktop: null as DesktopPalette | null,
  /** Families the press has loaded, by name. */
  families: {} as Record<string, FamilyLoad>,
  /** Installed families (desktop), once asked for. */
  system: null as string[] | null,
});

export const allThemes = (): Theme[] => [...BUILTIN, ...themes.user];
export const themeById = (id: string): Theme => allThemes().find(t => t.id === id) ?? BUILTIN[0];

/** The options a theme is designed with (themes saved before an option existed take its
 *  default). */
export const designOf = (t: Theme): Options => ({ ...t.options, hyphenate: t.options.hyphenate ?? true });
export function optionsOf(t: Theme): Options {
  return { ...designOf(t), ...themes.opts[t.id] };
}
export function optionChanged(t: Theme, k: keyof Options) {
  const o = themes.opts[t.id];
  return !!o && k in o && o[k] !== designOf(t)[k];
}
export const anyOptionChanged = (t: Theme) => (Object.keys(designOf(t)) as (keyof Options)[]).some(k => optionChanged(t, k));
export function setOption<K extends keyof Options>(t: Theme, k: K, v: Options[K]) {
  const o = { ...themes.opts[t.id] };
  if (v === designOf(t)[k]) delete o[k]; else o[k] = v;
  themes.opts = { ...themes.opts, [t.id]: o };
  kv.set('themeOpts', themes.opts);
}
export function resetOptions(t: Theme, k?: keyof Options) {
  const o = { ...themes.opts[t.id] };
  if (k) delete o[k]; else for (const key of Object.keys(o)) delete (o as any)[key];
  themes.opts = { ...themes.opts, [t.id]: o };
  kv.set('themeOpts', themes.opts);
}

export function saveUserTheme(t: Theme) {
  const i = themes.user.findIndex(x => x.id === t.id);
  themes.user = i >= 0 ? themes.user.map(x => (x.id === t.id ? t : x)) : [...themes.user, t];
  kv.set('themes', themes.user);
}
export function deleteUserTheme(id: string) {
  themes.user = themes.user.filter(t => t.id !== id);
  const o = { ...themes.opts };
  delete o[id];
  themes.opts = o;
  kv.set('themes', themes.user);
  kv.set('themeOpts', themes.opts);
}

/* ---------- resolving a theme for the reader ---------- */

/** The family chain the press and the CSS use: the theme's face, then bundled faces for
 *  whatever it lacks. */
export function chainOf(t: TypeSpec): string[] {
  const rest = t.fallback === 'sans' ? ['Inter', 'Literata'] : ['Literata', 'Inter'];
  return [t.family, ...rest.filter(f => f !== t.family)];
}
export const cssFamily = (chain: string[], fallback: 'serif' | 'sans') => chain.map(f => `"${f.replace(/"/g, '')}"`).join(', ') + (fallback === 'sans' ? ', sans-serif' : ', serif');

export interface Resolved {
  theme: Theme;
  options: Options;
  chain: string[];
  css: string;
  scale: number;
  wght: number;
  bold: number;
  axes: [string, number][];
  synthSc: boolean;
  /** Colours for the current appearance; null keeps the app's own paper. */
  palette: Palette | null;
}

export function resolve(t: Theme, dark: boolean): Resolved {
  const o = optionsOf(t);
  const ty = t.type;
  const wght = o.boldText ? ty.boldText : ty.weight;
  const bold = Math.min(1000, ty.bold + (wght - ty.weight));
  const chain = chainOf(ty);
  const info = themes.families[ty.family];
  const smcp = info ? info.smcp : BUNDLED_SMCP.has(ty.family);
  let palette: Palette | null = dark ? t.dark : t.light;
  const d = themes.desktop;
  if (t.desktop && d && d.dark === dark) palette = { paper: d.paper, ink: d.ink, accent: d.accent };
  return {
    theme: t, options: o, chain, css: cssFamily(chain, ty.fallback), scale: ty.scale, wght, bold,
    axes: Object.entries(ty.axes).filter(([k]) => k.length === 4), synthSc: !smcp, palette,
  };
}

/* ---------- fonts ---------- */

const familyLoads = new Map<string, Promise<FamilyLoad | null>>();

/** Makes a family ready in the press and in the webview (system families' files are
 *  handed to the webview as FontFaces, so both read the very same bytes). Unknown
 *  families resolve to null: the chain then falls through to the next face. */
export function loadFamily(core: Core, name: string): Promise<FamilyLoad | null> {
  let p = familyLoads.get(name);
  if (!p) {
    p = (async () => {
      try {
        const info = await core.loadFamily(name);
        if (!info.bundled && core.fontFile) {
          await Promise.all(info.files.map(async (f, i) => {
            const bytes = await core.fontFile!(name, i);
            const face = new FontFace(name, bytes, { style: f.italic ? 'italic' : 'normal', weight: f.wmin === f.wmax ? String(f.wmin) : `${f.wmin} ${f.wmax}` });
            await face.load();
            document.fonts.add(face);
          }));
        }
        themes.families = { ...themes.families, [name]: info };
        return info;
      } catch {
        return null;
      }
    })();
    familyLoads.set(name, p);
  }
  return p;
}

/** Waits until the webview has every face a layout may draw with, so nothing is drawn in
 *  a system font while a face is still on its way (WebKit measured an italic ʽ at 6.67 px
 *  for Inter's 5.16 that way). The theme's face, upright and italic, body and bold; with a
 *  book, its extension faces for its characters beyond the core (`ext`), the fallback
 *  faces only for the characters the theme's face lacks (`needs.fallback`), and the
 *  monospaced face only for preformatted text. A face no book needs is never fetched. */
export async function fontsReady(r: Resolved, size: number, ext = '', needs?: { fallback: string; pre: boolean }) {
  const loads: Promise<unknown>[] = [];
  const each = (f: string, text?: string) => {
    const fam = `"${f.replace(/"/g, '')}"`;
    for (const w of [r.wght, r.bold]) for (const it of ['', 'italic ']) loads.push(text === undefined ? document.fonts.load(`${it}${w} ${size}px ${fam}`) : document.fonts.load(`${it}${w} ${size}px ${fam}`, text));
  };
  each(r.chain[0]);
  if (ext) each(r.chain[0], ext);
  if (needs?.fallback) for (const f of r.chain.slice(1)) each(f, needs.fallback);
  if (needs?.pre) {
    loads.push(document.fonts.load(`400 ${size}px "JetBrains Mono"`));
    if (ext) loads.push(document.fonts.load(`400 ${size}px "JetBrains Mono"`, ext));
  }
  await Promise.all(loads).catch(() => {});
}

export async function systemFamilies(core: Core): Promise<string[]> {
  if (themes.system) return themes.system;
  themes.system = core.systemFamilies ? await core.systemFamilies().catch(() => []) : [];
  return themes.system;
}
export const bundledFamilies = () => Object.keys(BUNDLED);

/* ---------- the desktop's colours ---------- */

export async function readDesktop(core: Core) {
  const raw = core.desktopPalette ? await core.desktopPalette().catch(() => null) : null;
  if (!raw || !raw.background || !raw.foreground) { themes.desktop = null; return; }
  const t = tame(raw.background, raw.foreground, raw.accent || raw.foreground);
  if (!t) { themes.desktop = null; return; }
  themes.desktop = { name: raw.name || 'Desktop', paper: t.paper, ink: t.ink, accent: t.accent, dark: raw.mode ? raw.mode === 'dark' : t.dark };
}

/* ---------- import, export, and the brief for an AI ---------- */

export const FORMAT = 'volumen-theme/1';

export function exportTheme(t: Theme): string {
  const p = (x: Palette | null, mode: 'light' | 'dark') => x ?? STOCK[mode];
  return JSON.stringify({
    format: FORMAT,
    name: t.name,
    font: { family: t.type.family, fallback: t.type.fallback, sizeAdjust: t.type.scale, weight: t.type.weight, boldWeight: t.type.bold, boldTextWeight: t.type.boldText, axes: t.type.axes },
    layout: { lineSpacing: t.options.lineSpacing, characterSpacing: t.options.charSpacing, wordSpacing: t.options.wordSpacing, margins: t.options.margins, justify: t.options.justify, hyphenate: t.options.hyphenate, boldText: t.options.boldText },
    light: p(t.light, 'light'),
    dark: p(t.dark, 'dark'),
  }, null, 2);
}

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const SANS = /sans|grotesk|grotesque|gothic|inter|helvetica|arial|figtree|manrope|mulish|nunito|jakarta|montserrat|lato|roboto|ubuntu|cantarell|noto sans|dejavu sans|liberation sans/i;

/** Reads a theme file (or pasted text, a code fence around it is fine). Out-of-range
 *  numbers are clamped and colours too faint to read are darkened; each repair is noted. */
export function parseTheme(text: string): { theme: Theme; notes: string[] } | { error: string } {
  let j: any;
  const body = text.trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '');
  try { j = JSON.parse(body); } catch { return { error: 'This is not a theme: it is not valid JSON.' }; }
  if (!j || typeof j !== 'object') return { error: 'This is not a theme.' };
  if (j.format && j.format !== FORMAT) return { error: `This theme is in a format this version does not read (${String(j.format)}).` };
  const notes: string[] = [];
  const f = j.font ?? {}, l = j.layout ?? {};
  const family = typeof f.family === 'string' && f.family.trim() ? f.family.trim().slice(0, 80) : 'Literata';
  const fallback: 'serif' | 'sans' = f.fallback === 'sans' || f.fallback === 'serif' ? f.fallback : SANS.test(family) ? 'sans' : 'serif';
  const weight = clamp(f.weight, 200, 800, 400);
  const axes: Record<string, number> = {};
  if (f.axes && typeof f.axes === 'object') for (const [k, v] of Object.entries(f.axes)) if (/^[A-Za-z0-9 ]{4}$/.test(k) && k !== 'wght' && k !== 'opsz' && typeof v === 'number') axes[k] = v;
  const type: TypeSpec = {
    family, fallback, scale: clamp(f.sizeAdjust, 0.8, 1.3, 1), weight,
    bold: clamp(f.boldWeight, weight + 100, 1000, Math.min(900, weight + 250)),
    boldText: clamp(f.boldTextWeight, weight, 900, Math.min(900, weight + 100)), axes,
  };
  const options: Options = {
    boldText: l.boldText === true, lineSpacing: clamp(l.lineSpacing, 1.15, 2.2, 1.5), charSpacing: Math.round(clamp(l.characterSpacing, -5, 15, 0)),
    wordSpacing: Math.round(clamp(l.wordSpacing, -10, 50, 0)), margins: Math.round(clamp(l.margins, -2, 3, 0)), justify: l.justify !== false, hyphenate: l.hyphenate !== false,
  };
  const pal = (x: any, mode: 'light' | 'dark'): Palette => {
    const s = STOCK[mode];
    const hex = (v: unknown, d: string) => (typeof v === 'string' && hexToRgb(v) ? v.toLowerCase() : d);
    const paper = hex(x?.paper, s.paper);
    let ink = hex(x?.ink, s.ink), accent = hex(x?.accent, s.accent);
    if (contrast(paper, ink) < 7) { ink = fitContrast(paper, ink, 7, 21); notes.push(`The ${mode} ink was too faint on its paper; it is now ${mode === 'dark' ? 'lighter' : 'darker'}.`); }
    if (contrast(paper, accent) < 3) { accent = fitContrast(paper, accent, 3.2, 21); notes.push(`The ${mode} accent was hard to see; it is now stronger.`); }
    return { paper, ink, accent };
  };
  const name = typeof j.name === 'string' && j.name.trim() ? j.name.trim().slice(0, 40) : 'Untitled';
  const theme: Theme = { id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, type, options, light: pal(j.light, 'light'), dark: pal(j.dark, 'dark') };
  return { theme, notes };
}

/** A brief another AI can follow to design a theme this app imports as it is. */
export function aiBrief(installed: string[] = []): string {
  const fonts = bundledFamilies().join(', ');
  return `Design a reading theme for an e-book reader. Reply with one JSON object and nothing else, in exactly this format:

{
  "format": "${FORMAT}",
  "name": "Short name, at most 24 characters",
  "font": {
    "family": "a font family name (see below)",
    "fallback": "serif" or "sans" (which kind the family is),
    "sizeAdjust": number 0.8–1.3; 1 for a face with a typical x-height, higher for small-eyed faces,
    "weight": body weight 300–500,
    "boldWeight": weight of bold and headings, 550–800,
    "boldTextWeight": body weight when the reader turns on Bold Text, 450–600,
    "axes": {} or variable-font axes other than wght and opsz, e.g. { "SOFT": 50 }
  },
  "layout": {
    "lineSpacing": 1.3–1.8 (1.4–1.6 suits most book faces),
    "characterSpacing": integer percent of the size, -2 to 6 (usually 0),
    "wordSpacing": integer percent of the size, -4 to 20 (usually 0),
    "margins": integer -2 to 3 (0 is the designed measure of about 30 em; higher is narrower),
    "justify": true or false (sans faces usually read better ragged),
    "hyphenate": true (false only for a deliberately unbroken look),
    "boldText": false (true only for a deliberately heavy theme)
  },
  "light": { "paper": "#rrggbb", "ink": "#rrggbb", "accent": "#rrggbb" },
  "dark":  { "paper": "#rrggbb", "ink": "#rrggbb", "accent": "#rrggbb" }
}

Rules:
- The family must be one the reader has. Shipped with the app: ${fonts}.${installed.length ? `\n- Also installed on this computer: ${installed.slice(0, 400).join(', ')}.` : ''}
- Ink on paper needs a contrast ratio of at least 7:1 and should stay under about 15:1; pure black on pure white is harsh for long reading.
- Paper should be quiet: low saturation. The accent marks headings, highlights and controls and needs at least 3:1 on the paper.
- The dark palette is the same theme by night, not an inversion: a dim, slightly warm or cool paper with soft, light ink.
- Give the theme a mood and let every number serve it.`;
}
