/** A touch screen: key hints mean nothing there. The page marks itself `touchui` (main.ts)
 *  when the window is phone-sized, the pointer coarse, or the screen has been touched;
 *  tokens.css hides `kbd` and `.keys-only` then, and text that names a key asks this. */
export function touchUI(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('touchui');
}
/** "  ( / )" after a placeholder, where there is a keyboard to press it on. */
export const keyHint = (k: string) => (touchUI() ? '' : `  ( ${k} )`);

/** Marks the page as touch-driven (main.ts calls this first thing). */
export function watchTouch() {
  const html = document.documentElement;
  const mark = () => html.classList.add('touchui');
  if (matchMedia('(pointer: coarse)').matches || matchMedia('(max-width: 640px)').matches || (navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches)) mark();
  addEventListener('touchstart', mark, { once: true, passive: true });
}

/** Safari zooms the page on a pinch whatever `touch-action` says on some elements (its own
 *  gesture events come first): the page never zooms (tokens.css). */
export function noPageZoom() {
  for (const t of ['gesturestart', 'gesturechange'] as const) document.addEventListener(t, e => e.preventDefault(), { passive: false });
}

/** What a phone's keyboard covers: iOS leaves a fixed page its full height and lays the
 *  keyboard over its foot (and may scroll the view to the field being typed in). The
 *  part still visible is given as `--vv-top` and `--kb` (from the top and the bottom), so
 *  sheets sit above the keyboard rather than under it. */
export function followKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const html = document.documentElement;
  const set = () => {
    const top = Math.max(0, vv.offsetTop), kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
    html.style.setProperty('--vv-top', `${top}px`);
    html.style.setProperty('--kb', `${kb}px`);
  };
  vv.addEventListener('resize', set);
  vv.addEventListener('scroll', set);
  set();
}
