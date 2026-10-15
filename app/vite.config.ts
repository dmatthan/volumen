import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** The web build for volumen.page (`VOLUMEN_WEB=1`): the app at /read, and the site's own
 *  page, privacy page, stylesheet and script (app/site/) at the root. Other builds (the
 *  desktop app's, the local preview) keep the app at /. */
const WEB = !!process.env.VOLUMEN_WEB;
/** The kit (`VOLUMEN_KIT=1`): the reader alone, to put in a folder of any site, with
 *  volumen.js, the elements that place it on a page (app/kit/, docs/PLAN.md N13). */
const KIT = !!process.env.VOLUMEN_KIT;
const START = WEB ? '/read' : '/';

/** Writes the service worker (sw.js) into the web build: the build's own files are its
 *  shell, and a hash of them its version, so each build replaces the last. */
function serviceWorker(): Plugin {
  return {
    name: 'volumen-sw',
    apply: () => !KIT,
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
      // the elements, for pages that use the reader from here (https://volumen.page/volumen.js)
      this.emitFile({ type: 'asset', fileName: 'volumen.js', source: readFileSync(new URL('./kit/volumen.js', import.meta.url)) });
    },
  };
}

/** The kit's layout: the reader's page as embed.html, volumen.js beside it, and none of
 *  the app's own extras (the sample, the site's headers, the install manifest). */
function kit(): Plugin {
  return {
    name: 'volumen-kit',
    apply: () => KIT,
    enforce: 'post',
    generateBundle(_, bundle) {
      const app = bundle['index.html'];
      if (app) { delete bundle['index.html']; app.fileName = 'embed.html'; bundle['embed.html'] = app; }
      for (const f of readdirSync(new URL('./kit/', import.meta.url))) this.emitFile({ type: 'asset', fileName: f, source: readFileSync(new URL('./kit/' + f, import.meta.url)) });
    },
    closeBundle() {
      const out = new URL('./dist-kit/', import.meta.url).pathname;
      for (const f of ['sample.epub', '_headers', 'app']) rmSync(out + f, { recursive: true, force: true });
    },
  };
}

// Tauri expects a fixed port and no clearing of its output.
export default defineConfig({
  plugins: [svelte(), website(), kit(), serviceWorker()],
  base: KIT ? './' : '/',
  define: { 'import.meta.env.VOLUMEN_KIT': JSON.stringify(KIT) },
  publicDir: '../assets',
  clearScreen: false,
  server: { port: 5193, strictPort: true, fs: { allow: ['..'] } },
  build: { target: 'es2022', outDir: KIT ? 'dist-kit' : 'dist', assetsInlineLimit: 0, sourcemap: false },
  worker: { format: 'es' },
});
