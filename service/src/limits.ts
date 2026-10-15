/** What keeps the service small, and inside the Free plan whatever anyone does.
 *
 *  Layers, cheapest first: a request from another site is refused before anything is
 *  read (`sameSite`); every address (and writer) is held to a few requests a minute
 *  (the Rate Limiting binding: loose, counted per location); anything that adds data
 *  needs a person — a writer's session (an invited passkey) or a reader's link and a
 *  Turnstile check; and every addition is counted against exact caps in D1, per writer,
 *  per book, per day and in all, set well inside D1's free limits (500 MB a database,
 *  100,000 rows written a day), past which D1 refuses rather than bills. Workers Free
 *  refuses requests past 100,000 a day the same way: at worst the service pauses until
 *  midnight UTC. */
import { Fail, DAY, now } from './http';

export const LIMITS = {
  /** a sealed book; most manuscripts are well under 2 MB */
  bookBytes: 16 * 1048576,
  /** a reader's sealed notes on one book */
  notesBytes: 512 * 1024,
  /** a writer's sealed vault (their shares' ids and keys: some 150 bytes each) */
  vaultBytes: 64 * 1024,
  /** all books and notes together (D1 holds 500 MB a database on the Free plan) */
  totalBytes: 400 * 1048576,
  /** readers who can send notes on one book */
  readersPerBook: 60,
  /** a day, for everyone together */
  daily: { upload: 60, notes: 3000, register: 10, login: 400, vault: 500 } as Record<string, number>,
  /** how long a link lasts before the writer renews it */
  bookDays: 90,
  sessionDays: 30,
  /** rows are written in pieces under D1's 2 MB row limit */
  chunk: 1048576,
};

const ip = (req: Request) => req.headers.get('cf-connecting-ip') ?? 'local';

/** A few requests a minute per address (or per writer, `who`). */
export async function rate(rl: RateLimit, req: Request, who?: string) {
  const { success } = await rl.limit({ key: who ?? ip(req) });
  if (!success) throw new Fail(429, 'Too many requests just now: wait a minute and try again.');
}

const today = () => new Date().toISOString().slice(0, 10);

/** Counts one of `what` today, refusing past the day's cap (exact: the count is kept in
 *  D1 and checked as it is raised). */
export async function count(db: D1Database, what: string) {
  const r = await db.prepare('INSERT INTO counts (day, what, n) VALUES (?1, ?2, 1) ON CONFLICT (day, what) DO UPDATE SET n = n + 1 RETURNING n')
    .bind(today(), what).first<{ n: number }>();
  if ((r?.n ?? Infinity) > (LIMITS.daily[what] ?? 0)) throw new Fail(503, 'The service has done all it does in a day: try again tomorrow.');
}

/** Bytes kept in all, books and notes. */
export async function stored(db: D1Database): Promise<number> {
  const r = await db.prepare('SELECT (SELECT coalesce(sum(size), 0) FROM books) + (SELECT coalesce(sum(size), 0) FROM notes) AS n').first<{ n: number }>();
  return r?.n ?? 0;
}

/** Requests that change anything come from this app's own pages: a header no other site
 *  can send without asking first (and this API never answers such asking), and, where
 *  the browser says, the same origin. */
export function sameSite(req: Request) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  if (req.headers.get('x-volumen') !== '1') throw new Fail(403, 'Requests come from the app.');
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) throw new Fail(403, 'Requests come from the app.');
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') throw new Fail(403, 'Requests come from the app.');
}

const local = (req: Request) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(req.url).hostname);

/** A Turnstile token for `action`, checked with Cloudflare (siteverify). Fails closed:
 *  with no secret set, nothing that needs a person is done. Turnstile's test keys pass
 *  every check, so they are refused unless this is local development (DEV, on this
 *  computer). */
/** What only some deployments have (wrangler's generated `Env` lists them only where they
 *  are set in .dev.vars). */
type Secrets = { TURNSTILE_SECRET?: string; DEV?: string };

export async function person(cfg: Env, req: Request, token: string | null | undefined, action: string) {
  const env = cfg as Env & Secrets;
  if (!env.TURNSTILE_SECRET) throw new Fail(503, 'The service is not set up yet (it has no Turnstile secret).');
  if (!token || token.length > 2048) throw new Fail(403, 'Please confirm you are a person, then try again.');
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip(req) }),
  });
  const v = await r.json<{ success: boolean; hostname?: string; action?: string; metadata?: { result_with_testing_key?: boolean } }>().catch(() => null);
  if (!v?.success) throw new Fail(403, 'The check that you are a person did not pass: try again.');
  if (v.metadata?.result_with_testing_key) {
    if (env.DEV !== '1' || !local(req)) throw new Fail(503, 'The service is set up with Turnstile’s test keys.');
    return;
  }
  if (v.hostname !== new URL(req.url).hostname || v.action !== action) throw new Fail(403, 'The check that you are a person was for another page: try again.');
}

export const expiry = (days: number) => now() + days * DAY;
