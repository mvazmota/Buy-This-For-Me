# BIFM shopping requests

A small family shopping list that starts from the page you are viewing: an Edge extension
sends the current tab's title and link to a dashboard. The dashboard runs online on Cloudflare
Workers with D1 storage, or on your own PC as a local development prototype. The extension
sends to the deployed Worker at `https://buy-this-for-me.m-vaz-mota.workers.dev` by default;
the local server is an explicit opt-in for development.

- **Online mode (default):** Cloudflare Worker + D1 + static dashboard from `public/`,
  protected by the `APP_PASSWORD` Worker secret. HTTPS only on `workers.dev`. The extension
  posts requests straight to the Worker with the saved app password; no dashboard tab opens.
- **Local mode (optional):** `npm start`, no password, data in `data/requests.json`. Binds to
  `127.0.0.1` only. Never expose it to the internet. Requires saving
  `http://127.0.0.1:3000` in the extension settings.
- No accounts, no npm framework, no build step for the dashboard. Wrangler is the only
  development dependency and is needed only for Cloudflare work.
- Tested with Node.js v24.21.0 on Windows 11. The local server needs Node 18+; Wrangler
  4.152 needs Node 22+.

## Contents

```text
server.js                    starts the local server on 127.0.0.1
lib/app.js                   local HTTP routes, validation wiring, static dashboard files
lib/validate.js              shared request/status validation rules
lib/store.js                 local JSON storage with atomic, serialized writes
src/worker.js                Cloudflare Worker API + static asset handler
src/session.js               HMAC-signed session cookies (WebCrypto)
src/package.json             marks src/ as ESM for Node syntax checks
migrations/                  D1 migrations (apply with Wrangler)
wrangler.jsonc               Worker, static assets, D1 and workers.dev config
public/                      shared dashboard (plain HTML/CSS/JS)
extension/                   Manifest V3 extension for Edge (load this folder unpacked)
extension/url-utils.js       canonical URL normalization for the duplicate warning
extension/price-extractor.js reads a product price from the page; euro price formatting
test/api.test.js             local API tests using node:test
test/worker.test.js          Worker auth/API tests using a fake D1
test/price.test.js           price extraction and euro formatting tests
data/requests.json           created automatically on first local save (ignored by git)
```

## 1. Start the local server (optional, for development)

Skip this section if you only use the online Worker (the extension default). Run it when you
want to develop or test against a local dashboard.

1. Open **PowerShell**.
2. Change to this project folder:
   ```powershell
   cd C:\Users\Martinho\Projects\BIFM
   ```
3. Start it:
   ```powershell
   npm start
   ```
4. You should see:
   ```text
   BIFM shopping requests - local only
   Dashboard:  http://127.0.0.1:3000
   Data file:  C:\Users\Martinho\Projects\BIFM\data\requests.json
   ```
5. Open <http://127.0.0.1:3000> in Edge.

Leave that PowerShell window open while you use the extension. Press `Ctrl+C` to stop.
`npm start` and `npm test` use only Node built-ins. `npm install` is only needed for Wrangler
and the Cloudflare steps.

The extension sends to the online Worker by default. To use this local server you must explicitly
set the backend URL to `http://127.0.0.1:3000` in the extension settings (section 2). Local mode
never asks for a password. The shared dashboard still calls `/api/session`, `/api/login` and
`/api/logout`; against the local server those endpoints always report an authenticated session
and login/logout succeed, so the old local workflow is unchanged.

### Different local port

When you use local mode, the extension expects port **3000** and the manifest only has host
permission for port 3000. Staying on 3000 is simplest. If you must change it, update the host
permissions in `extension/manifest.json` to the new port and enter the matching URL in the
extension settings. The local server binds to loopback only.

## 2. Load the extension in Edge

1. Open `edge://extensions`.
2. Turn on **Developer mode** (left sidebar on recent Edge versions).
3. Click **Load unpacked**.
4. Select the folder `C:\Users\Martinho\Projects\BIFM\extension` (the folder containing
   `manifest.json`, not the project root).
5. The extension **BIFM Shopping Requests** appears. Pin it if you want one-click access.
6. Open a normal product page (`http://` or `https://`), click the extension icon. The popup
   pre-fills the page title and link.
7. Edit the title if needed, set quantity (default 1), add an optional price and notes, then
   click **Send request**. Prices are euros. When the product page exposes a machine-readable
   price (JSON-LD, `product:price:amount`/`og:price:amount` meta tags, or `itemprop="price"`),
   the popup fills the empty price field. Extraction is best effort: it never overwrites a
   price you typed, and it silently does nothing on pages that expose no price. By default
   this sends directly to the online Worker, so save the app password in the extension
   settings first (section 2).
   See below to switch to the local server. Before sending, the popup reads the list and warns
   when the same normalized link is already there; choose **Add anyway** or **Cancel**.
