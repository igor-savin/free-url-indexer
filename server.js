const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { DatabaseSync } = require('node:sqlite');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

function resolveDataDir(preferredDir) {
  const candidates = [
    preferredDir,
    path.join(os.tmpdir(), 'free-url-indexer'),
    __dirname
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.accessSync(candidate, fs.constants.W_OK);
      return candidate;
    } catch (err) {
      console.warn(`[Storage] Cannot use ${candidate}: ${err.message}`);
    }
  }

  throw new Error('No writable data directory is available.');
}

const DATA_DIR = resolveDataDir(process.env.DATA_DIR || __dirname);
console.log(`[Storage] Using data directory: ${DATA_DIR}`);

const DB_PATH = path.join(DATA_DIR, 'indexer.db');
const KEY_FILE = path.join(DATA_DIR, 'service_account.json');
const AUTH_BASE_URL = (process.env.AUTH_BASE_URL || process.env.BASE_DOMAIN || '').replace(/\/$/, '');
const AUTH_ENABLED = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const INDEXNOW_KEY = process.env.INDEXNOW_KEY ||
  crypto.createHash('sha256').update(`${SESSION_SECRET}:indexnow`).digest('hex').slice(0, 32);
const ALLOWED_GOOGLE_EMAILS = (process.env.ALLOWED_GOOGLE_EMAILS || '')
  .split(',')
  .map(email => email.trim().toLowerCase())
  .filter(Boolean);
const STATUS = {
  QUEUED: 'Queued',
  GOOGLE_ACCEPTED: 'Google Accepted',
  SUBMISSION_FAILED: 'Submission Failed',
  REDIRECT_VERIFIED: 'Redirect Verified',
  TARGET_REACHABLE: 'Target Reachable',
  VERIFICATION_FAILED: 'Verification Failed'
};

if (!process.env.SESSION_SECRET) {
  console.warn('[Auth] SESSION_SECRET is not set. Sessions will reset when the app restarts.');
}

if (!AUTH_ENABLED) {
  console.warn('[Auth] Google login is disabled until GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.');
}
const GOOGLE_INDEX_STATUS = {
  NOT_CHECKED: 'Not Checked',
  FOUND: 'Found',
  NOT_FOUND: 'Not Found',
  CHECK_FAILED: 'Check Failed'
};
const INDEXNOW_STATUS = {
  NOT_SUBMITTED: 'Not Submitted',
  SUBMITTED: 'Submitted',
  FAILED: 'Failed'
};
const SEO_STATUS = {
  NOT_CHECKED: 'Not Checked',
  OK: 'OK',
  ISSUES: 'Issues',
  BLOCKED: 'Blocked',
  ERROR: 'Error'
};

function parseServiceAccountJson(rawJson) {
  const parsedKey = JSON.parse(rawJson);
  if (!parsedKey.client_email || !parsedKey.private_key) {
    throw new Error('Invalid service account JSON: client_email and private_key are required.');
  }
  return parsedKey;
}

function getServiceAccountKey() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return {
      key: parseServiceAccountJson(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
      source: 'environment'
    };
  }

  if (fs.existsSync(KEY_FILE)) {
    return {
      key: parseServiceAccountJson(fs.readFileSync(KEY_FILE, 'utf8')),
      source: 'file'
    };
  }

  return null;
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);
app.use(session({
  name: 'indexer.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

if (AUTH_ENABLED) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: AUTH_BASE_URL ? `${AUTH_BASE_URL}/auth/google/callback` : '/auth/google/callback'
  }, (accessToken, refreshToken, profile, done) => {
    const email = profile.emails && profile.emails[0] && profile.emails[0].value
      ? profile.emails[0].value.toLowerCase()
      : null;

    if (!email) {
      return done(null, false, { message: 'Google account did not provide an email address.' });
    }

    if (ALLOWED_GOOGLE_EMAILS.length > 0 && !ALLOWED_GOOGLE_EMAILS.includes(email)) {
      return done(null, false, { message: `${email} is not allowed to access this dashboard.` });
    }

    return done(null, {
      id: profile.id,
      email,
      name: profile.displayName || email
    });
  }));
}

