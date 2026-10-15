/** The sharing service (service/, docs/PLAN.md M2): this app's own API at the same address
 *  when the app is served by it (Cloudflare); absent on the dev server and in the desktop
 *  app, where sharing falls back to sealed files put anywhere.
 *
 *  Writers sign in with a passkey (made once with an invitation); readers need nothing but
 *  the link. Everything sent is sealed first (core/share.ts): the service holds bytes it
 *  cannot read. */
import { isTauri } from './shell';
import { kv } from './kv';
import { seal, unseal, postToken, sealNotes, unsealNotes, readerId, serviceLink } from './share';
import type { Core } from './types';
import { parseNotes, receive, me, type NotesFile } from '../reader/feedback';

export interface ServiceConfig { v: 1; turnstile: string | null; writer: { name: string } | null }

export class ServiceError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let cfg: Promise<ServiceConfig | null> | null = null;
/** The service, if this app has one (asked once; `fresh` asks again, after signing in). */
export function service(fresh = false): Promise<ServiceConfig | null> {
  if (isTauri || typeof fetch !== 'function') return Promise.resolve(null);
  if (!cfg || fresh) {
    cfg = fetch('/api/config', { credentials: 'same-origin' })
      .then(r => (r.ok && r.headers.get('content-type')?.includes('json') ? r.json() : null))
      .then(v => (v?.v === 1 ? v : null))
      .catch(() => null);
  }
  return cfg;
}

async function call<T = unknown>(method: string, path: string, body?: Uint8Array | object, headers: Record<string, string> = {}, keepalive = false): Promise<T> {
  const h: Record<string, string> = { 'x-volumen': '1', ...headers };
  let b: BodyInit | undefined;
  if (body instanceof Uint8Array) { b = body as BlobPart as BodyInit; h['content-type'] = 'application/octet-stream'; }
  else if (body) { b = JSON.stringify(body); h['content-type'] = 'application/json'; }
  let r: Response;
  try { r = await fetch(path, { method, headers: h, body: b, credentials: 'same-origin', keepalive }); }
  catch { throw new ServiceError(0, 'The service could not be reached: are you online?'); }
  if (!r.ok) {
    const e = await r.json().catch(() => null) as { error?: string } | null;
    throw new ServiceError(r.status, e?.error ?? (r.status === 429 ? 'Too many requests just now: wait a minute and try again.' : `The service did not answer (${r.status}).`));
  }
  return (r.headers.get('content-type')?.includes('json') ? r.json() : r.arrayBuffer()) as Promise<T>;
}

/* ---------- passkeys (WebAuthn), with the JSON the server speaks ---------- */

const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0));

type PKC = typeof PublicKeyCredential & {
  parseCreationOptionsFromJSON?: (o: unknown) => PublicKeyCredentialCreationOptions;
  parseRequestOptionsFromJSON?: (o: unknown) => PublicKeyCredentialRequestOptions;
};

export const canPasskey = () => typeof window !== 'undefined' && 'PublicKeyCredential' in window && !!navigator.credentials && window.isSecureContext;

function creationOptions(o: any): PublicKeyCredentialCreationOptions {
  const P = PublicKeyCredential as PKC;
  if (P.parseCreationOptionsFromJSON) return P.parseCreationOptionsFromJSON(o);
  return {
    ...o, challenge: unb64url(o.challenge), user: { ...o.user, id: unb64url(o.user.id) },
    excludeCredentials: (o.excludeCredentials ?? []).map((c: any) => ({ ...c, id: unb64url(c.id) })),
  };
}
function requestOptions(o: any): PublicKeyCredentialRequestOptions {
  const P = PublicKeyCredential as PKC;
  if (P.parseRequestOptionsFromJSON) return P.parseRequestOptionsFromJSON(o);
  return { ...o, challenge: unb64url(o.challenge), allowCredentials: (o.allowCredentials ?? []).map((c: any) => ({ ...c, id: unb64url(c.id) })) };
}
/** The credential as the server reads it, without the passkey's PRF secret: that never
 *  leaves the device (it seals the writer's vault, below). */
