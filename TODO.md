# TODO

Family shopping-request tool: an Edge/Chrome extension plus a shared dashboard, running locally
on Node with JSON storage or online on a Cloudflare Worker with D1.

This file is the living backlog. Move items between sections as work lands.

## Blocked (needs hardware)

- **Self-hosted ntfy on Raspberry Pi 5** — code and runbook already exist in `selfhost/`
  (docker compose with ntfy + Cloudflare Tunnel). Blocked because the user has no card reader to
  flash the Pi OS.
  - Prerequisites: 64-bit Raspberry Pi OS on a USB SSD or NVMe (not an SD card), a domain on
    Cloudflare, and a Cloudflare Tunnel token.
  - Runbook: [`selfhost/README.md`](selfhost/README.md)
  - Not tested on real hardware.

## Next — notification channel

`ntfy.sh` is rate-limited per source IP, and Cloudflare Workers share egress IPs, so `429`
failures are expected. The project needs a notification channel that is not tied to a shared IP.

- [ ] **Discord webhook** — free, per-webhook rate limits (about 5 requests per 2 seconds), no
      shared-IP issue. Needs `DISCORD_WEBHOOK_URL` as a Worker secret. Simplest to implement.
- [ ] **Telegram bot** — free, per-bot limits, no shared-IP issue. Needs `TELEGRAM_BOT_TOKEN` and
      `TELEGRAM_CHAT_ID`. User previously said they were not interested in Telegram; keep it
      listed but deprioritised.
- [ ] **Pushover** — one-time ~$5 per platform, limits per app token. Needs `PUSHOVER_TOKEN` and
      `PUSHOVER_USER`.
- [ ] **Self-hosted ntfy** — see Blocked above. Free forever, needs the Pi online.
- [ ] **Make the notifier pluggable** — one `src/notify.js` interface that dispatches to whichever
      channels are configured, so several can be enabled at once.

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
- [x] ntfy sender with optional access token.
- [x] 126 automated tests.