// Initialize SQLite database using Node's native DatabaseSync
let db;
try {
  db = new DatabaseSync(DB_PATH);
  
  // Create tables if they do not exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS links (
      id TEXT PRIMARY KEY,
      original_url TEXT UNIQUE,
      status TEXT DEFAULT 'Queued',
      created_at TEXT,
      submitted_at TEXT,
      indexed_at TEXT,
      last_error TEXT,
      google_index_status TEXT DEFAULT 'Not Checked',
      google_index_checked_at TEXT,
      bing_indexnow_status TEXT DEFAULT 'Not Submitted',
      yahoo_indexnow_status TEXT DEFAULT 'Not Submitted',
      indexnow_submitted_at TEXT,
      indexnow_error TEXT,
      seo_status TEXT DEFAULT 'Not Checked',
      seo_checked_at TEXT,
      seo_report TEXT
    )
  `);

  try {
    db.exec('ALTER TABLE links ADD COLUMN last_error TEXT');
  } catch (err) {
    if (!String(err.message).includes('duplicate column name')) {
      throw err;
    }
  }

  try {
    db.exec("ALTER TABLE links ADD COLUMN google_index_status TEXT DEFAULT 'Not Checked'");
  } catch (err) {
    if (!String(err.message).includes('duplicate column name')) {
      throw err;
    }
  }

  try {
    db.exec('ALTER TABLE links ADD COLUMN google_index_checked_at TEXT');
  } catch (err) {
    if (!String(err.message).includes('duplicate column name')) {
      throw err;
    }
  }

  try {
    db.exec("ALTER TABLE links ADD COLUMN bing_indexnow_status TEXT DEFAULT 'Not Submitted'");
  } catch (err) {
    if (!String(err.message).includes('duplicate column name')) {
      throw err;
    }
  }

  try {
    db.exec("ALTER TABLE links ADD COLUMN yahoo_indexnow_status TEXT DEFAULT 'Not Submitted'");
  } catch (err) {
    if (!String(err.message).includes('duplicate column name')) {
      throw err;
    }
  }

  try {
    db.exec('ALTER TABLE links ADD COLUMN indexnow_submitted_at TEXT');
  } catch (err) {
    if (!String(err.message).includes('duplicate column name')) {
      throw err;
    }
  }

  try {
    db.exec('ALTER TABLE links ADD COLUMN indexnow_error TEXT');
  } catch (err) {
    if (!String(err.message).includes('duplicate column name')) {
      throw err;
    }
  }

  try {
    db.exec("ALTER TABLE links ADD COLUMN seo_status TEXT DEFAULT 'Not Checked'");
  } catch (err) {
    if (!String(err.message).includes('duplicate column name')) {
      throw err;
    }
  }

  try {
    db.exec('ALTER TABLE links ADD COLUMN seo_checked_at TEXT');
  } catch (err) {
    if (!String(err.message).includes('duplicate column name')) {
      throw err;
    }
  }

  try {
    db.exec('ALTER TABLE links ADD COLUMN seo_report TEXT');
  } catch (err) {
    if (!String(err.message).includes('duplicate column name')) {
      throw err;
    }
  }

  db.exec(`
    UPDATE links
    SET status = CASE status
      WHEN 'Pending' THEN 'Queued'
      WHEN 'Submitted' THEN 'Google Accepted'
      WHEN 'Failed' THEN 'Submission Failed'
      WHEN 'Crawled' THEN 'Redirect Verified'
      WHEN 'Indexed' THEN 'Target Reachable'
      ELSE status
    END
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  console.log('[Database] SQLite initialized successfully.');
} catch (err) {
  console.error('[Database] Failed to initialize SQLite database:', err);
  process.exit(1);
}

// Helper database functions
function getSetting(key) {
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const result = stmt.get(key);
  return result ? result.value : null;
}

function setSetting(key, value) {
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  stmt.run(key, value);
}

function cleanBaseDomain(baseDomain) {
  return baseDomain && baseDomain.endsWith('/') ? baseDomain.slice(0, -1) : baseDomain;
}

