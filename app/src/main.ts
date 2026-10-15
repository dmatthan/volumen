import { mount } from 'svelte';
import './styles/tokens.css';
import './styles/reader.css';
import { makeCore } from './core';
import type { Core } from './core/types';
import { initKV } from './core/kv';
import { watchTouch, noPageZoom, followKeyboard } from './ui/touch';

watchTouch();
noPageZoom();
followKeyboard();

// state first: modules below read their stored settings as they load
let core: Core | undefined;
try {
  await initKV();
  core = await makeCore();
  const { default: App } = await import('./ui/App.svelte');
  mount(App, { target: document.getElementById('app')!, props: { core } });
} catch (e) {
  // never a blank page: what went wrong, and what to try
  const p = document.createElement('p');
  p.className = 'failed';
  p.textContent = `Volumen could not start (${(e as Error)?.message || e}). Reloading the page usually helps.`;
  document.getElementById('app')!.append(p);
  throw e;
}

// the web build works offline once visited (sw.js); never in development or the desktop app
if (import.meta.env.PROD && 'serviceWorker' in navigator && !('__TAURI_INTERNALS__' in window)) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // tell it what was fetched before it was in charge; and again now and then, as books
  // open (it keeps only what it lacks)
  const keep = async () => {
    const reg = await navigator.serviceWorker.ready;
    const urls = [...performance.getEntriesByType('resource').map(e => e.name), ...((await core?.fetched?.()) ?? [])];
    reg.active?.postMessage({ keep: urls });
  };
  keep();
  setInterval(keep, 30000);
}
