# Free Multi-Engine URL Indexer

This is a lightweight, self-hosted Node.js script that lets you programmatically index both owned and third-party URLs (such as Medium articles, Stack Overflow answers, YouTube videos, and social media posts) in Google and Bing/Yahoo **100% for free**.

It replicates the exact core mechanics of paid services like **Prime Indexer** by using the **Google Indexing API** and the **Redirect/Buffer Hub** technique.

---

## How It Works

1. **Third-Party Limitation:** Google's Indexing API will reject requests for domains you do not own (like `medium.com` or `stackoverflow.com`).
2. **The Workaround:** 
   - You register your external URL in this app.
   - The app generates a clean shortlink on a domain **you do own** (e.g., `https://yourdomain.com/go/abc1234`).
   - When Googlebot visits this shortlink, your server responds with a **`301 Moved Permanently`** redirect to the external URL (e.g., `https://medium.com/@yourusername/your-post`).
   - You run the indexer script to submit `https://yourdomain.com/go/abc1234` to the Google Indexing API.
   - Googlebot crawls the shortlink, follows the redirect to Medium, and crawls/indexes the final post.

The dashboard also creates a public discovery layer search engines can crawl:

- `/hub` lists every submitted target URL as a normal public link.
- `/sitemap.xml` lists the hub and redirect URLs on your verified domain.
- `/feed.xml` publishes the latest submitted redirect URLs as an RSS feed.
- Each row has an **SEO** check that inspects the target page for common blockers such as `noindex`, bad HTTP status, non-HTML responses, thin pages, and canonical tags pointing somewhere else.

---

## Setup Guide

### Step 1: Set Up Google Cloud Platform (GCP)
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (e.g., "URL Indexer").
3. Navigate to **APIs & Services > Library**, search for **Indexing API**, and click **Enable**.
4. Navigate to **IAM & Admin > Service Accounts** and click **Create Service Account**.
   - Give it any name (e.g., `indexer-agent`).
   - Skip assigning roles (none are needed inside GCP).
5. Once created, click on your service account email, navigate to the **Keys** tab, click **Add Key > Create new key**, select **JSON**, and click **Create**.
6. A JSON key file will download. **Rename this file to `service_account.json`** and save it in the root folder of this project.

### Step 2: Grant Permissions in Google Search Console (GSC)
1. Open the `service_account.json` file and copy the `"client_email"` value (e.g., `indexer-agent@yourproject.iam.gserviceaccount.com`).
2. Go to [Google Search Console](https://search.google.com/search-console/) and select the property for your domain (e.g., `https://yourdomain.com`).
3. Navigate to **Settings > Users and permissions**.
4. Click **Add User**, paste the service account email, and select **Owner** as the Permission level. (Owner permission is required by Google for the Indexing API).

### Step 3: Set Up the App Locally
1. Initialize dependencies:
   ```bash
   npm install
   ```
2. Save your service account key file as `service_account.json` in this directory.

### Render Environment Variables
For Render deployments, store secrets in environment variables so they survive restarts and never get committed to Git.

Set these in **Render > Your Web Service > Environment**:

```text
BASE_DOMAIN=https://link.calhearing.com
GOOGLE_SERVICE_ACCOUNT_JSON={paste the full service account JSON here}
GOOGLE_CLIENT_ID={Google OAuth web client ID}
GOOGLE_CLIENT_SECRET={Google OAuth web client secret}
SESSION_SECRET={a long random string}
ALLOWED_GOOGLE_EMAILS=you@example.com
INDEXNOW_KEY={optional 8-128 character key for Bing/Yahoo IndexNow}
```

`DATA_DIR` is optional. On Render's free plan, do not set it to `/var/data` unless you have attached a persistent disk.

`INDEXNOW_KEY` is optional. If omitted, the app derives a stable key from `SESSION_SECRET` and serves it at `https://link.calhearing.com/{key}.txt`.

For Google login, create an OAuth 2.0 **Web application** client in Google Cloud and add this authorized redirect URI:

```text
https://link.calhearing.com/auth/google/callback
```

---

## How to Run It

### 1. Run the Gateway Server
For Google to crawl your redirects, the server must be running on a public server pointing to your domain. You can host it on Render, Railway, Vercel, or any VPS for free.

To run it locally or in production:
```bash
# Start the redirect server
npm start
```
Go to `http://localhost:3000` to access the dashboard. 

### 2. Register Your URLs
Input your 3rd-party URLs (Medium posts, Stack Overflow links) on the dashboard to register their redirects. They will be saved to `links.json`.

### 3. Trigger Indexing
Once your server is running publicly (e.g. at `https://yourdomain.com`), run the indexer script with your domain specified:

```bash
BASE_DOMAIN=https://yourdomain.com npm run index
```

This will read your `links.json`, generate redirect shortlinks for all registered URLs, and submit them one-by-one to Google.

### 4. Help Discovery
After adding URLs, open these public pages and optionally submit the sitemap in Google Search Console and Bing Webmaster Tools:

```text
https://link.calhearing.com/hub
https://link.calhearing.com/sitemap.xml
https://link.calhearing.com/feed.xml
```

Use the row-level **SEO** button before waiting on search results. If a target page returns `Blocked`, the external page is likely telling crawlers not to index it or is returning an error. If it returns `OK`, the app has done what it can: submit the verified redirect, expose the URL in the hub/sitemap/feed, and confirm the target page looks crawlable.

### (Optional) Indexing directly from the Command Line
If you want to submit a single URL directly without the database:
```bash
node indexer.js https://yourdomain.com/some-page-to-index
```
# free-url-indexer
