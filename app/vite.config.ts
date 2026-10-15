import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** The web build for volumen.page (`VOLUMEN_WEB=1`): the app at /read, and the site's own
 *  page, privacy page, stylesheet and script (app/site/) at the root. Other builds (the
 *  desktop app's, the local preview) keep the app at /. */
const WEB = !!process.env.VOLUMEN_WEB;
const START = WEB ? '/read' : '/';

/** Writes the service worker (sw.js) into the web build: the build's own files are its
 *  shell, and a hash of them its version, so each build replaces the last. */
function serviceWorker(): Plugin {
  return {
    name: 'volumen-sw',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      const files = Object.keys(bundle).filter(f => !f.endsWith('.map'));
      // (pages by their address, not their file: a host may redirect /x.html to /x)
      const shell = [START, ...(WEB ? ['/embed'] : []), ...files.filter(f => !f.endsWith('.html')).map(f => '/' + f), '/app/manifest.webmanifest'];
      const version = createHash('sha256').update(files.sort().join('\n')).digest('hex').slice(0, 12);
      const src = readFileSync(new URL('./sw.js', import.meta.url), 'utf8').replace('__VERSION__', version).replace('__SHELL__', JSON.stringify(shell)).replace('__START__', START);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}

/** The web build's layout: the app's page becomes read.html (served as /read), and the
 *  site's files go at the root. */
function website(): Plugin {
  return {
    name: 'volumen-site',
    apply: () => WEB,
    enforce: 'post',
    generateBundle(_, bundle) {
      const app = bundle['index.html'];
      if (app) {
        delete bundle['index.html']; app.fileName = 'read.html'; bundle['read.html'] = app;
        // the same app, for a book embedded in another site's page (core/embed.ts)
        if (app.type === 'asset') this.emitFile({ type: 'asset', fileName: 'embed.html', source: app.source });
      }
      const dir = new URL('./site/', import.meta.url);
      for (const f of readdirSync(dir)) this.emitFile({ type: 'asset', fileName: f, source: readFileSync(new URL(f, dir)) });
    },
  };
}

// Tauri expects a fixed port and no clearing of its output.
export default defineConfig({
  plugins: [svelte(), website(), serviceWorker()],
  publicDir: '../assets',
  clearScreen: false,
  server: { port: 5193, strictPort: true, fs: { allow: ['..'] } },
  build: { target: 'es2022', outDir: 'dist', assetsInlineLimit: 0, sourcemap: false },
  worker: { format: 'es' },
});