8. Open the dashboard to see it. The popup footer links to the configured dashboard.

After editing extension files, return to `edge://extensions` and click the extension's
**Reload** icon. Reloading the extension also closes an open popup.

### Extension backend settings

Open the extension's **Settings** (extension options) from the popup footer or from
`edge://extensions` → **Details** → **Extension options**. The form saves the Dashboard URL
and the App password together.

| Backend URL | Behaviour |
| --- | --- |
| `https://buy-this-for-me.m-vaz-mota.workers.dev` (default) | Sends the request directly to the Worker from the popup. No new tab. Requires the app password to be saved in the extension settings. |
| `http://127.0.0.1:3000` | Explicit local override. Posts directly to the local server started with `npm start`. No password. |

The extension uses the deployed Worker when no backend URL is saved. Saving a value replaces
that fallback for this browser profile; the extension never overwrites an explicitly saved
URL on its own. To return to the online Worker, save
`https://buy-this-for-me.m-vaz-mota.workers.dev` again.

Rules for the settings:

- Use the dashboard **root** URL. No `/api`, query string, or `#fragment`.
- A remote URL must use `https://`. Plain `http://` is accepted only for the local server.
- The app password is saved in `chrome.storage.local` in this browser profile only, and is
  used only for `GET`/`POST /api/requests` on the configured Worker (GET feeds the duplicate
  warning). It is never committed to the project. Saving a remote URL without a password is
  rejected with a field error.
- When the password is missing or wrong, the popup says so and asks you to update it in
  Settings. Nothing else is retried or queued.

### Permissions used

| Permission | Why |
| --- | --- |
| `activeTab` | Read the active tab's title and URL only when you click the extension icon. |
| `storage` | Remember the dashboard URL and the app password chosen in the extension settings. |
| `scripting` | Inject `price-extractor.js` into the active tab (click-triggered) to read the product price. No broad host permissions are requested. |
| Host permissions for `http://127.0.0.1:3000/*`, `http://localhost:3000/*` and `https://buy-this-for-me.m-vaz-mota.workers.dev/*` | Allow the popup to POST directly to the local server and to the deployed Worker. |

If a browser-internal page (`edge://`, `chrome://`, extension pages) is active, its link is
left blank because the API only accepts `http://` and `https://` links, and the automatic
price lookup is skipped.

## 3. Using the dashboard

- Requests are listed **newest first**.
- Each card shows the title (clickable original link), quantity, optional price, optional
  notes, submitted time, and a status menu.
- **Edit** opens an inline form for title, URL, notes, quantity and price. **Save** or
  **Cancel**; field errors appear under the form and match the server limits.
- Prices are euros and display with EUR formatting (`pt-PT`, e.g. `12,99 €`) on the card and
  under the price field while editing. They are stored as plain numbers and can be cleared
  with an empty price field. **Sort by → Price (high to low)** puts unpriced requests last.
- Statuses save immediately: **New**, **Purchased**, **Done**, **Not buying**.
- If an update fails, the menu reverts and an error banner explains why.
- The page refreshes every 15 seconds and has a **Refresh** button.
- Online, the dashboard asks for the app password. After login it uses a signed, HttpOnly,
  Secure, SameSite=Lax cookie valid for 7 days. **Log out** clears it. If the session expires
  while the page is open, the dashboard returns to the login view; requests added from the
  extension do not depend on this cookie.
- Local mode hides **Log out** and never asks for a password.

## 4. Data and backups (local mode)

- Storage file: `data\requests.json` (created on first successful submit).
- Stop the server before copying or replacing the file to avoid reading a half-written state.
- Back up by copying `data\requests.json` somewhere else.
- To start over, stop the server, rename or delete `data\requests.json`, then restart.
- If the file contains invalid JSON, the server refuses to start and leaves the file untouched.

Online data lives in the Cloudflare D1 database. Use Wrangler (for example
`npx wrangler d1 export buy-this-for-me --remote --output backup.sql`) if you need a copy.
Changing the Worker or redeploying does not clear D1.

## 5. HTTP API

