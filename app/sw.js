// The web build's service worker (written into the build by vite.config.ts, which fills in
// VERSION and SHELL). A second visit opens without the network, and a book once opened
// can be read offline:
//   - the app itself (its pages, code, engine) is cached on install;
//   - fonts, hyphenation patterns and the sample book are cached the first time they are
//     used (most visitors need only a few of them);
//   - pages go to the network first, so an update is seen at once, and fall back to the
//     cached app when there is none.
// Each build is a new version: its caches replace the old ones when it takes over (the
// next time the app is opened; never under a reader's hands).
const VERSION = '__VERSION__';
const SHELL = __SHELL__;
// the app's page: / (the desktop app, a local preview) or /read (volumen.page, whose / is
// the site's own page); an address with no network falls back to it
const START = '__START__';
const APP = 'app-' + VERSION, FILES = 'files-' + VERSION;

// what nearly every visit needs: the interface face, the default book face (the last
// fallback of every theme), English patterns, the sample book
const COMMON = ['/fonts/Inter.ttf', '/fonts/Literata.ttf', '/fonts/Literata-Italic.ttf', '/hyph/en.bin', '/sample.epub', '/ui/shadow-16.png', '/ui/shadow-12.png', '/ui/shadow-cover.png'];

self.addEventListener('install', e => {
  e.waitUntil(Promise.all([caches.open(APP).then(c => c.addAll(SHELL)), caches.open(FILES).then(c => c.addAll(COMMON).catch(() => {}))]));
});

// the page names what it fetched before this worker was in charge (the first visit's
// fonts and patterns), so a book opened then opens offline too
self.addEventListener('message', e => {
  const urls = (e.data?.keep ?? []).map(u => new URL(u, location.origin)).filter(u => u.origin === location.origin && kept(u.pathname));
  e.waitUntil(caches.open(FILES).then(async c => { for (const u of urls) if (!(await c.match(u.pathname))) await c.add(u.pathname).catch(() => {}); }));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== APP && k !== FILES) await caches.delete(k);
    await self.clients.claim();
  })());
});

const kept = p => p.startsWith('/assets/') || p.startsWith('/fonts/') || p.startsWith('/hyph/') || p.startsWith('/app/') || p.startsWith('/ui/') || p === '/sample.epub' || p.endsWith('.wasm');

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(async () => (await caches.match(req)) || (await caches.match(START)) || Response.error()));
    return;
  }
  if (!kept(url.pathname)) return;
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreVary: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(url.pathname.startsWith('/assets/') ? APP : FILES).then(c => c.put(req, copy));
    }
    return res;
  })());
});
