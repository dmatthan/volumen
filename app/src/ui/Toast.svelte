<script lang="ts">
  import { ui } from '../reader/reader.svelte';
</script>

<div class="toast lift r12" class:show={ui.toastOn} role="status" aria-live="polite">{ui.toast}</div>

<style>
  .toast {
    /* centred by its margins, so a long message has the window's width to wrap in, and
       any word (a file name, a path) may break */
    position: absolute; left: 0; right: 0; margin: 0 auto; width: fit-content; bottom: calc(24px + max(env(safe-area-inset-bottom), var(--kb, 0px)));
    z-index: 60; transform: translateY(12px); opacity: 0; overflow-wrap: anywhere;
    padding: 12px 18px; border-radius: var(--r-m); max-width: min(620px, calc(100% - 32px)); box-sizing: border-box;
    background: var(--ink); color: var(--surface); font: 600 var(--t-m)/1.35 var(--f-ui);
    transition: opacity .25s, transform .25s; pointer-events: none; text-align: center;
  }
  .toast.show { opacity: 1; transform: none; }
</style>
