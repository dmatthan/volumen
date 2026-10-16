<script lang="ts">
  import { onMount } from 'svelte';
  import { type Reader } from '../reader/reader.svelte';
  import { ui } from '../state.svelte';
  import { reduceMotion } from '../reader/settings.svelte';
  import { RICH } from '../reader/rich';

  /** An image shown large. It grows from where it sits on the page to the middle of the
   *  window over a darkened, vignetted page, and goes back the same way. Only transform and
   *  opacity animate (the compositor's work); nothing is blurred live. */
  let { reader }: { reader: Reader } = $props();
  const lb = $derived(ui.lightbox!);
  // svelte-ignore state_referenced_locally
  const [iw, ih, alt, mime] = reader.book!.images[ui.lightbox!.i] ?? [1, 1, '', ''];
  // a rich block (reader/rich.ts) is ink on transparent, shown on a card of paper; its
  // description is all its text, not a caption
  const rich = mime === RICH;
  // svelte-ignore state_referenced_locally
  const src = reader.images.src(ui.lightbox!.i);
  let shown = $state(false);
  let leaving = $state(false);

  const vw = window.innerWidth, vh = window.innerHeight;
  const capH = alt ? 56 : 0;
  // fit the window, and never more than twice the image's own size
  const k = Math.min((vw * 0.92) / iw, (vh * 0.88 - capH) / ih, 2);
  const tw = iw * k, th = ih * k, tx = (vw - tw) / 2, ty = (vh - capH - th) / 2;
  const from = $derived(`translate(${lb.rect.x - tx}px, ${lb.rect.y - ty}px) scale(${lb.rect.w / tw}, ${lb.rect.h / th})`);

  function close() {
    if (leaving) return;
    leaving = true; shown = false;
    setTimeout(() => (ui.lightbox = null), reduceMotion() ? 0 : 280);
  }
  // the image on the page steps aside while its large self is out, so it seems to lift
  // out of the page and settle back into it
  // svelte-ignore state_referenced_locally
  const onPage = [...document.querySelectorAll<HTMLElement>(`.col figure.img[data-i="${ui.lightbox!.i}"]`)];
  onMount(() => {
    for (const f of onPage) f.style.visibility = 'hidden';
    requestAnimationFrame(() => requestAnimationFrame(() => (shown = true)));
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); for (const f of onPage) f.style.visibility = ''; };
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="lb" class:shown class:rich class:reduced={reduceMotion()} role="dialog" aria-label={rich ? 'Figure' : alt || 'Image'} tabindex="-1" onclick={close}>
  <div class="scrim"></div>
  {#if rich}<div class="card" style="left:{tx - 20}px;top:{ty - 20}px;width:{tw + 40}px;height:{th + 40}px"></div>{/if}
  <img {src} alt={alt} style="left:{tx}px;top:{ty}px;width:{tw}px;height:{th}px;transform:{shown ? 'none' : from}" />
  {#if alt && !rich}<p class="cap" style="top:{ty + th + 16}px">{alt}</p>{/if}
</div>

<style>
  .lb { position: fixed; inset: 0; z-index: 80; cursor: zoom-out; }
  .scrim {
    position: absolute; inset: 0; opacity: 0; transition: opacity .28s ease;
    background: radial-gradient(ellipse at 50% 46%, oklch(0.13 0.008 260 / 0.84) 0%, oklch(0.09 0.008 260 / 0.92) 60%, oklch(0.05 0.008 260 / 0.97) 100%);
  }
  img {
    position: absolute; transform-origin: 0 0; border-radius: 3px; will-change: transform;
    transition: transform .3s cubic-bezier(.2, .8, .2, 1); box-shadow: 0 0 0 1px oklch(1 0 0 / 0.06);
    object-fit: contain; image-rendering: auto;
    /* line art often comes on a transparent ground: give it its paper */
    background: var(--paper);
  }
  .cap {
    position: absolute; left: 50%; transform: translateX(-50%); width: min(720px, 86vw); margin: 0; text-align: center;
    font: 500 14px/1.45 var(--f-ui); color: oklch(0.92 0.005 260 / 0.82); opacity: 0; transition: opacity .2s ease .12s;
  }
  .shown .scrim { opacity: 1; }
  .shown .cap { opacity: 1; }
  .reduced img, .reduced .scrim, .reduced .cap { transition: none; }
  /* a rich block is ink on transparent: shown on a card of the page's paper, its ink
     turned light only where the paper is dark (as on the page: reader.css) */
  .card { position: absolute; border-radius: 14px; background: var(--paper); opacity: 0; transition: opacity .3s ease; }
  .shown .card { opacity: 1; }
  .lb.rich img { background: none; box-shadow: none; }
  :global(.dark-paper) .lb.rich img { filter: invert(1) hue-rotate(180deg); }
</style>
