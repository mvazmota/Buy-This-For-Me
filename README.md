# BIFM shopping requests (local prototype)

A small family shopping list that starts from the page you are viewing: an Edge extension
sends the current tab's title and link to a dashboard running on your own PC.

**This is a local-only prototype.** The server binds to `127.0.0.1` and has no login, no
encryption, and no sync. Do **not** expose it to the internet (no port forwarding, tunnels,
reverse proxies, or `0.0.0.0` binding). See [Security](#security-and-limitations).

- No npm dependencies, no build step, no external services.
- Data is a plain JSON file under `data/` on this computer only.
- Tested with Node.js v24.21.0 on Windows 11; needs Node 18 or newer.

## Contents

```text
server.js              starts the local server on 127.0.0.1
lib/app.js             HTTP routes, validation wiring, static dashboard files
lib/validate.js        request/status validation rules
lib/store.js           JSON storage with atomic, serialized writes
public/                dashboard (plain HTML/CSS/JS)
extension/             Manifest V3 extension for Edge (load this folder unpacked)
test/api.test.js       API tests using node:test
data/requests.json     created automatically on first save (ignored by git)
```

## 1. Start the server

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
   BIFM shopping requests — local only
   Dashboard:  http://127.0.0.1:3000
   Data file:  C:\Users\Martinho\Projects\BIFM\data\requests.json
   ```
5. Open <http://127.0.0.1:3000> in Edge.

Leave that PowerShell window open while you use the extension. Press `Ctrl+C` to stop.
There is nothing to `npm install`; `npm test` and `npm start` use only Node built-ins.

### Different port

The extension defaults to port **3000**. If you must change it (for example the port is busy):

1. Start the server with a temporary environment variable:
   ```powershell
   $env:PORT=3001; npm start
   ```
2. Also update both places in the extension:
   - `extension/popup.js` — `const SERVER_URL = 'http://127.0.0.1:3001';`
   - `extension/manifest.json` — host permissions for `http://127.0.0.1:3001/*`
3. Click the reload icon for the extension on `edge://extensions`.

For this prototype, staying on 3000 is simpler.

## 2. Load the extension in Edge

1. Open `edge://extensions`.
2. Turn on **Developer mode** (left sidebar on recent Edge versions).
3. Click **Load unpacked**.
4. Select the folder `C:\Users\Martinho\Projects\BIFM\extension` (the folder containing
   `manifest.json`, not the project root).
5. The extension **BIFM Shopping Requests** appears. Click the puzzle-piece icon in the
   toolbar and pin it if you want one-click access.
6. Open a normal product page (`http://` or `https://`), click the extension icon.
   The popup pre-fills the page title and link.
7. Edit the title if needed, set quantity (default 1), add an optional note, then click
   **Send request**.
8. Open the dashboard at <http://127.0.0.1:3000> to see it at the top of the list.

After editing extension files, return to `edge://extensions` and click the extension's
**Reload** icon. Reloading the extension also closes an open popup.

### Permissions used

| Permission | Why |
| --- | --- |
| `activeTab` | Read the active tab's title and URL only when you click the extension icon. No permanent access to browsing history. |
| Host permissions for `http://127.0.0.1:3000/*` and `http://localhost:3000/*` | Allow the popup to call the local server. |

No other permissions, accounts, or remote URLs are used. If a browser-internal page
(`edge://`, `chrome://`, extension pages) is active, its link is intentionally left blank
because the server only accepts `http://` and `https://` links.

## 3. Using the dashboard

- Requests are listed **newest first**.
- Each card shows the title (clickable original link), quantity, optional note, submitted
  time, and a status menu.
- Statuses save immediately: **New**, **Purchased**, **Done**, **Not buying**.
- If an update fails, the menu reverts and an error banner explains why.
- The page refreshes every 15 seconds and has a **Refresh** button.
- An empty state appears when there are no requests.

## 4. Data and backups

- Storage file: `data\requests.json` (created on first successful submit).
- Stop the server before copying or replacing the file to avoid reading a half-written state.
- Back up by copying `data\requests.json` somewhere else.
- To start over, stop the server, then rename or delete `data\requests.json`, and restart.
- If the file contains invalid JSON, the server refuses to start and leaves the file
  untouched. Fix or move it, then start again. Nothing is silently discarded.

## 5. HTTP API

All responses are JSON. Base URL is `http://127.0.0.1:3000`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | `{"ok":true}` liveness check |
| `GET` | `/api/requests` | `{"requests":[...]}` newest first |
| `POST` | `/api/requests` | Create a request |
| `PATCH` | `/api/requests/:id` | Update only the status |

Create body:

```json
{
  "title": "Running shoes",
  "url": "https://example.com/shoes",
  "note": "Size 43, blue",
  "quantity": 2
}
```

Rules: `title` required, 1–200 characters after trimming; `url` required and must parse as
`http://` or `https://` (max 2048); `note` optional, max 1000 characters; `quantity`
optional whole number 1–999 (default 1). Status updates accept exactly one of the four
statuses.

Validation failures return `400` with a message and field details, for example:

```json
{
  "error": "Please fix the highlighted fields.",
  "details": { "quantity": "Quantity must be between 1 and 999." }
}
```

Other errors: `404` unknown request/route, `405` wrong method, `413` body over 64 KB,
`500` unexpected server error (details in the server console). A request defaults to status
`New` and records `submittedAt` and `updatedAt` as ISO timestamps.

## 6. Tests

```powershell
npm test
```

Uses `node:test` against a temporary data file and an ephemeral loopback port; it does not
touch `data/requests.json`. Expected: 11 tests passing (create, list order, persistence
across restart, validation, status updates, malformed/oversized bodies, routing errors,
static serving, path-traversal block).

There is no build step. Optional syntax check for the popup script:

```powershell
node --check extension/popup.js
```

## Security and limitations

- **Do not expose this to the internet.** The server has no authentication or authorization,
  and runs plain HTTP. Loopback binding keeps it on this PC but does not protect it from
  other software or users on the same machine.
- **Not synced.** Data lives only in this folder on this PC. Family members on other devices
  cannot use it yet; a future version needs hosting, accounts, and transport security first.
- The extension can only talk to the two loopback host permissions listed above while the
  server is running.
- No editing or deleting of existing requests, no item categories, no per-person attribution,
  no purchase dates. A request can be submitted repeatedly by accident.
- The dashboard trusts whatever is in the local JSON file and only renders `http(s)` links;
  titles and notes are inserted as text, not HTML.
- The JSON store is adequate for a household-sized list. It is not transactional across
  processes; run a single server instance.
- Edge's popup closes when it loses focus, so an in-flight submit may be cut off if you click
  away. Reopen it and check the dashboard if unsure.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Popup says it cannot reach `http://127.0.0.1:3000` | Start the server (`npm start`) and keep that window open. |
| `Port 3000 is already in use` | Stop the other process, or use the different-port steps above. |
| Dashboard shows "Could not load requests" | Same cause: server stopped or wrong port. Start it, then press Refresh. |
| Title/link not pre-filled | Click the icon while on a normal `http(s)` page. Reload the extension after file edits. |
| Extension missing or shows errors on `edge://extensions` | Confirm you loaded the `extension` folder itself and that `manifest.json` is directly inside it. |
| Server refuses to start and mentions invalid JSON | `data\requests.json` is malformed. Move it aside, then restart. |
| Changes not visible | Reload the extension in `edge://extensions`; refresh the dashboard. |
