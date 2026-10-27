# BIFM Agent Instructions

## Project

Family shopping-request tool: a Manifest V3 Edge/Chrome extension plus a shared dashboard.
Development runs on a local Node server with JSON storage; production runs on a Cloudflare
Worker with D1. No front-end build step.

- Local mode: `server.js` + `lib/`, no auth, loopback only, data in `data/requests.json`.
- Online mode: Worker + D1 + static dashboard, protected by the `APP_PASSWORD` secret.

## Layout

- `extension/` — Manifest V3 extension (popup, options, settings, manifest).
- `public/` — shared dashboard HTML/CSS/JS for both modes.
- `src/worker.js` — Cloudflare Worker API and static-asset handler.
- `src/session.js` — signed session-cookie helpers using WebCrypto.
- `lib/` — local HTTP app, validation, and JSON store.
- `migrations/` — ordered D1 migration files.
- `test/` — local API, Worker, and extension tests.
- `wrangler.jsonc` — Worker, assets, D1 and `workers.dev` configuration.

## Commands (Windows / PowerShell)

```powershell
npm ci
npm test
npm run check
npm start
npx wrangler deploy --dry-run
npx wrangler d1 migrations apply buy-this-for-me --remote
npx wrangler deploy
```

- Node 18+ for the local server and tests; Node 22+ for Wrangler 4.
- Use `npm ci` for a clean dependency install.
- Local dashboard: <http://127.0.0.1:3000> via `npm start`.

## Runtime and Deploy Rules

- Production Worker URL and default extension backend:
  `https://buy-this-for-me.m-vaz-mota.workers.dev`.
- Keep the extension default on the Worker URL. Do not overwrite an explicit
  `chrome.storage.local` backend preference.
- D1 schema changes require a new ordered migration file under `migrations/`.
- Apply migrations explicitly before deploying Worker code that depends on them:
  `npx wrangler d1 migrations apply buy-this-for-me --remote`.
- Cloudflare Workers Builds does not apply migrations. Never assume it did.
- Do not claim a real Cloudflare deploy unless it was actually run. `--dry-run` is validation,
  not deployment.

## Security Requirements

- `APP_PASSWORD` is the Cloudflare Worker secret and the app password saved in the extension
  settings. Never commit, print, expose, or ask the user to paste the secret value. Do not place
  it in `wrangler.jsonc`, `.dev.vars`, build commands, source, or tests.
- The extension stores the app password locally in `chrome.storage.local` (key `appPassword`).
  This is a deliberate, family-only accepted risk. The value must never be committed or
  hardcoded, and it is used only for `GET` and `POST /api/requests` from the extension via the
  `X-App-Password` header (GET supports the duplicate warning). Do not send it to any other
  endpoint; PATCH still requires the session cookie.
- The local server has no authentication. Bind it only to loopback. Never tunnel,
  port-forward, reverse-proxy, or bind it to `0.0.0.0`.
- Do not commit `data/`, `.dev.vars`, secrets, or build output. Preserve `.gitignore`.

## Compatibility Contracts

- The shared dashboard under `public/` must keep working in both modes:
  local = password-free; online = login required.
- Local mode's `/api/session`, `/api/login`, and `/api/logout` remain permissive so the
  dashboard does not prompt for a password.
- The extension submits remote requests itself: it POSTs to
  `https://buy-this-for-me.m-vaz-mota.workers.dev/api/requests` with the `X-App-Password`
  header, and reads the same route with that header to warn about duplicate links. There is
  no dashboard tab or `#draft` fragment handoff.
- `price` is optional, nullable, and stored as a plain number (at most 2 decimals). The
  dashboard displays it with two decimals and no currency symbol.
- Keep changes consistent with the existing plain Node/browser JavaScript style. Do not add a
  framework or front-end build step without explicit approval.

## Verification and Done Criteria

Test API/UI and extension changes, not just syntax.

Before reporting completion, run the applicable checks:

```powershell
npm test
npm run check
git diff --check
npx wrangler deploy --dry-run
```

- Run the Wrangler dry-run for any Worker, `wrangler.jsonc`, or migration change.
- For extension changes, verify the popup/options flow and reload the unpacked extension from
  `edge://extensions`; confirm the default backend and saved overrides still behave correctly.
- Report what was tested and any checks not run. Do not invent results.
- Do not perform destructive git operations (reset, clean, force-push) or remote schema changes
  without explicit user permission.

## Delegation and Review

- The user wants project coding and documentation tasks delegated to **DeepSeek V4.1 Flash**
  (`opencode-go/deepseek-v4.1-flash`).
- The coordinator reviews and tests agent changes; delegated work is not final until that
  review and the applicable checks pass.
