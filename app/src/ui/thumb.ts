/** A cover as the shelf can show it: at most 480 × 720 (a column of covers at 2×). An
 *  image is decoded whole whatever size it is shown at (a 1600 × 2400 cover holds 15 MB),
 *  so a larger one is drawn down once and the small one kept in its place. Nothing when
 *  the image is small already, or cannot be read. */
export async function coverThumb(buf: ArrayBuffer): Promise<Blob | null> {
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(new Blob([buf])); } catch { return null; }
  const s = Math.min(1, 480 / bmp.width, 720 / bmp.height);
  if (s > 0.98 && buf.byteLength < 300_000) { bmp.close(); return null; }
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (!g) { bmp.close(); return null; }
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  // (a PNG may be transparent: it stays a PNG)
  const png = new Uint8Array(buf, 0, Math.min(8, buf.byteLength)).every((v, i) => v === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][i]);
  const out = await new Promise<Blob | null>(r => c.toBlob(r, png ? 'image/png' : 'image/jpeg', 0.86));
  c.width = 0; c.height = 0;
  return out && out.size < buf.byteLength ? out : null;
}