function isLocalBaseDomain(baseDomain) {
  try {
    const hostname = new URL(baseDomain).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch (err) {
    return false;
  }
}

function getRequestBaseDomain(req) {
  if (!req || !req.get('host')) return null;

  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
  return cleanBaseDomain(`${protocol}://${req.get('host')}`);
}

function getBaseDomain(req) {
  const envBaseDomain = cleanBaseDomain(process.env.BASE_DOMAIN);
  if (envBaseDomain) return envBaseDomain;

  const savedBaseDomain = getSetting('base_domain');
  if (savedBaseDomain && !isLocalBaseDomain(savedBaseDomain)) {
    return savedBaseDomain;
  }

  const requestBaseDomain = getRequestBaseDomain(req);
  if (requestBaseDomain && !isLocalBaseDomain(requestBaseDomain)) {
    return requestBaseDomain;
  }

  return savedBaseDomain || `http://localhost:${PORT}`;
}

async function fetchWithFallback(url) {
  const requestOptions = {
    headers: {
      'User-Agent': 'CalHearingIndexer/1.0 (+https://link.calhearing.com)'
    }
  };

  try {
    return await fetch(url, { ...requestOptions, method: 'HEAD' });
  } catch (headError) {
    return fetch(url, { ...requestOptions, method: 'GET' });
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function extractMetaContent(html, name) {
  const pattern = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["'][^>]*>|<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["'][^>]*>`, 'i');
  const match = html.match(pattern);
  return match ? (match[1] || match[2] || '').trim() : null;
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, ' ').trim() : null;
}

function extractCanonical(html) {
  const match = html.match(/<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>|<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*canonical[^"']*["'][^>]*>/i);
  return match ? (match[1] || match[2] || '').trim() : null;
}

async function inspectTargetSeo(url) {
  const startedUrl = url;
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (compatible; CalHearingIndexer/1.0; +https://link.calhearing.com)'
    }
  });

  const finalUrl = response.url || startedUrl;
  const contentType = response.headers.get('content-type') || '';
  const xRobotsTag = response.headers.get('x-robots-tag') || '';
  const html = contentType.includes('text/html') ? await response.text() : '';
  const robotsMeta = html ? extractMetaContent(html, 'robots') : null;
  const googlebotMeta = html ? extractMetaContent(html, 'googlebot') : null;
  const title = html ? extractTitle(html) : null;
  const canonical = html ? extractCanonical(html) : null;
  const issues = [];

  if (response.status >= 400) {
    issues.push(`HTTP ${response.status}`);
  }

  if (!contentType.includes('text/html')) {
    issues.push(`Non-HTML content type: ${contentType || 'unknown'}`);
  }

  const robotsText = `${xRobotsTag} ${robotsMeta || ''} ${googlebotMeta || ''}`.toLowerCase();
  if (robotsText.includes('noindex')) {
    issues.push('noindex detected');
  }

  if (robotsText.includes('none')) {
    issues.push('robots none detected');
  }

  if (canonical) {
    try {
      const canonicalUrl = new URL(canonical, finalUrl).toString();
      const normalizedFinal = finalUrl.replace(/\/$/, '');
      const normalizedCanonical = canonicalUrl.replace(/\/$/, '');
      if (normalizedCanonical !== normalizedFinal) {
        issues.push(`canonical points elsewhere: ${canonicalUrl}`);
      }
    } catch (err) {
      issues.push(`invalid canonical: ${canonical}`);
    }
  }

  if (!title && html) {
    issues.push('missing title');
  }

  if (html && html.length < 800) {
    issues.push('very thin HTML response');
  }

  let status = SEO_STATUS.OK;
  if (issues.some(issue => issue.includes('noindex') || issue.includes('robots none') || issue.startsWith('HTTP 4') || issue.startsWith('HTTP 5'))) {
    status = SEO_STATUS.BLOCKED;
  } else if (issues.length > 0) {
    status = SEO_STATUS.ISSUES;
  }

  return {
    status,
    checkedAt: new Date().toISOString(),
    httpStatus: response.status,
    finalUrl,
    contentType,
    title,
    canonical,
    robotsMeta,
    googlebotMeta,
    xRobotsTag,
    issues
  };
}

function buildGoogleIndexQuery(url) {
  try {
    const parsedUrl = new URL(url);
    return `site:${parsedUrl.hostname}${parsedUrl.pathname}`;
  } catch (err) {
    return `site:${url}`;
  }
}

function normalizeUrlForSearch(url) {
  try {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname.replace(/\/$/, '');
    return `${parsedUrl.hostname}${pathname}`.toLowerCase();
  } catch (err) {
    return url.toLowerCase();
  }
}

async function checkGoogleIndexForUrl(url) {
  const query = buildGoogleIndexQuery(url);
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&hl=en`;
  const response = await fetch(searchUrl, {
    headers: {
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
    }
  });

  if (!response.ok) {
    throw new Error(`Google search returned HTTP ${response.status}.`);
  }

  const html = await response.text();
  const normalizedTarget = normalizeUrlForSearch(url);
  const normalizedHtml = html
    .replace(/&amp;/g, '&')
    .replace(/\\u003d/g, '=')
    .replace(/\\u0026/g, '&')
    .toLowerCase();

  if (
    normalizedHtml.includes('/sorry/') ||
    normalizedHtml.includes('unusual traffic') ||
    normalizedHtml.includes('our systems have detected')
  ) {
    throw new Error('Google blocked the automated check. Use the Search link to verify manually.');
  }

  const found = normalizedHtml.includes(normalizedTarget);
  const noResults = normalizedHtml.includes('did not match any documents') ||
    normalizedHtml.includes('make sure that all words are spelled correctly');

  return {
    found,
    query,
    searchUrl,
    signal: found ? 'target-url-found-in-results-html' : (noResults ? 'google-no-results-message' : 'target-url-not-found-in-results-html')
  };
}

async function submitUrlsToIndexNow(urls, req) {
  const baseDomain = getBaseDomain(req);
  const host = new URL(baseDomain).hostname;
  const keyLocation = `${baseDomain}/${INDEXNOW_KEY}.txt`;
  const response = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
      host,
      key: INDEXNOW_KEY,
      keyLocation,
      urlList: urls
    })
  });

  if (![200, 202].includes(response.status)) {
    const body = await response.text().catch(() => '');
    throw new Error(`IndexNow returned HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
  }

  return {
    status: response.status,
    keyLocation
  };
}

function getLinksForGoogleSubmission(ids = []) {
  if (ids && Array.isArray(ids) && ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const stmt = db.prepare(`SELECT * FROM links WHERE id IN (${placeholders})`);
    return stmt.all(...ids);
  }

  const stmt = db.prepare(`
    SELECT * FROM links
    WHERE status IN (?, ?, ?, 'Pending', 'Failed')
  `);
  return stmt.all(STATUS.QUEUED, STATUS.SUBMISSION_FAILED, STATUS.VERIFICATION_FAILED);
}

function getLinksForIndexNowSubmission(ids = []) {
  if (ids && Array.isArray(ids) && ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const stmt = db.prepare(`SELECT * FROM links WHERE id IN (${placeholders})`);
    return stmt.all(...ids);
  }

  const stmt = db.prepare(`
    SELECT * FROM links
    WHERE bing_indexnow_status IN (?, ?)
       OR yahoo_indexnow_status IN (?, ?)
       OR bing_indexnow_status IS NULL
       OR yahoo_indexnow_status IS NULL
  `);
  return stmt.all(
    INDEXNOW_STATUS.NOT_SUBMITTED,
    INDEXNOW_STATUS.FAILED,
    INDEXNOW_STATUS.NOT_SUBMITTED,
    INDEXNOW_STATUS.FAILED
  );
}

async function submitLinksToGoogle(linksToProcess, req) {
  const serviceAccount = getServiceAccountKey();

  if (!serviceAccount) {
    throw new Error('Google Service Account JSON key is missing. Add GOOGLE_SERVICE_ACCOUNT_JSON in Render or upload it in settings first.');
  }

  if (linksToProcess.length === 0) {
    return { processedCount: 0, results: [] };
  }

  const baseDomain = getBaseDomain(req);
  let jwtClient;
  const credentials = serviceAccount.key;
  jwtClient = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ['https://www.googleapis.com/auth/indexing'],
    null
  );
  await jwtClient.authorize();

  const results = [];
  const updateStmt = db.prepare('UPDATE links SET status = ?, submitted_at = ?, last_error = ? WHERE id = ?');
  const googleIndexing = google.indexing({ version: 'v3', auth: jwtClient });

  for (const link of linksToProcess) {
    const redirectUrl = `${baseDomain}/go/${link.id}`;
    const now = new Date().toISOString();

    try {
      const response = await googleIndexing.urlNotifications.publish({
        requestBody: {
          url: redirectUrl,
          type: 'URL_UPDATED'
        }
      });

      if (response.status === 200) {
        updateStmt.run(STATUS.GOOGLE_ACCEPTED, now, null, link.id);
        results.push({ id: link.id, url: redirectUrl, success: true, status: STATUS.GOOGLE_ACCEPTED });
      } else {
        const errorMessage = `Google API returned status ${response.status}`;
        updateStmt.run(STATUS.SUBMISSION_FAILED, now, errorMessage, link.id);
        results.push({ id: link.id, url: redirectUrl, success: false, error: errorMessage, status: STATUS.SUBMISSION_FAILED });
      }
    } catch (error) {
      const errMsg = error.response && error.response.data && error.response.data.error
        ? error.response.data.error.message
        : error.message;
      updateStmt.run(STATUS.SUBMISSION_FAILED, now, errMsg, link.id);
      results.push({ id: link.id, url: redirectUrl, success: false, error: errMsg, status: STATUS.SUBMISSION_FAILED });
    }

    await new Promise(resolve => setTimeout(resolve, 300));
  }

  return { processedCount: linksToProcess.length, results };
}

async function submitLinksToIndexNow(linksToProcess, req) {
  if (linksToProcess.length === 0) {
    return { processedCount: 0, results: [] };
  }

  const baseDomain = getBaseDomain(req);
  const redirectUrls = linksToProcess.map(link => `${baseDomain}/go/${link.id}`);
  const now = new Date().toISOString();
  const updateStmt = db.prepare(`
    UPDATE links
    SET bing_indexnow_status = ?,
        yahoo_indexnow_status = ?,
        indexnow_submitted_at = ?,
        indexnow_error = ?
    WHERE id = ?
  `);

  try {
    const indexNowResult = await submitUrlsToIndexNow(redirectUrls, req);
    const results = linksToProcess.map((link, index) => {
      updateStmt.run(
        INDEXNOW_STATUS.SUBMITTED,
        INDEXNOW_STATUS.SUBMITTED,
        now,
        null,
        link.id
      );

      return {
        id: link.id,
        url: redirectUrls[index],
        success: true,
        bingStatus: INDEXNOW_STATUS.SUBMITTED,
        yahooStatus: INDEXNOW_STATUS.SUBMITTED
      };
    });

    return {
      processedCount: linksToProcess.length,
      indexNowStatus: indexNowResult.status,
      keyLocation: indexNowResult.keyLocation,
      results
    };
  } catch (err) {
    const results = linksToProcess.map((link, index) => {
      updateStmt.run(
        INDEXNOW_STATUS.FAILED,
        INDEXNOW_STATUS.FAILED,
        now,
        err.message,
        link.id
      );

      return {
        id: link.id,
        url: redirectUrls[index],
        success: false,
        error: err.message,
        bingStatus: INDEXNOW_STATUS.FAILED,
        yahooStatus: INDEXNOW_STATUS.FAILED
      };
    });

    return {
      processedCount: linksToProcess.length,
      error: err.message,
      results
    };
  }
}

function isLoggedIn(req) {
  return !AUTH_ENABLED || (req.isAuthenticated && req.isAuthenticated());
}

function requireAuth(req, res, next) {
  if (isLoggedIn(req)) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Login required.' });
  }

  return res.redirect('/login');
}

