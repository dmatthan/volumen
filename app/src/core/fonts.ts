/** The families the app ships (assets/fonts, served at /fonts). The desktop shell embeds
 *  the same files (src-tauri/src/main.rs), and fonts.css declares them for the webview;
 *  keep them in step. Each file is a core (Latin, punctuation) with an extension beside it,
 *  `<file>.ext.ttf`, the rest of the font: the engine knows it as the family `<name>~ext`
 *  (scripts/subset-fonts.py writes both, and fonts.css). */
export interface BundledFile { file: string; italic: boolean; weight: [number, number] }

const vf = (name: string): BundledFile[] => [
  { file: `${name}.ttf`, italic: false, weight: [100, 1000] },
  { file: `${name}-Italic.ttf`, italic: true, weight: [100, 1000] },
];
const charis: BundledFile[] = (['Regular', 'Medium', 'SemiBold', 'Bold'] as const).flatMap((n, i) => [
  { file: `Charis-${n}.ttf`, italic: false, weight: [400 + 100 * i, 400 + 100 * i] as [number, number] },
  { file: `Charis-${n === 'Regular' ? 'Italic' : n + 'Italic'}.ttf`, italic: true, weight: [400 + 100 * i, 400 + 100 * i] as [number, number] },
]);

/** A family's files; `Name~ext` is the extension files of `Name`. */
export function bundledFiles(name: string): BundledFile[] | undefined {
  if (name.endsWith('~ext')) return BUNDLED[name.slice(0, -4)]?.map(f => ({ ...f, file: f.file.replace(/\.ttf$/, '.ext.ttf') }));
  return BUNDLED[name];
}

export const BUNDLED: Record<string, BundledFile[]> = {
  Literata: vf('Literata'),
  Inter: vf('Inter'),
  Newsreader: vf('Newsreader'),
  Charis: charis,
  Fraunces: vf('Fraunces'),
  'Nunito Sans': vf('NunitoSans'),
  /** Preformatted text (Kind::Pre): never a theme's face, never italic. */
  'JetBrains Mono': [{ file: 'JetBrainsMono.ttf', italic: false, weight: [100, 1000] }],
};

/** Bundled families with real small capitals (the rest get them synthesised). */
export const BUNDLED_SMCP = new Set(['Literata', 'Charis']);
