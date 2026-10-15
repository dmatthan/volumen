/** Volumen's sharing service (docs/PLAN.md, M2): the app's files are static assets; this
 *  Worker answers /api/* only. See limits.ts for what keeps it inside the Free plan. */
import { Fail, json, now, DAY } from './http';
import { sameSite } from './limits';
import { writerOf, mustWriter, registerBegin, registerFinish, loginBegin, loginFinish, logout } from './auth';
import { list, publish, renew, withdraw, inbox, readerNotes, fetchBook, sendNotes, drop, getVault, putVault, newDraft, bookVersion } from './books';

type Route = [method: string, pattern: RegExp, handle: (env: Env, req: Request, m: string[]) => Promise<Response>];

const ROUTES: Route[] = [
  ['GET', /^\/api\/config$/, async (env, req) => {
    const w = await writerOf(env, req);
    return json({ v: 1, turnstile: env.TURNSTILE_SITEKEY || null, writer: w ? { name: w.name } : null });
  }],
  ['POST', /^\/api\/auth\/register\/begin$/, registerBegin],
  ['POST', /^\/api\/auth\/register\/finish$/, registerFinish],
  ['POST', /^\/api\/auth\/login\/begin$/, loginBegin],
  ['POST', /^\/api\/auth\/login\/finish$/, loginFinish],
  ['POST', /^\/api\/auth\/logout$/, logout],
  ['GET', /^\/api\/shares$/, async (env, req) => list(env, await mustWriter(env, req))],
  ['POST', /^\/api\/shares$/, async (env, req) => publish(env, req, await mustWriter(env, req))],
  ['PUT', /^\/api\/shares\/([\w-]+)\/draft$/, async (env, req, m) => newDraft(env, req, await mustWriter(env, req), m[1])],
  ['GET', /^\/api\/books\/([\w-]+)\/version$/, (env, req, m) => bookVersion(env, req, m[1])],
  ['POST', /^\/api\/shares\/([\w-]+)\/renew$/, async (env, req, m) => renew(env, req, await mustWriter(env, req), m[1])],
  ['DELETE', /^\/api\/shares\/([\w-]+)$/, async (env, req, m) => withdraw(env, req, await mustWriter(env, req), m[1])],
  ['GET', /^\/api\/vault$/, async (env, req) => getVault(env, await mustWriter(env, req))],
  ['PUT', /^\/api\/vault$/, async (env, req) => putVault(env, req, await mustWriter(env, req))],
  ['GET', /^\/api\/inbox$/, async (env, req) => inbox(env, await mustWriter(env, req))],
  ['GET', /^\/api\/shares\/([\w-]+)\/notes\/(\w+)$/, async (env, req, m) => readerNotes(env, await mustWriter(env, req), m[1], m[2])],
  ['GET', /^\/api\/books\/([\w-]+)$/, (env, req, m) => fetchBook(env, req, m[1])],
  ['PUT', /^\/api\/books\/([\w-]+)\/notes\/(\w+)$/, (env, req, m) => sendNotes(env, req, m[1], m[2])],
];

export default {
  async fetch(req, env): Promise<Response> {
    const path = new URL(req.url).pathname;
    try {
      sameSite(req);
      let allowed = false;
      for (const [method, pattern, handle] of ROUTES) {
        const m = pattern.exec(path);
        if (!m) continue;
        allowed = true;
        if (method === req.method) return await handle(env, req, m);
      }
      throw allowed ? new Fail(405, 'Not like that.') : new Fail(404, 'No such thing here.');
    } catch (e) {
      if (e instanceof Fail) return json({ error: e.why }, e.status);
      // (nothing about the request or its contents is logged)
      console.error('volumen: failed', path.replace(/[\w-]{20,}/g, '…'), (e as Error)?.name);
      return json({ error: 'The service failed: try again in a moment.' }, 500);
    }
  },

  /** Once a day: expired books (with their notes), half-made uploads, and spent
   *  sessions, ceremonies, invitations and counts. */
  async scheduled(_ctrl, env) {
    const t = now();
    const gone = (await env.DB.prepare('SELECT id FROM books WHERE expires < ?1 OR (complete = 0 AND created < ?2) LIMIT 40').bind(t, t - 3_600_000).all<{ id: string }>()).results;
    await drop(env.DB, gone.map(b => b.id));
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires < ?1').bind(t),
      env.DB.prepare('DELETE FROM passes WHERE expires < ?1').bind(t),
      env.DB.prepare('DELETE FROM challenges WHERE expires < ?1').bind(t),
      env.DB.prepare('DELETE FROM invites WHERE expires < ?1').bind(t - 30 * DAY),
      env.DB.prepare('DELETE FROM counts WHERE day < ?1').bind(new Date(t - 7 * DAY).toISOString().slice(0, 10)),
    ]);
  },
} satisfies ExportedHandler<Env>;