All responses are JSON. Local base URL: `http://127.0.0.1:3000`. Online base URL:
`https://buy-this-for-me.m-vaz-mota.workers.dev`. Calls must be same-origin, except the
extension's direct `GET`/`POST /api/requests`, which authenticate with the `X-App-Password`
header. Other cross-origin API requests (including `PATCH`) are rejected by the Worker.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | `{"ok":true}` liveness check (public) |
| `GET` | `/api/session` | `{"authenticated":bool,"authRequired":bool}` |
| `POST` | `/api/login` | Body `{"password":"..."}`; sets the session cookie online |
| `POST` | `/api/logout` | Clears the session cookie online |
| `GET` | `/api/requests` | `{"requests":[...]}` newest first (online: login cookie or `X-App-Password` header) |
| `POST` | `/api/requests` | Create a request (online: login cookie or `X-App-Password` header) |
| `PATCH` | `/api/requests/:id` | Update any subset of fields (online: login cookie required) |

Create body:

```json
{
  "title": "Running shoes",
  "url": "https://example.com/shoes",
  "note": "Size 43, blue",
  "quantity": 2,
  "price": 59.95
}
```

Rules: `title` required, 1–200 characters after trimming; `url` required and must parse as
`http://` or `https://` (max 2048); `note` optional, max 1000 characters; `quantity`
optional whole number 1–999 (default 1); `price` optional number from 0 to 1000000 with at
most 2 decimals, stored as `null` when omitted. Prices are euros; no currency field is stored.

`PATCH /api/requests/:id` accepts any subset of `title`, `url`, `note`, `quantity`, `price`
and `status`, using the same field rules; at least one field is required. `price: null`
(or `""`) clears it. A status-only body (`{"status":"Purchased"}`) keeps working as before.
Each update refreshes `updatedAt` and returns the full request.

Validation failures return `400` with a message and field details:

```json
{
  "error": "Please fix the highlighted fields.",
  "details": { "quantity": "Quantity must be between 1 and 999." }
}
```

Other errors: `401` login required or bad credentials, `403` cross-origin API call, `404`
unknown request/route, `405` wrong method, `413` body over 64 KB, `500` unexpected server
error (generic message). A request defaults to status `New` and records `submittedAt` and
`updatedAt` as ISO timestamps.

Online, `/api/requests` and `/api/requests/:id` return `401` until the login cookie is valid.
The exception is `GET`/`POST /api/requests`: the extension sends its saved app password in the
`X-App-Password` header, and a valid value authorises that single request without a cookie. A
missing or wrong header on a cross-origin call returns `401` and stores nothing. `PATCH` never
accepts the header as a substitute for the cookie. Login
errors are deliberately generic and never reveal the configured password, and the password is
never echoed in a response or a log.

## 6. Tests and syntax checks

```powershell
npm test
npm run check
```

`npm test` runs local API tests, Worker auth/API tests, extension popup/duplicate tests,
dashboard list/sort tests and price extraction/formatting tests. The Worker tests use a fake
D1 binding, not a live Cloudflare account. The price tests use a minimal fake document; they
do not load a real store page. `npm run check` runs `node --check` over the Worker, session
helper, dashboard scripts and extension scripts.

Apply migrations to the local D1 copy (no Cloudflare account needed) with
`npx wrangler d1 migrations apply buy-this-for-me --local`.

Optional: bundle the Worker without deploying (validates Wrangler config and imports):

```powershell
npx wrangler deploy --dry-run
```

## 7. Deploy to Cloudflare Workers

This repository is configured for a Worker named `buy-this-for-me`. The deployed URL is
`https://buy-this-for-me.m-vaz-mota.workers.dev`, which is also the extension's default
backend. The Worker handles
`/api/*` first, stores requests in D1, and serves the existing dashboard files from `public/`
through the `ASSETS` binding. `workers.dev` is enabled.

Nothing in this section has been run against a Cloudflare account here. You must supply the
account, database id and app password.

### 7.1 Requirements

1. A Cloudflare account (the free plan is enough for this prototype).
2. Node.js 22 or newer (the Wrangler 4.152 requirement) and npm. If Cloudflare Workers
   Builds uses an older default, set the `NODE_VERSION` environment variable to `22` in the
   build settings.
3. This project installed locally:
   ```powershell
   npm install
   npx wrangler --version
   ```
4. Wrangler login for the first manual deploy:
   ```powershell
   npx wrangler login
   ```

### 7.2 Create the D1 database

1. Create the database:
   ```powershell
   npx wrangler d1 create buy-this-for-me
   ```
2. Copy the printed `database_id` (a UUID).
3. Open `wrangler.jsonc` and replace the placeholder:
   ```jsonc
   "database_id": "00000000-0000-0000-0000-000000000000"
   ```
   with the real id. Keep the binding name `DB`, the database name `buy-this-for-me`, and
   `migrations_dir` unchanged.