function credentialJSON(c: PublicKeyCredential): object {
  const out = credentialJSONWithAll(c) as { clientExtensionResults?: Record<string, unknown> };
  if (out.clientExtensionResults) { const { prf: _, ...rest } = out.clientExtensionResults; out.clientExtensionResults = rest; }
  return out;
}
function credentialJSONWithAll(c: PublicKeyCredential): object {
  const j = (c as PublicKeyCredential & { toJSON?: () => object }).toJSON;
  if (typeof j === 'function') { try { return structuredClone(j.call(c)); } catch { /* below */ } }
  const response: Record<string, unknown> = { clientDataJSON: b64url(c.response.clientDataJSON) };
  if ('attestationObject' in c.response) {
    const r = c.response as AuthenticatorAttestationResponse;
    response.attestationObject = b64url(r.attestationObject);
    response.transports = r.getTransports?.() ?? [];
  } else {
    const r = c.response as AuthenticatorAssertionResponse;
    response.authenticatorData = b64url(r.authenticatorData);
    response.signature = b64url(r.signature);
    if (r.userHandle) response.userHandle = b64url(r.userHandle);
  }
  return { id: c.id, rawId: b64url(c.rawId), type: c.type, response, clientExtensionResults: { ...c.getClientExtensionResults() }, authenticatorAttachment: c.authenticatorAttachment ?? undefined };
}

const cancelled = (e: unknown) => (e as Error)?.name === 'NotAllowedError' || (e as Error)?.name === 'AbortError';

/** Makes a passkey with an invitation, and signs in. Null if the person cancelled. */
export async function register(invite: string, name: string, turnstile: string): Promise<{ name: string } | null> {
  const { cid, options } = await call<{ cid: string; options: unknown }>('POST', '/api/auth/register/begin', { invite, name, turnstile });
  let c: PublicKeyCredential | null;
  try { c = await navigator.credentials.create({ publicKey: withPrf(creationOptions(options)) }) as PublicKeyCredential | null; }
  catch (e) { if (cancelled(e)) return null; throw e; }
  if (!c) return null;
  const r = await call<{ name: string }>('POST', '/api/auth/register/finish', { cid, response: credentialJSON(c) });
  await service(true);
  // the vault's key: given at once by some passkeys, by others only when next used
  const prf = prfOf(c);
  if (prf) await keepVaultKey(prf);
  else if ((c.getClientExtensionResults() as { prf?: { enabled?: boolean } }).prf?.enabled) await unlockVault().catch(() => {});
  return r;
}

/** Signs in with a passkey made here before. Null if the person cancelled. */
export async function signIn(turnstile: string): Promise<{ name: string } | null> {
  const { cid, options } = await call<{ cid: string; options: unknown }>('POST', '/api/auth/login/begin', { turnstile });
  let c: PublicKeyCredential | null;
  try { c = await navigator.credentials.get({ publicKey: withPrf(requestOptions(options)) }) as PublicKeyCredential | null; }
  catch (e) { if (cancelled(e)) return null; throw e; }
  if (!c) return null;
  const r = await call<{ name: string }>('POST', '/api/auth/login/finish', { cid, response: credentialJSON(c) });
  await service(true);
  const prf = prfOf(c);
  if (prf) await keepVaultKey(prf);
  return r;
}

export async function signOut() {
  await call('POST', '/api/auth/logout', {});
  // (this device keeps the shares it has, but no longer opens the vault)
  kv.set('vault.key', null);
  await service(true);
}

