import { kv } from '../core/kv';

export type Appearance = 'auto' | 'light' | 'dark';
/** Columns in focus: a number, or 'auto' for as many as fit. */
export type Layout = 'auto' | 1 | 2 | 3;
/** Flow: the focus columns with the neighbours fading in at the sides. Minimal: only the
 *  chosen columns, as a spread filling the window. */
export type View = 'flow' | 'minimal';
export interface Settings {
  /** Body size in px before the theme's size adjustment; null picks one for the screen. */
  size: number | null;
  layout: Layout;
  view: View;
  /** The theme's id (themes.svelte.ts); its own options live with it. */
  theme: string;
  appearance: Appearance;
  veil: boolean;
  motion: 'system' | 'reduce';
}
/** The sizes the size control steps through. */
export const SIZES = [15, 16, 17, 18, 19, 20, 21, 22, 24, 26, 28];
export const DEFAULTS: Settings = { size: null, layout: 'auto', view: 'flow', theme: 'original', appearance: 'auto', veil: true, motion: 'system' };

/** Settings are stored as the changes from DEFAULTS, so "reset" is deleting them. */
const stored = kv.get<Record<string, unknown>>('settings', {});
// before themes, `theme` held the appearance and `justify` was global
if (stored.theme === 'auto' || stored.theme === 'light' || stored.theme === 'dark') { stored.appearance = stored.theme; delete stored.theme; }
if (stored.justify === false) {
  const o = kv.get<Record<string, Record<string, unknown>>>('themeOpts', {});
  kv.set('themeOpts', { ...o, original: { ...o.original, justify: false } });
}
delete stored.justify;
// hyphenation moved into the themes too
if (stored.hyphenate === false) {
  const o = kv.get<Record<string, Record<string, unknown>>>('themeOpts', {});
  for (const id of ['original', 'quiet', 'paper', 'bold', 'calm', 'focus']) o[id] = { ...o[id], hyphenate: false };
  kv.set('themeOpts', o);
}
delete stored.hyphenate;
// settings that are no more (a line at each chapter's end)
delete stored.recall;
export const settings: Settings = $state({ ...DEFAULTS, ...(stored as Partial<Settings>) });

export function save() {
  const diff: Partial<Settings> = {};
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) if (settings[k] !== DEFAULTS[k]) (diff as any)[k] = settings[k];
  kv.set('settings', diff);
}
export function changed(k: keyof Settings) { return settings[k] !== DEFAULTS[k]; }
export function reset(k?: keyof Settings) {
  if (k) (settings as any)[k] = DEFAULTS[k];
  else Object.assign(settings, DEFAULTS);
  save();
}
export const reduceMotion = () => settings.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;
