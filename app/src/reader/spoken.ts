// The page in view, for a screen reader: the columns' lines are boxes placed one by one
// (a hyphenated word in two, the faded neighbours' lines among them), so the track is
// hidden from assistive technology and this says the same text as a document: whole
// paragraphs and headings, a picture by its description, in reading order. It is made
// again whenever the page comes to rest (reader.svelte.ts `arrive`). Text columns are
// always hidden from it; a leaf (the title page, the end: controls among them) only
// while it is out of focus.
import { BlockKind, type BookData } from '../core/types';
import { FIELDS, F, Flag, type Strip } from './strip';
import { esc, chapName } from './render';

const said = (t: string) => esc(t.replace(/\t/g, ', ').replace(/\u2028/g, ' '));

export function spokenPage(strip: Strip, cols: number[]): string {
  const book: BookData = strip.book;
  let html = '';
  // the paragraph being said: a block running on from one column to the next is one
  let open: { sec: number; bi: number; s: number; e: number } | null = null;
  const close = () => {
    if (!open) return;
    const b = book.sections[open.sec].blocks[open.bi];
    // a note's mark is said as one ("father (note 15)", not "father15")
    let t = '', at = open.s;
    for (const [ls, le, to] of [...(b.l ?? [])].sort((x, y) => x[0] - y[0])) {
      if (!to.startsWith('n:') || ls < at || le > open.e) continue;
      t += said(b.t.slice(at, ls)) + ` (note ${said(b.t.slice(ls, le))})`;
      at = le;
    }
    t += said(b.t.slice(at, open.e));
    if (b.k === BlockKind.H) html += `<h3>${t}</h3>`;
    else if (b.k === BlockKind.Pre) html += `<pre>${t}</pre>`;
    else if (b.k === BlockKind.Li) html += `<p>• ${t}</p>`;
    else html += `<p>${t}</p>`;
    open = null;
  };
  for (const k of cols) {
    const it = strip.itemAt(k);
    if (!it) continue;
    // (the title page and the end are leaves, with controls: read as themselves)
    if (it.type !== 'sect') { close(); continue; }
    const sec = book.sections[it.sec];
    if (k === it.start && sec.k === 1) {
      close();
      const head = sec.label && sec.title ? `${sec.label} · ${sec.title}` : sec.title || chapName(book, it.sec);
      html += `<h2>${esc(sec.part ? `${sec.part}: ${head}` : head)}</h2>`;
    }
    const L = strip.linesAt(k);
    if (!L) continue;
    const { u } = L.sl;
    for (let j = L.from; j < L.to; j++) {
      const o = j * FIELDS, flags = u[o + F.flags] & 0xffff;
      if (flags & (Flag.ImageRow | Flag.Rule)) continue;
      const bi = u[o + F.block], b = sec.blocks[bi];
      if (flags & Flag.Break) { if (flags & Flag.First) { close(); html += '<hr>'; } continue; }
      if (flags & Flag.Image) { close(); html += `<p role="img" aria-label="${esc(b.t ? `Picture: ${b.t}` : 'A picture')}"></p>`; continue; }
      const s = u[o + F.s], e = u[o + F.e];
      if (open && open.sec === L.sec && open.bi === bi) { open.s = Math.min(open.s, s); open.e = Math.max(open.e, e); continue; }
      close();
      open = { sec: L.sec, bi, s, e };
    }
  }
  close();
  return html;
}