/* ---------- the writer's vault: their shares on every device ----------
 *
 * A passkey can give a secret of its own for a salt (WebAuthn's PRF extension), the same
 * on every device the passkey is synced to (iCloud Keychain, Google Password Manager),
 * and never sent anywhere. From it comes the key of the writer's vault: their shares
 * (each book's link id and key), sealed, kept at the service, which cannot open it.
 * Signing in on another device with the same passkey opens it, and the shared books are
 * fetched into that library. Without PRF (some browsers, some security keys), a writer
 * opens a link once on each device instead.
 *
 *    vault = "VOLV1" | iv | AES-256-GCM( { v: 1, shares: { bookId: Shared } } )
 */

const PRF_SALT = new TextEncoder().encode('volumen vault 1');
const VAULT = new TextEncoder().encode('VOLV1');

function withPrf<T extends PublicKeyCredentialCreationOptions | PublicKeyCredentialRequestOptions>(o: T): T {
  return { ...o, extensions: { ...(o.extensions ?? {}), prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs };
}
function prfOf(c: PublicKeyCredential): ArrayBuffer | null {
  const r = (c.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf?.results?.first;
  return r && r.byteLength >= 32 ? r : null;
}
async function keepVaultKey(prf: ArrayBuffer) {
  const base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('volumen/1'), info: new TextEncoder().encode('vault') }, base, 256);
  kv.set('vault.key', b64url(bits));
}
const vaultKey = async () => {
  const k = kv.get<string | null>('vault.key', null);
  return k ? crypto.subtle.importKey('raw', unb64url(k), 'AES-GCM', false, ['encrypt', 'decrypt']) : null;
};
/** Whether this device opens the writer's vault. */
export const hasVault = () => !!kv.get<string | null>('vault.key', null);

/** Asks the passkey for the vault's key alone (no signing in): after making a passkey
 *  that gives it only when used, or for a session from before. False if it cannot. */
export async function unlockVault(): Promise<boolean> {
  let c: PublicKeyCredential | null = null;
  try {
    c = await navigator.credentials.get({ publicKey: withPrf({ challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname, userVerification: 'required', timeout: 120_000 }) }) as PublicKeyCredential | null;
  } catch (e) { if (cancelled(e)) return false; throw e; }
  const prf = c && prfOf(c);
  if (!prf) return false;
  await keepVaultKey(prf);
  return true;
}

/** Brings this device's shares and the vault together: shares made elsewhere come here
 *  (their books fetched from the service into this library), these go there, and links
 *  withdrawn anywhere are dropped. How many books were added here. */
export async function syncShares(core: Core): Promise<number> {
  const key = await vaultKey();
  if (!key || !(await service())?.writer) return 0;
  const held = new Uint8Array(await call<ArrayBuffer>('GET', '/api/vault'));
  let remote: Record<string, Shared> = {};
  if (held.length > VAULT.length + 12 && VAULT.every((m, i) => held[i] === m)) {
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: held.slice(VAULT.length, VAULT.length + 12) }, key, held.slice(VAULT.length + 12));
      remote = JSON.parse(new TextDecoder().decode(plain)).shares ?? {};
    } catch { /* sealed by another passkey: this one starts its own */ }
  }
  const local: Record<string, Shared> = {};
  for (const k of kv.keys('share.')) { const v = kv.get<Shared | null>(k, null); if (v) local[k.slice('share.'.length)] = v; }
  const live = new Set((await myShares()).books.map(b => b.id));
  const merged: Record<string, Shared> = {};
  for (const [book, s] of Object.entries({ ...remote, ...local })) {
    if (live.has(s.id)) merged[book] = s;
    else if (local[book]) kv.set('share.' + book, null);
  }
  const have = new Set((await core.library()).map(e => e.id));
  let added = 0;
  for (const [book, s] of Object.entries(merged)) {
    if (!local[book]) kv.set('share.' + book, s);
    if (have.has(book)) continue;
    const f = await unseal(await fetchSealed(s.id), s.key);
    if (typeof f !== 'string') { await core.importFile(f.bytes, f.name); added++; }
  }
  if (JSON.stringify(merged) !== JSON.stringify(remote)) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify({ v: 1, shares: merged }))));
    const out = new Uint8Array(VAULT.length + 12 + ct.length);
    out.set(VAULT, 0); out.set(iv, VAULT.length); out.set(ct, VAULT.length + 12);
    await call('PUT', '/api/vault', out);
  }
  return added;
}

