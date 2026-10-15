/** What every answer of the API carries, and how it says no. */

export const API_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};

/** A refusal, with what to tell the person (the app shows `why`). */
export class Fail extends Error {
  constructor(public status: number, public why: string) { super(why); }
}

export function json(v: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(v), { status, headers: { ...API_HEADERS, 'content-type': 'application/json', ...extra } });
}

export function bytes(body: BodyInit, size: number): Response {
  return new Response(body, { headers: { ...API_HEADERS, 'content-type': 'application/octet-stream', 'content-length': String(size) } });
}

/** A JSON body no larger than `max` bytes. */
export async function body<T>(req: Request, max = 16384): Promise<T> {
  const n = Number(req.headers.get('content-length') ?? NaN);
  if (!(n <= max)) throw new Fail(413, 'That request is too large.');
  const text = await req.text();
  if (text.length > max) throw new Fail(413, 'That request is too large.');
  try { return JSON.parse(text) as T; } catch { throw new Fail(400, 'That request is damaged.'); }
}

/** A body of raw bytes, exactly as long as it says and no longer than `max`. */
export async function raw(req: Request, max: number): Promise<Uint8Array> {
  const n = Number(req.headers.get('content-length') ?? NaN);
  if (!Number.isInteger(n) || n <= 0) throw new Fail(411, 'The size of what is sent must be given.');
  if (n > max) throw new Fail(413, `That is too large (at most ${amount(max)}).`);
  const b = new Uint8Array(await req.arrayBuffer());
  if (b.length !== n) throw new Fail(400, 'What was sent did not arrive whole.');
  return b;
}

/** A size as people say it. */
export const amount = (n: number) => (n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.round(n / 1024)} KB`);

/* ---------- small cryptographic helpers ---------- */

export const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function unb64url(s: string): Uint8Array {
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0));
}
export const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
export const sha256 = async (b: Uint8Array | string) => hex(await crypto.subtle.digest('SHA-256', typeof b === 'string' ? new TextEncoder().encode(b) : b));
/** A random id: 128 bits, base64url (22 characters). */
export const randomId = (n = 16) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** Two hex digests compared in constant time. */
export function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  return crypto.subtle.timingSafeEqual(ea, eb);
}

export const now = () => Date.now();
export const DAY = 86_400_000;