4. The placeholder is intentionally invalid so a deploy cannot silently target the wrong
   database.

### 7.3 Apply the D1 migration

Apply the schema to the remote database before the first request:

```powershell
npx wrangler d1 migrations apply buy-this-for-me --remote
```

For local Worker development, apply to the local D1 copy instead:

```powershell
npx wrangler d1 migrations apply buy-this-for-me --local
```

`migrations/0001_create_requests.sql` creates the `requests` table and an index; it is
idempotent (`IF NOT EXISTS`). `migrations/0002_add_price.sql` adds the nullable `price`
column. SQLite has no `ADD COLUMN IF NOT EXISTS`, so it is written plainly and relies on
Wrangler's migration tracking to run once; existing rows get `NULL`. When you add a new
migration file, apply it with the same `--remote` command before deploying code that needs it.

### 7.4 First deploy with Wrangler

```powershell
npx wrangler deploy
```

The command prints the deployed URL, `https://buy-this-for-me.m-vaz-mota.workers.dev`. The
Worker now exists, but login is still unavailable until the secret is set in step 7.5.

If Wrangler complains that the database id is invalid, the placeholder in `wrangler.jsonc` was
not replaced.

### 7.5 Set the app password secret

Generate a long random password, then store it **only** as a Worker secret:

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
npx wrangler secret put APP_PASSWORD
```

Paste the password when prompted. It is stored encrypted by Cloudflare and is not written to
this repository. Do not put it in `wrangler.jsonc`, `.dev.vars`, a build command, or the
source. You enter it once in the extension settings; there it is saved only in that browser
profile (`chrome.storage.local`) so the popup can post requests directly.
`wrangler secret put` needs the Worker to exist, which is why the first deploy comes
first. To rotate the password later, run the command again; this invalidates existing session
cookies and requires updating the extension settings.

Open the deployed URL, log in with the password, and add a test request. Then save that root
URL and the same password in the extension settings (section 2) and send a test request from
a product page. If login returns "Login is not available", the `APP_PASSWORD` secret is
missing for that Worker.

### 7.6 Connect Cloudflare Workers Builds to GitHub

The repository for this project is `mvazmota/Buy-This-For-Me`, production branch `main`.

Workers Builds connects Git to a Worker that already exists; it does not create the first
deployment. Finish steps 7.2–7.5 before connecting anything: create the D1 database
(`npx wrangler d1 create buy-this-for-me`), replace the placeholder `database_id` in
`wrangler.jsonc` with the real id, apply the migration with
`npx wrangler d1 migrations apply buy-this-for-me --remote`, deploy once with
`npx wrangler deploy`, and set the `APP_PASSWORD` secret. Connecting Builds afterwards only
automates deploys of later commits.

1. Commit and push the project to GitHub. The real D1 id from step 7.2 and the new files must
   be committed; the password must not be committed.
2. In the Cloudflare dashboard open **Workers & Pages** and select the Worker you already
   deployed in step 7.4. Do not create a new Worker or import the repository as a new project.
3. Open **Settings** → **Builds** → **Connect**.
4. If prompted, authorize the Cloudflare GitHub App and grant it access to
   `mvazmota/Buy-This-For-Me`.
5. Select the repository `mvazmota/Buy-This-For-Me`.
6. Set **Production branch** to `main`.
7. Set the **build command** to:
   ```text
   npm ci && npm test && npm run check
   ```
8. Set the **deploy command** to:
   ```text
   npx wrangler deploy
   ```
9. Save. Cloudflare installs from `package-lock.json`, runs the tests and syntax checks, then
   deploys the Worker.
10. Make sure `APP_PASSWORD` exists on the Worker (step 7.5). Worker secrets are runtime
    configuration and are not committed or created by the build.

Connecting Builds does not change the running Worker; it enables deployments on future work.
From then on every push to `main` runs the build and deploy commands, so you no longer deploy
by hand. Builds never applies D1 migrations: run the `--remote` migration from step 7.3
yourself before pushing code that needs a new one.

### 7.7 Verify the deployment

1. `GET https://buy-this-for-me.m-vaz-mota.workers.dev/api/health` in a browser or with curl
   should return `{"ok":true}`.
2. Open `https://buy-this-for-me.m-vaz-mota.workers.dev/` in a private window. You should see
   the login form, not the list.
