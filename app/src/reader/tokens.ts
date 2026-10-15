/** Colour tokens for canvas drawing, read once per theme change. */
export interface Tokens {
  ink: string; ink2: string; ink3: string; accent: string; rule: string; ground: string; read: string;
  pl: string; pc: string; ui: string;
  /** Highlight colours, solid (`--hs1..4`), and readers' colours (`--r1..6`). */
  hs: string[]; rd: string[];
}
export let T = {} as Tokens;
export function readTokens(): Tokens {
  const cs = getComputedStyle(document.documentElement);
  const g = (n: string) => cs.getPropertyValue(n).trim();
  T = {
    ink: g('--ink'), ink2: g('--ink-2'), ink3: g('--ink-3'), accent: g('--accent'), rule: g('--rule'), ground: g('--ground'), read: g('--read'),
    pl: g('--pl'), pc: g('--pc'), ui: '"Inter", system-ui, sans-serif',
    hs: [1, 2, 3, 4].map(i => g(`--hs${i}`)), rd: [1, 2, 3, 4, 5, 6].map(i => g(`--r${i}`)),
  };
  return T;
}
/** Paper hue along the book. */
export const hueAt = (frac: number) => 96 + 150 * frac;
