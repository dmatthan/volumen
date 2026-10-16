/** Marking from the keyboard (V): a cursor over the paragraphs in focus, moved with J and
 *  K; X or Enter highlights the chosen one, N adds a note to it, O opens its picture or
 *  its first note (input.ts has the keys). */
import { ui, toast } from '../state.svelte';
import { F, FIELDS, Flag } from './strip';
import type { Reader } from './reader.svelte';

export class Cursor {
  /** The chosen paragraph's place among those in focus; null while there is no cursor. */
  private at: number | null = null;

  constructor(private r: Reader) {}

  get active() { return this.at !== null; }

  /** Paragraphs with lines in the focus window, in reading order. */
  private blocks(): { k: number; b: number }[] {
    const r = this.r, out: { k: number; b: number }[] = [];
    for (const k of r.focusCols()) {
      const L = r.strip?.linesAt(k);
      if (!L) continue;
      for (let j = L.from; j < L.to; j++) {
        const b = L.sl.u[j * FIELDS + F.block];
        const last = out[out.length - 1];
        if (L.sl.u[j * FIELDS + F.flags] & Flag.Break) continue;
        if (!last || last.b !== b || r.strip!.itemAt(last.k)!.sec !== L.sec) out.push({ k, b });
      }
    }
    return out;
  }

  /** The chosen paragraph: its section and block. */
  private chosen(): { sec: number; b: number } | null {
    const blocks = this.blocks();
    if (this.at === null || !blocks.length) return null;
    const { k, b } = blocks[this.at];
    return { sec: this.r.strip!.itemAt(k)!.sec, b };
  }

  start() {
    if (!this.blocks().length) { toast('Nothing to mark here.'); return; }
    this.at = 0;
    this.move(0);
  }

  end() {
    this.at = null;
    for (const [, el] of this.r.surface.rendered()) for (const ln of el.querySelectorAll('.pick')) ln.classList.remove('pick');
  }

  /** `d` paragraphs on (or back); 0 shows it again where it is, after the page moved. */
  move(d: number) {
    const r = this.r, blocks = this.blocks();
    if (this.at === null || !blocks.length) { this.end(); return; }
    this.at = Math.max(0, Math.min(blocks.length - 1, this.at + d));
    const { k, b } = blocks[this.at];
    const sec = r.strip!.itemAt(k)!.sec, focus = r.focusCols();
    for (const [c, el] of r.surface.rendered()) {
      for (const ln of el.querySelectorAll('.pick')) ln.classList.remove('pick');
      if (r.strip!.itemAt(c)?.sec === sec && focus.includes(c)) for (const ln of el.querySelectorAll(`.ln[data-b="${b}"], .img[data-b="${b}"]`)) ln.classList.add('pick');
    }
  }

  /** Opens what the chosen paragraph holds: its picture, or its first note. */
  open() {
    if (!this.active) return;
    const picked = [...document.querySelectorAll<HTMLElement>('.col .pick')];
    const fig = picked.find(el => el.classList.contains('img'));
    if (fig) { this.r.openImage(+fig.dataset.i!, fig); return; }
    const nr = picked.map(el => el.querySelector<HTMLElement>('a.nr')).find(Boolean);
    if (nr) this.r.openNote(+nr.dataset.n!, nr);
    else toast('No note or image here.');
  }

  /** Highlights the chosen paragraph (and opens its note with `note`). */
  highlight(note: boolean) {
    const r = this.r, c = this.chosen();
    if (!c) return;
    const blk = r.book!.sections[c.sec].blocks[c.b], len = blk.t.length;
    const existing = r.ann!.of(blk.key)?.find(a => a.s === 0 && a.e >= len - 1);
    const id = existing?.id ?? r.highlight({ a: [c.sec, c.b, 0], z: [c.sec, c.b, len] });
    if (id && note) { ui.noteFor = id; ui.sheet = 'note'; }
    this.move(0);
  }
}