3. Log in with `APP_PASSWORD`. The dashboard should load (empty at first).
4. Add a request from the dashboard's API or the extension and confirm it appears after a
   refresh and after a Worker redeploy (it lives in D1).
5. Log out and confirm the list is no longer shown.
6. Wrong passwords must show a generic failure, never the configured password.

### 7.8 Point the extension at the Worker

The extension already uses `https://buy-this-for-me.m-vaz-mota.workers.dev` by default, so no
setting is needed unless you previously saved another URL.

1. Open the extension settings and check the Dashboard URL. If you saved the local URL while
   developing, replace it with `https://buy-this-for-me.m-vaz-mota.workers.dev`, enter the app
   password, and save.
2. Submit a request from a product page. The popup posts it directly to the Worker and shows
   `Sent “title”.` with the dashboard link. No new tab opens.
3. Open the dashboard, log in if needed, and confirm the request appears after a refresh.

Local mode is opt-in: save `http://127.0.0.1:3000` to use the direct local POST path. A local
URL never reaches the online Worker.

## 8. Security and limitations

- **Local mode must stay local.** It has no authentication, uses plain HTTP, and binds to
  `127.0.0.1`. Do not port-forward it, tunnel it, reverse-proxy it, or bind it to `0.0.0.0`.
- **Online mode uses one shared password.** Everyone with the password sees and can change
  every request. There are no individual accounts, audit trails, or per-person permissions.
- The session cookie is HMAC-signed with a key derived from `APP_PASSWORD`, is HttpOnly,
  Secure and SameSite=Lax, and expires after 7 days. Logging out clears it; rotating the
  secret invalidates all sessions.
- The API rejects cross-origin calls and returns generic login/internal errors. No CORS
  headers are added. The only cross-origin exception is the extension's `GET`/`POST
  /api/requests` with a valid `X-App-Password` header. Request bodies are capped at 64 KB.
- `APP_PASSWORD` is a Cloudflare Worker secret. The extension also saves the same password in
  `chrome.storage.local` in this browser profile for direct submissions (family-only accepted
  risk). It is never committed to git and never hardcoded in source. Do not reuse an important
  password.
- There is no rate limiting on login or on extension submissions. Choose a long random password.
- No deleting of existing requests, no categories, no purchase dates. The popup warns about a
  matching normalized link but does not block duplicates; it does not queue or retry failed
  sends. URL normalization ignores tracking parameters, fragments and trailing slashes.
- The dashboard renders `http(s)` links only; titles and notes are inserted as text, not HTML.
- Automatic price lookup is heuristic: it reads JSON-LD `Product` offers, price meta tags and
  `itemprop="price"` from the active tab, accepts euro or unlabelled amounts, and never
  overwrites a typed price. It can pick a wrong amount (for example a strike-through or a
  per-unit price), so check the price field before sending. Pages that hide prices behind
  scripts or a login simply produce no suggestion.
- D1 is eventually consistent across Cloudflare locations; the dashboard's 15-second refresh
  is usually enough for a household list.

## 9. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Popup says it cannot reach `http://127.0.0.1:3000` (local override) | Start the local server (`npm start`) and keep that window open. |
| Requests go to the online Worker but you wanted the local server | Save `http://127.0.0.1:3000` in the extension settings. The Worker is the default. |
| `Port 3000 is already in use` | Stop the other process. The extension only supports port 3000 without a manifest change. |
| Dashboard shows "Could not load requests" | Local: server stopped or wrong port. Online: check the Worker URL and login. Press Refresh. |
| Online dashboard shows the login form after working | The 7-day session expired or the secret was rotated. Log in again. |
| Login says "Login is not available" | The Worker has no `APP_PASSWORD` secret. Run `npx wrangler secret put APP_PASSWORD`. |
| `wrangler deploy` rejects the database id | Replace the all-zero placeholder in `wrangler.jsonc` with the id from `wrangler d1 create`. |
| Popup says "Password is missing or wrong" | Open the extension settings and save the current app password. Rotating the Worker secret requires updating it there too. |
| Popup says it cannot reach the online server | Check the network connection and the Dashboard URL in extension settings; the Worker URL must be the `https://` root with no path. |
| Title/link not pre-filled | Click the icon on a normal `http(s)` page. Reload the extension after file edits. |
| Price not pre-filled from the page | Extraction is best effort (JSON-LD, price meta tags, `itemprop="price"`). Type it manually; any found price is only a suggestion. |
| Changes not visible | Reload the extension in `edge://extensions`; refresh the dashboard. |
| Server refuses to start and mentions invalid JSON | `data\requests.json` is malformed. Move it aside, then restart. |
