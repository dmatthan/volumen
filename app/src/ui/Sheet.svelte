<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';

  let { label, onclose, onkey, children, wide = false }: {
    label: string; onclose: () => void; onkey?: (e: KeyboardEvent) => boolean; children: Snippet; wide?: boolean;
  } = $props();
  let sheet: HTMLElement;
  let shown = $state(false);
  const prev = document.activeElement as HTMLElement | null;

  onMount(() => {
    requestAnimationFrame(() => (shown = true));
    const first = sheet.querySelector<HTMLElement>('[data-autofocus]') || sheet.querySelector<HTMLElement>('button, input, [tabindex="0"]');
    first?.focus({ preventScroll: true });
    // focus that fell out of the sheet (the control it was on went away) still closes it
    const lost = (e: KeyboardEvent) => {
      const a = document.activeElement;
      if (e.key === 'Escape' && (!a || a === document.body)) { e.preventDefault(); onclose(); }
    };
    addEventListener('keydown', lost);
    return () => { removeEventListener('keydown', lost); prev?.focus?.({ preventScroll: true }); };
  });

  function keydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onclose(); return; }
    if (e.key === 'Tab') {
      const f = [...sheet.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([type=radio]), input[type=radio]:checked, [tabindex="0"]')];
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && onkey?.(e)) e.preventDefault();
  }
</script>

<div class="wrap" class:in={shown}>
  <div class="back" onclick={onclose} aria-hidden="true"></div>
  <div class="sheet lift" class:wide bind:this={sheet} role="dialog" aria-modal="true" aria-label={label} tabindex="-1" onkeydown={keydown}>
    <div class="scroll">{@render children()}</div>
  </div>
</div>

<style>
  /* (one row the height of the window: a sheet's max-height is a share of it; in a row
     sized by its content the share meant nothing, and a long sheet ran off the screen) */
  .wrap { position: absolute; inset: var(--vv-top, 0px) 0 var(--kb, 0px) 0; z-index: 50; display: grid; grid-template-rows: minmax(0, 1fr); align-items: end; justify-items: center; }
  .back { position: absolute; inset: 0; background: var(--scrim); opacity: 0; transition: opacity .22s; }
  .sheet {
    position: relative; box-sizing: border-box; width: min(100%, 500px); max-height: calc(100% - max(24px, env(safe-area-inset-top) + 12px)); display: flex; flex-direction: column;
    background: var(--sheet); color: var(--ink); border-radius: var(--r-l) var(--r-l) 0 0;
    transform: translateY(20px); opacity: 0; transition: transform .3s cubic-bezier(.2,.8,.2,1), opacity .22s;
    outline: none;
  }
  .scroll { min-height: 0; border-radius: inherit; overflow-y: auto; overflow-x: hidden; touch-action: pan-y; overscroll-behavior: contain; padding: 24px 22px calc(22px + env(safe-area-inset-bottom)); display: grid; gap: 20px; }
  .sheet.wide { width: min(100%, 720px); }
  .in .sheet { transform: none; opacity: 1; }
  .in .back { opacity: 1; }
  @media (max-width: 640px) {
    .scroll { padding: 20px 18px calc(18px + env(safe-area-inset-bottom)); gap: 16px; }
  }
  @media (min-width: 640px) {
    .wrap { align-items: center; }
    .sheet { border-radius: var(--r-l); }
    .scroll { padding: 28px 28px 24px; }
  }
  .sheet :global(.eyebrow) { margin: 0; font: 600 var(--t-s)/1.2 var(--f-ui); color: var(--ink-3); }
  .sheet :global(h2) { margin: 6px 0 0; font: 650 var(--t-xl)/1.2 var(--f-ui); letter-spacing: -0.01em; color: var(--ink); text-wrap: balance; }
  .sheet :global(.where) { margin: 6px 0 0; font: 500 var(--t-m)/1.45 var(--f-ui); color: var(--ink-2); }
  .sheet :global(.group) { display: grid; gap: 6px; border: 0; margin: 0; padding: 0; min-width: 0; }
  .sheet :global(.legend) { padding: 0; margin: 0 0 4px; font: 650 var(--t-s)/1.2 var(--f-ui); color: var(--ink-2); display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .sheet :global(.opt) { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 11px 12px; border-radius: var(--r-m); cursor: pointer; }
  :global(html:not(.touchui)) .sheet :global(.opt:hover) { background: var(--hover); }
  .sheet :global(.opt input) { appearance: none; margin: 0; width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--ink-3); display: grid; place-content: center; }
  .sheet :global(.opt input::before) { content: ""; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); transform: scale(0); transition: transform .15s; }
  .sheet :global(.opt input:checked) { border-color: var(--accent); }
  .sheet :global(.opt input:checked::before) { transform: scale(1); }
  .sheet :global(.o-t) { font: 600 var(--t-m)/1.3 var(--f-ui); }
  .sheet :global(.o-m) { font: 500 var(--t-s)/1.3 var(--f-ui); color: var(--ink-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sheet :global(.tog) { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 16px; padding: 8px 2px; cursor: pointer; }
  .sheet :global(.t-t) { font: 600 var(--t-m)/1.3 var(--f-ui); }
  .sheet :global(.t-m) { display: block; font: 500 var(--t-s)/1.4 var(--f-ui); color: var(--ink-3); margin-top: 2px; }
  .sheet :global(.tog input) { appearance: none; margin: 0; width: 46px; height: 28px; border-radius: 14px; background: var(--rule); position: relative; cursor: pointer; transition: background-color .2s; }
  .sheet :global(.tog input::after) { content: ""; position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: var(--surface); box-shadow: 0 1px 3px oklch(0 0 0 / 0.25); transition: transform .2s; }
  .sheet :global(.tog input:checked) { background: var(--accent); }
  .sheet :global(.tog input:checked::after) { transform: translateX(18px); }
  .sheet :global(.acts) { display: grid; gap: 8px; }
  .sheet :global(.acts.two) { grid-template-columns: 1fr 1fr; }
  .sheet :global(.chips) { display: flex; flex-wrap: wrap; gap: 8px; }
  .sheet :global(.chip) { appearance: none; cursor: pointer; border: 1.5px solid var(--rule); background: transparent; color: var(--ink-2); border-radius: var(--r-m); min-height: 42px; padding: 0 14px; font: 600 var(--t-m)/1 var(--f-ui); display: inline-flex; align-items: center; gap: 8px; }
  .sheet :global(.chip[aria-pressed="true"]) { border-color: var(--accent); color: var(--accent); background: var(--wash); }
  .sheet :global(.hint) { font: 500 var(--t-s)/1.5 var(--f-ui); color: var(--ink-3); margin: 0; }
  .sheet :global(.reset) { appearance: none; border: 0; background: none; cursor: pointer; padding: 0; font: 600 var(--t-s)/1.2 var(--f-ui); color: var(--accent); }
</style>
