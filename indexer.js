const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const KEY_FILE = path.join(__dirname, 'service_account.json');
const DB_PATH = path.join(__dirname, 'links.json');

// Check if service account credentials exist
if (!fs.existsSync(KEY_FILE)) {
  console.error('\n[Error] service_account.json file is missing!');
  console.error('Please create a Google Cloud project, enable the Indexing API, download the service account JSON key, save it here, and verify the service account email as an Owner of your domain in Google Search Console.\n');
  process.exit(1);
}

// Load service account key
const credentials = require(KEY_FILE);

// Set up Google JWT auth client
const jwtClient = new google.auth.JWT(
  credentials.client_email,
  null,
  credentials.private_key,
  ['https://www.googleapis.com/auth/indexing'],
  null
);

// Function to call the Google Indexing API
async function requestIndexing(url, type = 'URL_UPDATED') {
  try {
    // Authorize JWT client
    await jwtClient.authorize();

    // Call the Indexing API using googleapis client
    const response = await google.indexing({
      version: 'v3',
      auth: jwtClient
    }).urlNotifications.publish({
      requestBody: {
        url: url,
        type: type
      }
    });

    console.log(`[Success] Indexing requested for: ${url}`);
    console.log(`Response Status:`, response.status);
    return response.data;
  } catch (error) {
    console.error(`[Error] Failed to request indexing for: ${url}`);
    if (error.response && error.response.data) {
      console.error('Details:', error.response.data.error.message);
    } else {
      console.error('Details:', error.message);
    }
  }
}

// Run script
async function run() {
  const args = process.argv.slice(2);
  const targetUrl = args[0];

  if (targetUrl) {
    // If specific URL is provided, index it directly
    console.log(`Submitting single URL: ${targetUrl}`);
    await requestIndexing(targetUrl);
  } else {
    // Otherwise, submit all registered redirects in links.json
    if (!fs.existsSync(DB_PATH)) {
      console.log('No links.json found. Use server.js first to register some URLs.');
      return;
    }

    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    const ids = Object.keys(db);

    if (ids.length === 0) {
      console.log('No redirects registered in links.json.');
      return;
    }

    const baseDomain = process.env.BASE_DOMAIN;
    if (!baseDomain) {
      console.warn('[Warning] BASE_DOMAIN environment variable is not set. Defaulting to localhost:3000 redirects (which Google cannot crawl!).');
      console.warn('Run with BASE_DOMAIN=https://yourdomain.com node indexer.js');
    }

    console.log(`Found ${ids.length} redirect URL(s) to index...`);
    for (const id of ids) {
      const redirectUrl = `${baseDomain || 'http://localhost:3000'}/go/${id}`;
      console.log(`Indexing redirect: ${redirectUrl} (points to ${db[id]})`);
      await requestIndexing(redirectUrl);
      // Wait 1 second between requests to respect API rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

run();
