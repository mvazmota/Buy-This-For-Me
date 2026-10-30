# TODO

Family shopping-request tool: an Edge/Chrome extension plus a shared dashboard, running locally
on Node with JSON storage or online on a Cloudflare Worker with D1.

This file is the living backlog. Move items between sections as work lands.

## Notifications

`ntfy.sh` is rate-limited per source IP, and Cloudflare Workers share egress IPs, so `429`
failures were expected there. Notifications now run against a self-hosted ntfy on the Pi, with
Discord as a second channel.

- [x] **Self-hosted ntfy on Raspberry Pi 5** — live at `https://ntfy.mvazmota.pt` behind a
      Cloudflare Tunnel (published application route → `http://127.0.0.1:2586`). ntfy runs in
      Docker on loopback; `cloudflared` runs on the host as a systemd service. Runbook:
      [`selfhost/README.md`](selfhost/README.md).
- [x] **Discord webhook** — free, per-webhook rate limits (about 5 requests per 2 seconds), no
      shared-IP issue. Live and verified with `DISCORD_WEBHOOK_URL` as a Worker secret.
- [x] **Make the notifier pluggable** — one `src/notify.js` interface that dispatches to whichever
      channels are configured, so several can be enabled at once. Implemented for ntfy + Discord.
- [ ] **Enable ntfy auth on the Pi** — the instance is currently open: anyone who guesses the
      topic name can read notifications. Add `auth-file` plus a user, then subscribe with that
      account. Not urgent, but it is the one loose end in the notification path.
- [ ] **Telegram bot** — free, per-bot limits, no shared-IP issue. Needs `TELEGRAM_BOT_TOKEN` and
      `TELEGRAM_CHAT_ID`. User previously said they were not interested in Telegram; keep it
      listed but deprioritised.
- [ ] **Pushover** — one-time ~$5 per platform, limits per app token. Needs `PUSHOVER_TOKEN` and
      `PUSHOVER_USER`.
- [ ] Discord direct messages instead of a channel — needs a bot (`DISCORD_BOT_TOKEN` plus a DM
      channel), because webhooks can only post into channels. Parked: the private server works.

## Backlog

- [ ] Publish the extension to the Edge Add-ons store so the dad can install it without developer
      mode.
- [ ] Dashboard: archive or paginate old requests once the list grows past a screen or two.
- [ ] Export/backup command for the D1 request data.
- [ ] Optional: PWA web push as an alternative to ntfy (service worker, VAPID keys, subscriptions
      in D1).
- [ ] Request images: capture the product image in the extension and show a thumbnail on the card.

## Done

- [x] Local Node prototype with JSON storage.
- [x] Cloudflare Worker + D1 deployment with password login.
- [x] Edge/Chrome extension: popup, settings, app-password direct submit, duplicate warning and
      price auto-fill.
- [x] Cart icons and dashboard favicon.
- [x] Dashboard search, status filters, sorting, inline edit, delete with confirmation, euro
      prices, dark mode, truncated titles.
- [x] Discord notifications for new requests (live).
- [x] ntfy sender with optional access token. Disabled: ntfy.sh rate-limits Cloudflare's shared
      egress IPs.
- [x] Username/password accounts with roles: `admin` edits and deletes, `user` adds and reads.
- [x] Extension login gate: the add form only appears after a login the server accepts.
- [x] Self-hosted ntfy over Cloudflare Tunnel, reachable at `https://ntfy.mvazmota.pt`.
- [x] 146 automated tests.
