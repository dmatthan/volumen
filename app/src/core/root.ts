/** The build's own root, where its fonts/, hyph/ and ui/ are: in a build, the folder above
 *  assets/ (every script is there, the engine's worker too); in development, the dev
 *  server's. So the reader works at a site's root (volumen.page) and in a folder of
 *  another site (the kit: docs/PLAN.md N13). */
export const ROOT = import.meta.env.DEV ? new URL('/', location.href).href : new URL(/* @vite-ignore */ '../', import.meta.url).href;
export const at = (path: string) => ROOT + path.replace(/^\//, '');
/** The kit: the reader alone, in someone else's site (no service worker, no site pages). */
export const KIT = !!import.meta.env.VOLUMEN_KIT;
