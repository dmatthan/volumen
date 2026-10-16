/** Puts text on the clipboard. The async clipboard exists only on secure pages (https,
 *  the desktop app); elsewhere (the app over plain http on a phone, while testing) the
 *  older way still works: select the text in a hidden field and copy it, within the tap. */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* the older way */ }
  }
  return copySelected(text);
}

function copySelected(text: string): boolean {
  const prev = document.activeElement as HTMLElement | null;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.readOnly = true;
  // (16 px: iOS zooms into a smaller field it focuses)
  ta.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;font-size:16px;border:0;padding:0;';
  document.body.append(ta);
  ta.focus({ preventScroll: true });
  // iOS selects a field's text only through a range
  const range = document.createRange();
  range.selectNodeContents(ta);
  const sel = getSelection();
  sel?.removeAllRanges(); sel?.addRange(range);
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* not allowed */ }
  sel?.removeAllRanges();
  ta.remove();
  prev?.focus?.({ preventScroll: true });
  return ok;
}
