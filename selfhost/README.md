# Self-hosted ntfy on a Raspberry Pi 5

Run your own ntfy instead of `ntfy.sh`, exposed through a Cloudflare Tunnel. The Pi publishes
no ports: `cloudflared` connects out to Cloudflare, and Cloudflare forwards
`https://ntfy.yourdomain.com` to `http://ntfy:80` inside the compose network.

Files here:

```text
docker-compose.yml   ntfy + cloudflared, no published ports
.env.example         template; copy to .env (git-ignored)
```

`selfhost/data/` is created on the Pi and is git-ignored. Nothing in this folder contains a
real domain, topic or token.

## 1. Prepare the Pi

1. Flash **64-bit Raspberry Pi OS Lite** with Raspberry Pi Imager. In the imager's advanced
   settings, set a hostname, a user, your Wi-Fi/SSH details.
2. Give the Pi a **fixed LAN IP** (a DHCP reservation in your router is simplest).
3. Boot from a **USB SSD or an NVMe HAT — not an SD card.** ntfy writes its SQLite cache
   constantly, and SD cards wear out under that write pattern.

## 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

Log out and back in (or reboot) so the group change applies, then check:

```bash
docker --version
docker compose version
```

## 3. Create the Cloudflare Tunnel

1. In **Cloudflare Zero Trust → Networks → Tunnels → Create a tunnel**, choose **Cloudflared**.
2. Copy the **tunnel token** shown on the install page. It is a secret: anyone with it can run
   your tunnel. Do not paste it into chat, git, or a screenshot.
3. Add a **Public Hostname**:
   - Subdomain: `ntfy`
   - Domain: your domain
   - Service: `HTTP`
   - URL: `ntfy:80`

   `ntfy:80` is the compose service name and ntfy's container port. Do not use `localhost`,
   `127.0.0.1` or a published host port — those point at the cloudflared container itself.

## 4. Start it on the Pi

1. Copy this `selfhost` folder to the Pi (for example with `scp -r`).
2. Create the env file and fill in both values:
   ```bash
   cd selfhost
   cp .env.example .env
   nano .env
   ```
   `NTFY_BASE_URL=https://ntfy.yourdomain.com` and `TUNNEL_TOKEN=<the token from step 3>`.
3. Create the data folder owned by the user ntfy runs as (uid 1000). Without this the cache
   file cannot be written and the container exits:
   ```bash
   sudo mkdir -p data
   sudo chown -R 1000:1000 data
   ```
4. Start both services:
   ```bash
   docker compose up -d
   ```
5. Both containers should be up: `docker compose ps`.

## 5. Verify

1. Watch the ntfy log for startup errors:
   ```bash
   docker compose logs -f ntfy
   ```
2. Open `https://ntfy.yourdomain.com/v1/health`. It must return:
   ```json
   {"healthy":true}
   ```
3. Optional end-to-end check (topic is a password, so use your real one only on your own
   machine):
   ```bash
   curl -d "test" https://ntfy.yourdomain.com/<your-topic>
   ```

## 6. Point the project at it

1. Store the server URL as a Worker secret:
   ```powershell
   npx wrangler secret put NTFY_SERVER
   ```
   Paste `https://ntfy.yourdomain.com` at the prompt. A secret takes effect without a redeploy.
2. `NTFY_TOPIC` stays the same. **Delete `NTFY_TOKEN`**, because it belongs to your ntfy.sh
   account and this instance runs without auth:
   ```powershell
   npx wrangler secret delete NTFY_TOKEN
   ```
   If you later enable auth on the Pi, create a token there and set `NTFY_TOKEN` again.
3. Send a test request from the extension and confirm the notification arrives.

## 7. Phone app

1. In the ntfy app, **Add server** → `https://ntfy.yourdomain.com`.
2. Subscribe to the **same topic** the Worker uses.
3. Remove the old `ntfy.sh` subscription so you do not get duplicate or stale notifications.

## 8. Updates and backups

- Update both images:
  ```bash
  docker compose pull && docker compose up -d
  ```
- Back up by copying `selfhost/data/cache.db` while the stack is stopped. This is only a
  message cache, so losing it costs you message history, not configuration.

## 9. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `ntfy` container exits, or log shows permission denied on `cache.db` | The data folder is not writable by uid 1000. Run `sudo chown -R 1000:1000 data` in `selfhost/`, then `docker compose up -d`. |
| Cloudflare returns 502 | cloudflared cannot reach `ntfy:80`. Check `docker compose ps` shows both containers up, and that the public hostname URL is exactly `ntfy:80`. |
| Notifications arrive late or in bursts | Confirm `NTFY_BEHIND_PROXY=true` is set, and stop the Pi from sleeping (disable Wi-Fi power saving, keep it on mains power). |
| Worker log shows `status 401` | A stale `NTFY_TOKEN` is being sent to a server without auth. Run `npx wrangler secret delete NTFY_TOKEN`. |
