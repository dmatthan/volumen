/** A book sealed for a link (D2: end to end, the key in the link's fragment, which is never
 *  sent to a server). Whoever holds the sealed file without the link cannot read it; the
 *  link holds where the file is and the key.
 *
 *    sealed = "VOLS2" | iv (12 bytes) | AES-256-GCM( u32 header length | header JSON | file )
 *    header = { v: 1, name, size, sha256, by? }   (the file's name tells its kind; `by`,
 *             who sent it, as they call themselves)
 *    notes  = "VOLN1" | iv | AES-256-GCM( a notes file, JSON )
 *    link   = <the app>#b=<id at the service>&k=<key, base64url>      (service/, M2)
 *           | <the app>#open=<the sealed file's address>&k=<key>      (a file put anywhere)
 *
 *  The key is 32 random bytes; what it opens is derived from it (HKDF-SHA-256), so no
 *  two uses share a key: the book, the readers' notes, and the token that lets notes be
 *  sent to the service (which keeps only the token's hash, so it can check a sender has
 *  the link without being able to open anything). "VOLS1" (sealed with the key itself,
 *  before the service) is still read. */

const MAGIC = new TextEncoder().encode('VOLS2');
const MAGIC1 = new TextEncoder().encode('VOLS1');
const NOTES = new TextEncoder().encode('VOLN1');

/** What a link's key opens. */
async function derive(raw: Uint8Array) {
  const base = await crypto.subtle.importKey('raw', raw as BufferSource, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const how = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('volumen/1'), info: new TextEncoder().encode(info) });
  const aes = (info: string) => crypto.subtle.deriveKey(how(info), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return {
    book: await aes('book'),
    notes: await aes('notes'),
    post: new Uint8Array(await crypto.subtle.deriveBits(how('post'), base, 256)),
  };
}
const has = (b: Uint8Array, m: Uint8Array) => b.length >= m.length && m.every((x, i) => b[i] === x);

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0));
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');

/** Sealing needs the browser's cryptography, which only a secure page has (https, the
 *  desktop app, localhost). */
export const canSeal = () => typeof crypto !== 'undefined' && !!crypto.subtle && window.isSecureContext;

/** Seals a file with a new key, or with a link's own (`key`: a new draft to the same link). */
export async function seal(file: Uint8Array, name: string, by?: string, linkKey?: string): Promise<{ sealed: Uint8Array; key: string }> {
  const raw = linkKey ? unb64url(linkKey) : crypto.getRandomValues(new Uint8Array(32));
  const key = (await derive(raw)).book;
  const head = new TextEncoder().encode(JSON.stringify({ v: 1, name, size: file.length, sha256: hex(await crypto.subtle.digest('SHA-256', file as BufferSource)), ...(by ? { by: by.slice(0, 60) } : {}) }));
  const plain = new Uint8Array(4 + head.length + file.length);
  new DataView(plain.buffer).setUint32(0, head.length);
  plain.set(head, 4);
  plain.set(file, 4 + head.length);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain as BufferSource));
  const sealed = new Uint8Array(MAGIC.length + iv.length + ct.length);
  sealed.set(MAGIC, 0);
  sealed.set(iv, MAGIC.length);
  sealed.set(ct, MAGIC.length + iv.length);
  return { sealed, key: b64url(raw) };
}

/** The file inside, checked; or why it cannot be had. */
export async function unseal(sealed: Uint8Array, k: string): Promise<{ name: string; bytes: Uint8Array; by?: string } | string> {
  const v1 = has(sealed, MAGIC1);
  if (sealed.length < MAGIC.length + 12 + 16 || !(v1 || has(sealed, MAGIC))) return 'This link does not lead to a book sealed by Volumen.';
  let key: CryptoKey;
  try {
    const raw = unb64url(k);
    if (raw.length !== 32) throw new Error();
    key = v1 ? await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']) : (await derive(raw)).book;
  } catch { return 'This link’s key is damaged.'; }
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(MAGIC.length, MAGIC.length + 12) }, key, sealed.slice(MAGIC.length + 12)));
  } catch { return 'This link’s key does not open the book (or the file was changed).'; }
  const n = new DataView(plain.buffer).getUint32(0);
  let head: { v: number; name: string; size: number; sha256: string; by?: unknown };
  try { head = JSON.parse(new TextDecoder().decode(plain.slice(4, 4 + n))); } catch { return 'The sealed book is damaged.'; }
  if (head.v !== 1) return 'This book was sealed by a newer version of Volumen.';
  const bytes = plain.slice(4 + n);
  if (bytes.length !== head.size || hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource)) !== head.sha256) return 'The sealed book is damaged.';
  return { name: head.name, bytes, by: typeof head.by === 'string' && head.by.trim() ? head.by.trim().slice(0, 60) : undefined };
}

/** A link's parts, from the page's address: a book at the service (`#b=<id>&k=<key>`) or
 *  a sealed file anywhere (`#open=<address>&k=<key>`). */
export type Link = { at: 'service'; id: string; key: string } | { at: 'url'; url: string; key: string };
export function linkOf(hash: string): Link | null {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const key = q.get('k'), id = q.get('b'), url = q.get('open');
  if (!key || !/^[\w-]{43}$/.test(key)) return null;
  if (id && /^[\w-]{22}$/.test(id)) return { at: 'service', id, key };
  return url ? { at: 'url', url, key } : null;
}

const app = () => location.origin + location.pathname;
/** The link for a sealed file put at `url`, opening this app. */
export function linkFor(url: string, key: string, at = app()) {
  return `${at}#open=${encodeURIComponent(url)}&k=${key}`;
}
/** The link for a book kept by the service (this app's own). */
export const serviceLink = (id: string, key: string, at = app()) => `${at}#b=${id}&k=${key}`;

/** The token a link gives for sending notes to the service, and its hash (what the
 *  service keeps when the book is put there). */
export async function postToken(k: string): Promise<{ token: string; hash: string }> {
  const { post } = await derive(unb64url(k));
  return { token: b64url(post), hash: hex(await crypto.subtle.digest('SHA-256', post as BufferSource)) };
}

/** A reader's notes sealed with the book's link (only the link's holders can open them;
 *  the service hands them only to the writer). */
export async function sealNotes(text: string, k: string): Promise<Uint8Array> {
  const { notes } = await derive(unb64url(k));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, notes, new TextEncoder().encode(text)));
  const out = new Uint8Array(NOTES.length + 12 + ct.length);
  out.set(NOTES, 0);
  out.set(iv, NOTES.length);
  out.set(ct, NOTES.length + 12);
  return out;
}
export async function unsealNotes(sealed: Uint8Array, k: string): Promise<string | null> {
  if (!has(sealed, NOTES) || sealed.length < NOTES.length + 12 + 16) return null;
  try {
    const { notes } = await derive(unb64url(k));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(NOTES.length, NOTES.length + 12) }, notes, sealed.slice(NOTES.length + 12));
    return new TextDecoder().decode(plain);
  } catch { return null; }
}

/** This reader's name for themselves at one book (not the same at two, so books cannot be
 *  linked to one reader by it). */
export async function readerId(me: string, bookId: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${me}:${bookId}`))).slice(0, 32);
}