function renderLoginPage(errorMessage = '') {
  const escapedError = errorMessage
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in | URL Indexer</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #070913; color: #f8fafc; }
    .panel { width: min(420px, calc(100vw - 32px)); border: 1px solid rgba(255,255,255,.1); border-radius: 14px; padding: 30px; background: rgba(13,17,30,.72); box-shadow: 0 24px 80px rgba(0,0,0,.45); }
    h1 { margin: 0 0 8px; font-size: 1.5rem; }
    p { margin: 0 0 22px; color: #94a3b8; line-height: 1.5; }
    a.button { display: inline-flex; align-items: center; justify-content: center; width: 100%; min-height: 44px; border-radius: 8px; background: #fff; color: #111827; font-weight: 700; text-decoration: none; }
    .error { margin-top: 16px; color: #fca5a5; font-size: .9rem; }
    .disabled { color: #fca5a5; font-weight: 600; }
  </style>
</head>
<body>
  <main class="panel">
    <h1>Sign in to URL Indexer</h1>
    <p>This dashboard is private. Use your allowed Google account to continue.</p>
    ${AUTH_ENABLED
      ? '<a class="button" href="/auth/google">Continue with Google</a>'
      : '<p class="disabled">Google login is not configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Render.</p>'}
    ${escapedError ? `<div class="error">${escapedError}</div>` : ''}
  </main>
</body>
</html>`;
}

// ----------------------------------------------------
// 1. REDIRECT GATEWAY ROUTE
// ----------------------------------------------------
app.get('/go/:id', (req, res) => {
  try {
    const id = req.params.id;

    // Try DB first
    const stmt = db.prepare('SELECT original_url FROM links WHERE id = ?');
    const link = stmt.get(id);

    if (link) {
      console.log(`[Redirect DB] Short ID "${id}" -> ${link.original_url}`);
      return res.redirect(301, link.original_url);
    }

    // Fallback: Try decoding as Base64URL (stateless redirect)
    try {
      const base64 = id.replace(/-/g, '+').replace(/_/g, '/');
      const decodedUrl = Buffer.from(base64, 'base64').toString('utf8');
      new URL(decodedUrl); // Check if valid URL
      console.log(`[Redirect Stateless] Decoded "${id}" -> ${decodedUrl}`);
      return res.redirect(301, decodedUrl);
    } catch (e) {
      // Not a valid Base64URL
    }
  } catch (err) {
    console.error('[Error] Redirect lookup failed:', err);
  }
  
  res.status(404).send('Shortlink not found or expired.');
});

// Google Search Console Verification File Auto-Responder
app.get('/google:hash.html', (req, res) => {
  res.send(`google-site-verification: google${req.params.hash}.html`);
});

app.get(`/${INDEXNOW_KEY}.txt`, (req, res) => {
  res.type('text/plain').send(INDEXNOW_KEY);
});

app.get('/hub', (req, res) => {
  const baseDomain = getBaseDomain(req);
  const links = db.prepare('SELECT * FROM links ORDER BY created_at DESC').all();
  const rows = links.map(link => {
    const redirectUrl = `${baseDomain}/go/${link.id}`;
    const title = link.seo_report ? (() => {
      try {
        return JSON.parse(link.seo_report).title || link.original_url;
      } catch (err) {
        return link.original_url;
      }
    })() : link.original_url;

    return `<li>
      <a href="${escapeHtml(link.original_url)}">${escapeHtml(title)}</a>
      <div><small>Target: ${escapeHtml(link.original_url)}</small></div>
      <div><small>Gateway: <a href="${escapeHtml(redirectUrl)}">${escapeHtml(redirectUrl)}</a></small></div>
    </li>`;
  }).join('\n');

  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CalHearing Index Hub</title>
  <meta name="robots" content="index,follow">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 920px; margin: 40px auto; padding: 0 20px; line-height: 1.5; color: #172033; }
    h1 { margin-bottom: 8px; }
    p { color: #526071; }
    li { margin: 18px 0; padding-bottom: 18px; border-bottom: 1px solid #e5e7eb; }
    a { color: #0f5db8; }
    small { color: #667085; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <h1>CalHearing Index Hub</h1>
  <p>Public discovery hub for recently submitted URLs.</p>
  <ul>
    ${rows || '<li>No submitted URLs yet.</li>'}
  </ul>
</body>
</html>`);
});

app.get('/sitemap.xml', (req, res) => {
  const baseDomain = getBaseDomain(req);
  const links = db.prepare('SELECT id, created_at FROM links ORDER BY created_at DESC').all();
  const urls = [
    { loc: `${baseDomain}/hub`, lastmod: new Date().toISOString() },
    ...links.map(link => ({
      loc: `${baseDomain}/go/${link.id}`,
      lastmod: link.created_at || new Date().toISOString()
    }))
  ];

  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(url => `  <url>
    <loc>${escapeXml(url.loc)}</loc>
    <lastmod>${escapeXml(url.lastmod)}</lastmod>
  </url>`).join('\n')}
</urlset>`);
});

app.get('/feed.xml', (req, res) => {
  const baseDomain = getBaseDomain(req);
  const links = db.prepare('SELECT * FROM links ORDER BY created_at DESC LIMIT 50').all();

  res.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>CalHearing Index Hub</title>
    <link>${escapeXml(`${baseDomain}/hub`)}</link>
    <description>Recently submitted URLs for discovery.</description>
${links.map(link => {
  const redirectUrl = `${baseDomain}/go/${link.id}`;
  return `    <item>
      <title>${escapeXml(link.original_url)}</title>
      <link>${escapeXml(redirectUrl)}</link>
      <guid>${escapeXml(redirectUrl)}</guid>
      <description>${escapeXml(link.original_url)}</description>
      <pubDate>${new Date(link.created_at || Date.now()).toUTCString()}</pubDate>
    </item>`;
}).join('\n')}
  </channel>
</rss>`);
});