/* ---------- Turnstile: that a person is asking ---------- */

let tsLoad: Promise<void> | null = null;
declare global { interface Window { turnstile?: any } }
function loadTurnstile(): Promise<void> {
  tsLoad ??= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => ok();
    s.onerror = () => { tsLoad = null; fail(new ServiceError(0, 'The check that you are a person could not load: are you online?')); };
    document.head.appendChild(s);
  });
  return tsLoad;
}

/** A Turnstile token for `action`, the widget drawn in `el` (shown only if it needs the
 *  person to do something). */
export async function personToken(el: HTMLElement, sitekey: string, action: string): Promise<string> {
  await loadTurnstile();
  el.replaceChildren();
  return new Promise((ok, fail) => {
    window.turnstile.render(el, {
      sitekey, action, appearance: 'interaction-only', theme: 'auto', 'refresh-expired': 'manual',
      callback: (t: string) => ok(t),
      'error-callback': () => fail(new ServiceError(0, 'The check that you are a person did not pass: try again.')),
    });
  });
}

/* ---------- writers: shared books ---------- */

/** What the writer keeps about a book they shared (kv `share.<book>`): its id at the
 *  service and its link's key (which the service never sees). */
export interface Shared { id: string; key: string; expires: number }
export const sharedOf = (bookId: string) => kv.get<Shared | null>('share.' + bookId, null);

export interface MyShares { name: string; used: number; maxBytes: number; maxBooks: number; books: { id: string; size: number; created: number; expires: number; readers: number; updated: number | null }[] }
export const myShares = () => call<MyShares>('GET', '/api/shares');

/** Seals the book's file and puts it at the service; the link comes back. */
export async function publish(bookId: string, file: { name: string; bytes: Uint8Array }): Promise<string> {
  const s = await seal(file.bytes, file.name, (await service())?.writer?.name);
  const { hash } = await postToken(s.key);
  const r = await call<{ id: string; expires: number }>('POST', '/api/shares', s.sealed, { 'x-post': hash });
  kv.set('share.' + bookId, { id: r.id, key: s.key, expires: r.expires } satisfies Shared);
  return serviceLink(r.id, s.key);
}

export async function renew(bookId: string): Promise<number> {
  const s = sharedOf(bookId);
  if (!s) throw new ServiceError(404, 'This book is not shared.');
  const r = await call<{ expires: number }>('POST', `/api/shares/${s.id}/renew`, {});
  kv.set('share.' + bookId, { ...s, expires: r.expires });
  return r.expires;
}

/** Withdraws the link: it stops working, and readers' notes on it at the service go. */
export async function withdraw(bookId: string) {
  const s = sharedOf(bookId);
  if (!s) return;
  await call('DELETE', `/api/shares/${s.id}`).catch(e => { if (!(e instanceof ServiceError && e.status === 404)) throw e; });
  kv.set('share.' + bookId, null);
}

/** Readers' notes that arrived since last asked, taken in as feedback on their books
 *  (as a notes file would be). What came, per book. */
