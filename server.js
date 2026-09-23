import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { readState, patchField } from './store.js';
const root = dirname(fileURLToPath(import.meta.url));
export function createApp(config = process.env) {
  const origin = new URL(config.APP_URL || 'http://localhost:3000').origin;
  const secure = origin.startsWith('https:');
  if (!secure && !['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Use HTTPS for a deployed APP_URL.');
  const secret = config.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('Set a random SESSION_SECRET of at least 32 characters.');
  const pending = new Map();
  const signature = s => createHmac('sha256', secret).update(s).digest('base64url');
  function sign(value) { const s = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${s}.${signature(s)}`; }
  function verify(token = '') {
    try {
      const [s, sig] = token.split('.'), a = Buffer.from(sig || ''), b = Buffer.from(signature(s));
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      const data = JSON.parse(Buffer.from(s, 'base64url').toString());
      return data.exp > Date.now() ? data : null;
    } catch { return null; }
  }
  function cookie(name, value, age) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`;
  }
  async function allowed(email) {
    const list = JSON.parse(await readFile(join(root, 'allowed-users.json'), 'utf8'));
    return list.some(e => e.trim().toLowerCase() === email.toLowerCase());
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const redirect = location => { res.writeHead(302, { Location: location }); res.end(); };
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')));
    const url = new URL(req.url, origin);
    try {
      if (req.method === 'GET' && url.pathname === '/auth/google') {
        if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) return json(503, { message: 'Google sign-in is not configured yet.' });
        for (const [k, v] of pending) if (v.exp < Date.now()) pending.delete(k);
        if (pending.size >= 1000) return json(429, { message: 'Try signing in later.' });
        const state = randomBytes(32).toString('hex');
        pending.set(state, { exp: Date.now() + 600000 });
        res.setHeader('Set-Cookie', cookie('oauth_state', state, 600));
        const dest = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        dest.search = new URLSearchParams({ client_id: config.GOOGLE_CLIENT_ID,
          redirect_uri: `${origin}/auth/callback`, response_type: 'code', scope: 'openid email', state });
        return redirect(dest.href);
      }
      if (req.method === 'GET' && url.pathname === '/auth/callback') {
        const state = url.searchParams.get('state');
        const record = pending.get(state);
        if (!record || record.exp < Date.now() || cookies.oauth_state !== state || !url.searchParams.get('code')) return json(400, { message: 'Sign-in expired. Try again.' });
        pending.delete(state);
        res.setHeader('Set-Cookie', cookie('oauth_state', '', 0));
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST', signal: AbortSignal.timeout(10000),
          body: new URLSearchParams({ code: url.searchParams.get('code'), client_id: config.GOOGLE_CLIENT_ID,
            client_secret: config.GOOGLE_CLIENT_SECRET, redirect_uri: `${origin}/auth/callback`, grant_type: 'authorization_code' })
        });
        if (!tokenResponse.ok) return json(401, { message: 'Google sign-in failed. Try again.' });
        const tokens = await tokenResponse.json();
        const identityResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(10000)
        });
        if (!identityResponse.ok) return json(401, { message: 'Google identity could not be verified.' });
        const identity = await identityResponse.json();
        if (identity.email_verified !== true || !identity.email || !identity.sub || !await allowed(identity.email)) return json(403, { message: 'This Google account is not on the team access list.' });
        const session = { email: identity.email, csrf: randomBytes(32).toString('hex'), exp: Date.now() + 14 * 86400000 };
        res.setHeader('Set-Cookie', [cookie('oauth_state', '', 0), cookie('session', sign(session), 14 * 86400)]);
        return redirect('/');
      }
      const session = verify(cookies.session);
      const authenticated = session && await allowed(session.email);
      if (!authenticated) {
        if (url.pathname.startsWith('/api/')) return json(401, { message: 'Please sign in again.' });
        return redirect('/auth/google');
      }
      if (url.pathname === '/api/state' && req.method === 'GET') {
        const state = await readState();
        // Delivery bookkeeping never goes to players' browsers.
        const { reminderReceipts, ...publicState } = state;
        return json(200, { ...publicState, csrf: session.csrf });
      }
      if (url.pathname === '/api/field' && req.method === 'PATCH') {
        if (req.headers.origin !== origin || req.headers['x-csrf-token'] !== session.csrf) return json(403, { message: 'Invalid request origin or session.' });
        if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(415, { message: 'Expected JSON.' });
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 20000) return json(413, { message: 'Update is too large.' });
        }
        let patch;
        try { patch = JSON.parse(body); } catch { return json(400, { message: 'Invalid JSON.' }); }
        return json(200, await patchField(patch));
      }
      if (url.pathname === '/auth/logout' && req.method === 'POST') {
        if (req.headers.origin !== origin || req.headers['x-csrf-token'] !== session.csrf) return json(403, { message: 'Invalid request.' });
        res.setHeader('Set-Cookie', cookie('session', '', 0));
        return json(200, { loggedOut: true });
      }
      const files = { '/': ['tennis.html', 'text/html; charset=utf-8'], '/tennis.html': ['tennis.html', 'text/html; charset=utf-8'],
        '/assets/racket-left.png': ['racket-left.png', 'image/png'], '/assets/racket-right.png': ['racket-right.png', 'image/png'] };
      const file = files[url.pathname];
      if (req.method !== 'GET' || !file) return json(404, { message: 'Not found.' });
      const content = await readFile(join(root, file[0]));
      res.writeHead(200, { 'Content-Type': file[1] }); res.end(content);
    } catch (error) {
      if (!res.headersSent) json(error.status || 500, { code: error.code || 'server_error', message: error.status ? error.message : 'Server configuration or storage error. Contact the organizer.' });
      else res.end();
      console.error(error.code || error.name);
    }
  });
  server.requestTimeout = 15000;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.log('RacketScience server started.'));
}