app.get('/login', (req, res) => {
  if (isLoggedIn(req)) return res.redirect('/');
  return res.send(renderLoginPage(req.query.error ? String(req.query.error) : ''));
});

app.get('/auth/google', (req, res, next) => {
  if (!AUTH_ENABLED) return res.redirect('/login?error=Google%20login%20is%20not%20configured.');
  return passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account'
  })(req, res, next);
});

app.get('/auth/google/callback', (req, res, next) => {
  if (!AUTH_ENABLED) return res.redirect('/login?error=Google%20login%20is%20not%20configured.');

  return passport.authenticate('google', (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      const message = info && info.message ? info.message : 'Google login was denied.';
      return res.redirect(`/login?error=${encodeURIComponent(message)}`);
    }

    return req.logIn(user, loginErr => {
      if (loginErr) return next(loginErr);
      return res.redirect('/');
    });
  })(req, res, next);
});

app.get('/logout', (req, res, next) => {
  if (!req.logout) return res.redirect('/login');

  req.logout(err => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie('indexer.sid');
      res.redirect('/login');
    });
  });
});

app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------
// 2. API ENDPOINTS
// ----------------------------------------------------

app.get('/api/me', (req, res) => {
  res.json({
    authenticated: isLoggedIn(req),
    user: req.user || null,
    authEnabled: AUTH_ENABLED
  });
});

