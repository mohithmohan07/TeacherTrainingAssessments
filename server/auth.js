import crypto from 'node:crypto';

/**
 * A single shared password, for when the app is reachable from the internet.
 *
 * It is off unless APP_PASSWORD is set, so running it on your own laptop is
 * unchanged. When it is set, every page, API call and uploaded scan needs a
 * signed cookie, which you get by entering the password once.
 */

const COOKIE_NAME = 'tta_session';
const SESSION_DAYS = 30;
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const password = process.env.APP_PASSWORD ?? '';
export const authEnabled = password.length > 0;

// Signing key: SESSION_SECRET if given, otherwise derived from the password,
// which means changing the password signs everyone out.
const secret = process.env.SESSION_SECRET || `derived:${password}`;

function hmac(value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function safeEqual(a, b) {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

function issueToken() {
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  return `${expiresAt}.${hmac(String(expiresAt))}`;
}

function tokenIsValid(token) {
  const [expiresAt, signature] = String(token ?? '').split('.');
  if (!expiresAt || !signature) return false;
  if (!/^\d+$/.test(expiresAt) || Number(expiresAt) < Date.now()) return false;
  return safeEqual(signature, hmac(expiresAt));
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

// Failed attempts per client address, so the password cannot be guessed at speed.
const attempts = new Map();

function tooManyAttempts(key) {
  const record = attempts.get(key);
  if (!record) return false;
  if (Date.now() - record.first > ATTEMPT_WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function recordFailure(key) {
  const record = attempts.get(key);
  if (!record || Date.now() - record.first > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
  } else {
    record.count += 1;
  }
}

function loginPage(message = '') {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Teacher Training Assessments</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center;
             background: #f4f6f9; color: #16232e; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
      form { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 28px; width: 320px;
             box-shadow: 0 8px 24px rgba(15, 32, 48, .08); }
      h1 { font-size: 17px; margin: 0 0 4px; }
      p { color: #64748b; font-size: 13px; margin: 0 0 18px; }
      label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 5px; }
      input { width: 100%; box-sizing: border-box; font: inherit; padding: 9px 11px;
              border: 1px solid #e2e8f0; border-radius: 8px; }
      button { width: 100%; margin-top: 14px; font: inherit; font-weight: 600; padding: 10px;
               border: none; border-radius: 8px; background: #1f3b57; color: #fff; cursor: pointer; }
      .error { color: #b3261e; font-size: 13px; margin: 12px 0 0; }
    </style>
  </head>
  <body>
    <form method="post" action="/login">
      <h1>Teacher Training Assessments</h1>
      <p>Enter the password to continue.</p>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autofocus autocomplete="current-password" />
      <button type="submit">Sign in</button>
      ${message ? `<p class="error">${message}</p>` : ''}
    </form>
  </body>
</html>`;
}

export function installAuth(app) {
  if (!authEnabled) return;

  app.get('/login', (req, res) => {
    if (tokenIsValid(readCookie(req, COOKIE_NAME))) return res.redirect('/');
    res.type('html').send(loginPage());
  });

  app.post('/login', (req, res) => {
    const key = req.ip ?? 'unknown';
    if (tooManyAttempts(key)) {
      return res.status(429).type('html').send(loginPage('Too many attempts. Try again in a few minutes.'));
    }

    const given = String(req.body?.password ?? '');
    if (!safeEqual(hmac(given), hmac(password))) {
      recordFailure(key);
      return res.status(401).type('html').send(loginPage('That password is not right.'));
    }

    attempts.delete(key);
    res.cookie(COOKIE_NAME, issueToken(), {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure || req.get('x-forwarded-proto') === 'https',
      maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    });
    res.redirect('/');
  });

  app.post('/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME);
    res.redirect('/login');
  });

  // Everything mounted after this needs a valid session.
  app.use((req, res, next) => {
    if (tokenIsValid(readCookie(req, COOKIE_NAME))) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Your session has expired. Reload the page to sign in again.' });
    res.redirect('/login');
  });
}
