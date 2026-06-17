const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
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
const STATUS = {
  QUEUED: 'Queued',
  GOOGLE_ACCEPTED: 'Google Accepted',
  SUBMISSION_FAILED: 'Submission Failed',
  REDIRECT_VERIFIED: 'Redirect Verified',
  TARGET_REACHABLE: 'Target Reachable',
  VERIFICATION_FAILED: 'Verification Failed'
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
app.use(express.static(path.join(__dirname, 'public')));

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
      google_index_checked_at TEXT
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

// ----------------------------------------------------
// 2. API ENDPOINTS
// ----------------------------------------------------

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
  const serviceAccount = getServiceAccountKey();
  
  if (!serviceAccount) {
    return res.status(400).json({
      error: 'Google Service Account JSON key is missing. Add GOOGLE_SERVICE_ACCOUNT_JSON in Render or upload it in settings first.'
    });
  }

  // Fetch URLs to index
  let linksToProcess = [];
  try {
    if (ids && Array.isArray(ids) && ids.length > 0) {
      // Submit specific IDs
      const placeholders = ids.map(() => '?').join(',');
      const stmt = db.prepare(`SELECT * FROM links WHERE id IN (${placeholders})`);
      linksToProcess = stmt.all(...ids);
    } else {
      // Submit links that have not already been accepted by Google.
      const stmt = db.prepare(`
        SELECT * FROM links
        WHERE status IN (?, ?, ?, 'Pending', 'Failed')
      `);
      linksToProcess = stmt.all(STATUS.QUEUED, STATUS.SUBMISSION_FAILED, STATUS.VERIFICATION_FAILED);
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to query database: ' + err.message });
  }

  if (linksToProcess.length === 0) {
    return res.json({ success: true, message: 'No pending links to index.' });
  }

  let baseDomain = getBaseDomain(req);
  
  // Set up Google JWT auth client
  let jwtClient;
  try {
    const credentials = serviceAccount.key;
    jwtClient = new google.auth.JWT(
      credentials.client_email,
      null,
      credentials.private_key,
      ['https://www.googleapis.com/auth/indexing'],
      null
    );
    await jwtClient.authorize();
  } catch (err) {
    return res.status(500).json({ error: 'Google authentication failed: ' + err.message });
  }

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

    // Short sleep to respect rate limits
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  res.json({ success: true, processedCount: linksToProcess.length, results });
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
  const allowedStatuses = new Set(['Not Checked', 'Found', 'Not Found']);

  if (!id || !allowedStatuses.has(googleIndexStatus)) {
    return res.status(400).json({ error: 'A valid id and googleIndexStatus are required.' });
  }

  try {
    const checkedAt = googleIndexStatus === 'Not Checked' ? null : new Date().toISOString();
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