// GET /api/links - Get all links
app.get('/api/links', (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM links ORDER BY created_at DESC');
    const links = stmt.all();
    res.json(links);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve links: ' + err.message });
  }
});

// POST /api/submit - Bulk submit URLs
app.post('/api/submit', (req, res) => {
  const { urls } = req.body;
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'An array of URLs is required' });
  }

  const results = [];
  const insertStmt = db.prepare(`
    INSERT INTO links (id, original_url, status, created_at)
    VALUES (?, ?, ?, ?)
  `);

  const selectStmt = db.prepare('SELECT id, original_url, status, created_at FROM links WHERE original_url = ?');

  let baseDomain = getBaseDomain(req);

  for (let url of urls) {
    url = url.trim();
    if (!url) continue;

    try {
      new URL(url); // Validate URL format
    } catch (e) {
      results.push({ url, error: 'Invalid URL format', success: false });
      continue;
    }

    // Check if URL already exists
    const existing = selectStmt.get(url);
    if (existing) {
      results.push({
        url,
        shortId: existing.id,
        redirectUrl: `${baseDomain}/go/${existing.id}`,
        status: existing.status,
        success: true,
        alreadyExists: true
      });
      continue;
    }

    // Generate unique short ID (Base64URL encoded destination URL to support stateless fallback)
    const shortId = Buffer.from(url).toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    const now = new Date().toISOString();

    try {
      insertStmt.run(shortId, url, STATUS.QUEUED, now);
      results.push({
        url,
        shortId,
        redirectUrl: `${baseDomain}/go/${shortId}`,
        status: STATUS.QUEUED,
        success: true
      });
    } catch (err) {
      results.push({ url, error: err.message, success: false });
    }
  }

  res.json({ results });
});

// GET /api/settings - Retrieve app configurations
app.get('/api/settings', (req, res) => {
  const baseDomain = getBaseDomain(req);
  const serviceAccount = getServiceAccountKey();
  const hasGcpKey = Boolean(serviceAccount);
  let gcpEmail = null;
  let gcpKeySource = null;

  if (serviceAccount) {
    gcpEmail = serviceAccount.key.client_email;
    gcpKeySource = serviceAccount.source;
  }

  res.json({
    baseDomain,
    hasGcpKey,
    gcpEmail,
    gcpKeySource
  });
});

// POST /api/settings - Save settings and GCP key
app.post('/api/settings', (req, res) => {
  const { baseDomain, gcpKeyJson } = req.body;

  try {
    if (baseDomain) {
      // Clean trailing slash
      setSetting('base_domain', cleanBaseDomain(baseDomain));
    }

    if (gcpKeyJson) {
      // Validate JSON format
      const parsedKey = parseServiceAccountJson(gcpKeyJson);
      fs.writeFileSync(KEY_FILE, JSON.stringify(parsedKey, null, 2));
    }

    res.json({ success: true, message: 'Settings saved successfully.' });
  } catch (err) {
    res.status(400).json({ error: 'Failed to save settings: ' + err.message });
  }
});

// DELETE /api/settings/gcp-key - Remove uploaded key
app.delete('/api/settings/gcp-key', (req, res) => {
  try {
    if (fs.existsSync(KEY_FILE)) {
      fs.unlinkSync(KEY_FILE);
    }
    res.json({ success: true, message: 'GCP Service Account key removed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete key: ' + err.message });
  }
});

