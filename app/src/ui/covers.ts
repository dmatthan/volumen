/** The library's covers: an image fitted to the frame, a made cover's title fitted to it. */

/** A cover image keeps its whole picture: one near the frame's shape (2:3) fills it,
 *  one far from it (a square, a wide one) is shown whole on its own edge colour,
 *  taken once from the image (nothing is computed as the shelf scrolls). */
export function fitImage(img: HTMLImageElement) {
  const done = () => {
    const a = img.naturalWidth / Math.max(1, img.naturalHeight);
    if (!a || Math.abs(a / (2 / 3) - 1) < 0.14) return;
    const c = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!c) return;
    c.canvas.width = 8; c.canvas.height = 8;
    c.drawImage(img, 0, 0, 8, 8);
    const d = c.getImageData(0, 0, 8, 8).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      if (x > 0 && x < 7 && y > 0 && y < 7) continue;
      const o = (y * 8 + x) * 4; r += d[o]; g += d[o + 1]; b += d[o + 2]; n++;
    }
    const box = img.parentElement!;
    box.style.background = `rgb(${r / n | 0} ${g / n | 0} ${b / n | 0})`;
    box.classList.add('whole');
  };
  // it fades in as it arrives (one already decoded is simply there)
  if (img.complete && img.naturalWidth) { img.classList.add('in', 'now'); done(); }
  else img.addEventListener('load', () => { img.classList.add('in'); done(); }, { once: true });
}
/** A generated cover's title is set as large as fits: its longest word within the
 *  width, and the whole cover within its height (a title like "Superintelligence"
 *  otherwise runs off the edge). Fitted again when the cover changes size. */
export function fitTitle(cover: HTMLElement) {
  const title = cover.querySelector<HTMLElement>('.c-title')!;
  // (the cover's scroll size would count its shadow, which lies outside it: measure what
  // the content takes instead)
  const tall = () => {
    const cs = getComputedStyle(cover), r = cover.getBoundingClientRect();
    const last = cover.lastElementChild!.getBoundingClientRect(), first = cover.firstElementChild!.getBoundingClientRect();
    return last.bottom - first.top > r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) + 0.5;
  };
  const fit = () => {
    title.style.fontSize = ''; title.style.webkitLineClamp = '';
    let px = parseFloat(getComputedStyle(title).fontSize);
    while (px > 11 && (title.scrollWidth > title.clientWidth + 0.5 || tall())) {
      px -= 0.5;
      title.style.fontSize = px + 'px';
    }
    // a title too long even then: as many lines as there is room for, ending in "…"
    if (tall()) {
      const lh = parseFloat(getComputedStyle(title).lineHeight) || px * 1.12;
      let n = Math.max(1, Math.round(title.getBoundingClientRect().height / lh));
      while (n > 1 && tall()) title.style.webkitLineClamp = String(--n);
    }
  };
  const ro = new ResizeObserver(fit);
  ro.observe(cover);
  document.fonts.ready.then(fit);
  return { destroy: () => ro.disconnect() };
}