export async function collectNotes(): Promise<{ book: string; from: string; notes: number }[]> {
  const c = await service();
  if (!c?.writer) return [];
  const books = new Map<string, [string, Shared]>();
  for (const k of kv.keys('share.')) {
    const s = kv.get<Shared | null>(k, null);
    if (s) books.set(s.id, [k.slice('share.'.length), s]);
  }
  if (!books.size) return [];
  const { notes } = await call<{ notes: { book: string; reader: string; updated: number }[] }>('GET', '/api/inbox');
  const seen = kv.get<Record<string, number>>('inbox.seen', {});
  const out: { book: string; from: string; notes: number }[] = [];
  for (const n of notes) {
    const tag = `${n.book}/${n.reader}`;
    const b = books.get(n.book);
    if (!b || (seen[tag] ?? 0) >= n.updated) continue;
    const sealed = new Uint8Array(await call<ArrayBuffer>('GET', `/api/shares/${n.book}/notes/${n.reader}`));
    const text = await unsealNotes(sealed, b[1].key);
    const files = text ? parseNotes(text) : 'damaged';
    seen[tag] = n.updated;
    if (typeof files === 'string') continue;
    for (const f of files) {
      receive({ ...f, book: { ...f.book, id: b[0] } }, b[0]);
      out.push({ book: b[0], from: f.from.name || 'A reader', notes: f.notes.length });
    }
  }
  kv.set('inbox.seen', seen);
  return out;
}

/* ---------- readers ---------- */

/** What a reader keeps about a book they were sent by link (kv `joined.<book>`), to send
 *  their notes back to it: the link's id and key; after a first send, the service's
 *  pass for later ones, what was sent (a digest), and whether to send by themselves. */
export interface Joined { id: string; key: string; sent?: number; pass?: string; digest?: string; auto?: boolean }
export const joinedOf = (bookId: string) => kv.get<Joined | null>('joined.' + bookId, null);

export async function fetchSealed(id: string): Promise<Uint8Array> {
  return new Uint8Array(await call<ArrayBuffer>('GET', `/api/books/${id}`));
}

/** What a notes file says, as a short string: unchanged notes are not sent again. */
function digestOf(f: NotesFile): string {
  const t = JSON.stringify([f.from.name, f.notes]);
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193);
  return `${t.length}:${(h >>> 0).toString(36)}`;
}

/** Sends this reader's notes on a book to its writer, replacing what they sent before:
 *  with a person's check (`turnstile`) the first time, with the pass it earned after. */
export async function sendNotes(bookId: string, file: NotesFile, turnstile?: string, keepalive = false) {
  const j = joinedOf(bookId);
  if (!j) throw new ServiceError(404, 'This book did not come by link.');
  if (!turnstile && !j.pass) throw new ServiceError(403, 'Send your notes once yourself first.');
  const sealed = await sealNotes(JSON.stringify(file), j.key);
  const { token } = await postToken(j.key);
  const proof: Record<string, string> = turnstile ? { 'x-turnstile': turnstile } : { 'x-pass': j.pass! };
  try {
    const r = await call<{ sent: number; pass?: string }>('PUT', `/api/books/${j.id}/notes/${await readerId(me().id, j.id)}`, sealed,
      { authorization: `Post ${token}`, ...proof }, keepalive && sealed.length < 60_000);
    kv.set('joined.' + bookId, { ...j, sent: Date.now(), pass: r.pass ?? j.pass, digest: digestOf(file) } satisfies Joined);
  } catch (e) {
    // a pass no longer good (the book withdrawn or renewed away): the next send asks again
    if (!turnstile && e instanceof ServiceError && e.status === 403) kv.set('joined.' + bookId, { ...j, pass: undefined });
    throw e;
  }
}

/** Sends the reader's notes by themselves (as they leave the book, or the app goes to
 *  the background): only after a first send, only if they changed, never asking. */
const sending = new Map<string, string>();
export function sendQuietly(bookId: string, file: NotesFile) {
  const j = joinedOf(bookId), d = digestOf(file);
  // (leaving the book and the page hiding come together: one send for the same notes)
  if (!j?.pass || j.auto === false || j.digest === d || sending.get(bookId) === d) return;
  sending.set(bookId, d);
  sendNotes(bookId, file, undefined, true).catch(() => { /* tried again next time */ }).finally(() => { if (sending.get(bookId) === d) sending.delete(bookId); });
}