// POST /api/trigger - Trigger indexing requests to Google Indexing API
app.post('/api/trigger', async (req, res) => {
  const { ids } = req.body;

  try {
    const linksToProcess = getLinksForGoogleSubmission(ids);
    if (linksToProcess.length === 0) {
      return res.json({ success: true, message: 'No pending links to index.', processedCount: 0, results: [] });
    }

    const result = await submitLinksToGoogle(linksToProcess, req);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/trigger-indexnow - Submit redirect URLs to IndexNow for Bing/Yahoo discovery.
app.post('/api/trigger-indexnow', async (req, res) => {
  const { ids } = req.body;

  try {
    const linksToProcess = getLinksForIndexNowSubmission(ids);
    if (linksToProcess.length === 0) {
      return res.json({ success: true, message: 'No links need IndexNow submission.', processedCount: 0, results: [] });
    }

    const result = await submitLinksToIndexNow(linksToProcess, req);
    const failed = result.results.some(item => !item.success);
    return res.status(failed ? 502 : 200).json({ success: !failed, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/trigger-all - Submit selected URLs to Google and IndexNow together.
app.post('/api/trigger-all', async (req, res) => {
  const { ids } = req.body;

  const result = {
    success: true,
    google: { processedCount: 0, results: [] },
    indexNow: { processedCount: 0, results: [] }
  };

  try {
    const googleLinks = getLinksForGoogleSubmission(ids);
    result.google = await submitLinksToGoogle(googleLinks, req);
  } catch (err) {
    result.success = false;
    result.google = {
      processedCount: 0,
      error: err.message,
      results: []
    };
  }

  try {
    const indexNowLinks = getLinksForIndexNowSubmission(ids);
    result.indexNow = await submitLinksToIndexNow(indexNowLinks, req);
    if (result.indexNow.results.some(item => !item.success)) {
      result.success = false;
    }
  } catch (err) {
    result.success = false;
    result.indexNow = {
      processedCount: 0,
      error: err.message,
      results: []
    };
  }

  res.status(result.success ? 200 : 207).json(result);
});

// POST /api/check-status - Verify redirect and target reachability.
app.post('/api/check-status', async (req, res) => {
  const { ids } = req.body;
  
  try {
    let linksToCheck = [];
    if (ids && Array.isArray(ids) && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const stmt = db.prepare(`SELECT * FROM links WHERE id IN (${placeholders})`);
      linksToCheck = stmt.all(...ids);
    } else {
      const stmt = db.prepare('SELECT * FROM links');
      linksToCheck = stmt.all();
    }

    if (linksToCheck.length === 0) {
      return res.json({ success: true, message: 'No links need a status check.' });
    }

    const updateStmt = db.prepare('UPDATE links SET status = ?, indexed_at = ?, last_error = ? WHERE id = ?');
    const now = new Date().toISOString();
    const results = [];
    const baseDomain = getBaseDomain(req);

    for (const link of linksToCheck) {
      const redirectUrl = `${baseDomain}/go/${link.id}`;
      let nextStatus = STATUS.REDIRECT_VERIFIED;
      let lastError = null;
      let targetStatus = null;

      try {
        const redirectResponse = await fetch(redirectUrl, {
          method: 'HEAD',
          redirect: 'manual'
        });
        const location = redirectResponse.headers.get('location');
        const redirectWorks = [301, 302, 307, 308].includes(redirectResponse.status) && location;

        if (!redirectWorks) {
          throw new Error(`Redirect check failed: expected 301/302, got HTTP ${redirectResponse.status}.`);
        }

        const targetResponse = await fetchWithFallback(link.original_url);
        targetStatus = targetResponse.status;

        if (targetStatus >= 200 && targetStatus < 500) {
          nextStatus = STATUS.TARGET_REACHABLE;
        } else {
          nextStatus = STATUS.REDIRECT_VERIFIED;
          lastError = `Redirect works, but target returned HTTP ${targetStatus}.`;
        }
      } catch (err) {
        nextStatus = STATUS.VERIFICATION_FAILED;
        lastError = err.message;
      }
      
      updateStmt.run(nextStatus, now, lastError, link.id);
      results.push({
        id: link.id,
        original_url: link.original_url,
        redirect_url: redirectUrl,
        target_status: targetStatus,
        status: nextStatus,
        error: lastError
      });
    }

    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update link status: ' + err.message });
  }
});

// POST /api/links/index-status - Manually track whether Google currently shows the target URL.
app.post('/api/links/index-status', (req, res) => {
  const { id, googleIndexStatus } = req.body;
  const allowedStatuses = new Set([
    GOOGLE_INDEX_STATUS.NOT_CHECKED,
    GOOGLE_INDEX_STATUS.FOUND,
    GOOGLE_INDEX_STATUS.NOT_FOUND,
    GOOGLE_INDEX_STATUS.CHECK_FAILED
  ]);

  if (!id || !allowedStatuses.has(googleIndexStatus)) {
    return res.status(400).json({ error: 'A valid id and googleIndexStatus are required.' });
  }

  try {
    const checkedAt = googleIndexStatus === GOOGLE_INDEX_STATUS.NOT_CHECKED ? null : new Date().toISOString();
    const stmt = db.prepare(`
      UPDATE links
      SET google_index_status = ?, google_index_checked_at = ?
      WHERE id = ?
    `);
    const result = stmt.run(googleIndexStatus, checkedAt, id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Link not found.' });
    }

    res.json({
      success: true,
      id,
      googleIndexStatus,
      googleIndexCheckedAt: checkedAt
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update Google index status: ' + err.message });
  }
});

// POST /api/links/check-google-index - Best-effort automatic Google result check.
app.post('/api/links/check-google-index', async (req, res) => {
  const { id } = req.body;

  if (!id) {
    return res.status(400).json({ error: 'A valid id is required.' });
  }

  try {
    const selectStmt = db.prepare('SELECT * FROM links WHERE id = ?');
    const link = selectStmt.get(id);

    if (!link) {
      return res.status(404).json({ error: 'Link not found.' });
    }

    const result = await checkGoogleIndexForUrl(link.original_url);
    const googleIndexStatus = result.found
      ? GOOGLE_INDEX_STATUS.FOUND
      : GOOGLE_INDEX_STATUS.NOT_FOUND;
    const checkedAt = new Date().toISOString();
    const updateStmt = db.prepare(`
      UPDATE links
      SET google_index_status = ?, google_index_checked_at = ?
      WHERE id = ?
    `);
    updateStmt.run(googleIndexStatus, checkedAt, id);

    res.json({
      success: true,
      id,
      googleIndexStatus,
      googleIndexCheckedAt: checkedAt,
      query: result.query,
      searchUrl: result.searchUrl,
      signal: result.signal
    });
  } catch (err) {
    const checkedAt = new Date().toISOString();
    const updateStmt = db.prepare(`
      UPDATE links
      SET google_index_status = ?, google_index_checked_at = ?
      WHERE id = ?
    `);
    updateStmt.run(GOOGLE_INDEX_STATUS.CHECK_FAILED, checkedAt, id);

    res.status(502).json({
      error: err.message,
      googleIndexStatus: GOOGLE_INDEX_STATUS.CHECK_FAILED,
      googleIndexCheckedAt: checkedAt
    });
  }
});

// POST /api/links/check-search-indexes - Check available search index outcomes together.
app.post('/api/links/check-search-indexes', async (req, res) => {
  const { id } = req.body;

  if (!id) {
    return res.status(400).json({ error: 'A valid id is required.' });
  }

  try {
    const selectStmt = db.prepare('SELECT * FROM links WHERE id = ?');
    const link = selectStmt.get(id);

    if (!link) {
      return res.status(404).json({ error: 'Link not found.' });
    }

    let googleResult;
    try {
      const result = await checkGoogleIndexForUrl(link.original_url);
      const googleIndexStatus = result.found
        ? GOOGLE_INDEX_STATUS.FOUND
        : GOOGLE_INDEX_STATUS.NOT_FOUND;
      const checkedAt = new Date().toISOString();
      const updateStmt = db.prepare(`
        UPDATE links
        SET google_index_status = ?, google_index_checked_at = ?
        WHERE id = ?
      `);
      updateStmt.run(googleIndexStatus, checkedAt, id);
      googleResult = {
        success: true,
        status: googleIndexStatus,
        checkedAt,
        query: result.query,
        searchUrl: result.searchUrl,
        signal: result.signal
      };
    } catch (err) {
      const checkedAt = new Date().toISOString();
      const updateStmt = db.prepare(`
        UPDATE links
        SET google_index_status = ?, google_index_checked_at = ?
        WHERE id = ?
      `);
      updateStmt.run(GOOGLE_INDEX_STATUS.CHECK_FAILED, checkedAt, id);
      googleResult = {
        success: false,
        status: GOOGLE_INDEX_STATUS.CHECK_FAILED,
        checkedAt,
        error: err.message
      };
    }

    const refreshedLink = selectStmt.get(id);
    res.json({
      success: googleResult.success,
      id,
      google: googleResult,
      bing: {
        status: refreshedLink.bing_indexnow_status || INDEXNOW_STATUS.NOT_SUBMITTED,
        submittedAt: refreshedLink.indexnow_submitted_at || null,
        note: 'Bing exact index checks are not available through a free official API.'
      },
      yahoo: {
        status: refreshedLink.yahoo_indexnow_status || INDEXNOW_STATUS.NOT_SUBMITTED,
        submittedAt: refreshedLink.indexnow_submitted_at || null,
        note: 'Yahoo is tracked through IndexNow sharing; exact index checks are not available through a free official API.'
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check search indexes: ' + err.message });
  }
});

// POST /api/links/seo-check - Inspect the target page for common crawl/index blockers.
app.post('/api/links/seo-check', async (req, res) => {
  const { id } = req.body;

  if (!id) {
    return res.status(400).json({ error: 'A valid id is required.' });
  }

  try {
    const selectStmt = db.prepare('SELECT * FROM links WHERE id = ?');
    const link = selectStmt.get(id);

    if (!link) {
      return res.status(404).json({ error: 'Link not found.' });
    }

    const report = await inspectTargetSeo(link.original_url);
    const updateStmt = db.prepare(`
      UPDATE links
      SET seo_status = ?, seo_checked_at = ?, seo_report = ?
      WHERE id = ?
    `);
    updateStmt.run(report.status, report.checkedAt, JSON.stringify(report), id);

    res.json({
      success: true,
      id,
      seoStatus: report.status,
      seoCheckedAt: report.checkedAt,
      report
    });
  } catch (err) {
    const checkedAt = new Date().toISOString();
    const report = {
      status: SEO_STATUS.ERROR,
      checkedAt,
      issues: [err.message]
    };
    const updateStmt = db.prepare(`
      UPDATE links
      SET seo_status = ?, seo_checked_at = ?, seo_report = ?
      WHERE id = ?
    `);
    updateStmt.run(SEO_STATUS.ERROR, checkedAt, JSON.stringify(report), id);

    res.status(502).json({
      error: err.message,
      seoStatus: SEO_STATUS.ERROR,
      seoCheckedAt: checkedAt,
      report
    });
  }
});

// DELETE /api/links - Bulk delete links
app.post('/api/links/delete', (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Array of IDs is required' });
  }

  try {
    const placeholders = ids.map(() => '?').join(',');
    const stmt = db.prepare(`DELETE FROM links WHERE id IN (${placeholders})`);
    stmt.run(...ids);
    res.json({ success: true, message: `Deleted ${ids.length} links.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete links: ' + err.message });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Multi-Engine URL Indexer is running on port ${PORT}`);
  console.log(`🌐 Base URL: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
