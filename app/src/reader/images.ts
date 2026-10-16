/** The open book's pictures as the page shows them: an image's URL (the desktop knows it
 *  at once; the web build reads IndexedDB, and the picture is set on the page when it
 *  arrives), and a rich block's picture, made from its XHTML (rich.ts). */
import type { BookData, Core } from '../core/types';
import { RICH, measureRich, richURL } from './rich';

export class BookImages {
  /** Rich blocks' XHTML, by image index. */
  private rich = new Map<number, string>();
  private urls = new Map<number, string>();
  /** The pictures made for rich blocks, given back with their book. */
  private blobs = new Set<string>();

  constructor(private core: Core, private book: () => BookData | null) {}

  /** Another book: what was made for the last one is given back. */
  reset() {
    this.rich.clear();
    this.urls.clear();
    for (const u of this.blobs) URL.revokeObjectURL(u);
    this.blobs.clear();
  }

  private async richOf(book: BookData, i: number): Promise<string> {
    let t = this.rich.get(i);
    if (t === undefined) {
      t = new TextDecoder().decode(await this.core.imageBytes(book.id, i));
      this.rich.set(i, t);
    }
    return t;
  }

  /** Rich blocks are laid out as images of the size the browser draws them at: measured
   *  the first time the book opens, and kept with it. */
  async measure(book: BookData) {
    const todo = book.images.map((im, i) => [im, i] as const).filter(([im]) => im[3] === RICH && (!im[0] || !im[1]));
    if (!todo.length) return;
    const sizes: [number, number, number][] = [];
    for (const [im, i] of todo) {
      const { w, h } = measureRich(await this.richOf(book, i));
      im[0] = w; im[1] = h;
      sizes.push([i, w, h]);
    }
    await this.core.setImageSizes(book.id, sizes);
  }

  /** Image `i`'s URL if known; otherwise it is asked for, and set on the page's images
   *  when it arrives. */
  src = (i: number): string => {
    const book = this.book();
    if (i < 0 || !book) return '';
    const hit = this.urls.get(i);
    if (hit !== undefined) return hit;
    const im = book.images[i];
    const u: string | Promise<string> = im?.[3] === RICH
      ? this.richOf(book, i).then(t => { const url = richURL(t, im[0] || 600, im[1] || 400); this.blobs.add(url); return url; })
      : this.core.imageURL(book.id, i);
    if (typeof u === 'string') { this.urls.set(i, u); return u; }
    this.urls.set(i, '');
    u.then(url => {
      if (this.book()?.id !== book.id) return;
      this.urls.set(i, url);
      for (const img of document.querySelectorAll<HTMLImageElement>(`.col img[data-i="${i}"]`)) img.src = url;
    });
    return '';
  };
}
