# Self-hosted ntfy on a Raspberry Pi 5

Run your own ntfy instead of `ntfy.sh`, reachable at `https://ntfy.yourdomain.com`
through a Cloudflare Tunnel. One tunnel serves ntfy now and any other service you add to the
Pi later.

ntfy runs in Docker and is published on `127.0.0.1:2586` only. `cloudflared` runs on the host
as a systemd service and forwards `https://ntfy.yourdomain.com` to that address. Nothing is
exposed on your LAN.

Files here:

```text
docker-compose.yml   ntfy only, loopback port 2586
.env.example         template; copy to .env (git-ignored)
```

`selfhost/data/` is created on the Pi and is git-ignored. Nothing here contains a real domain,
topic or token.

## 1. Prepare the Pi

1. Flash **64-bit Raspberry Pi OS Lite**, set hostname, user, SSH and Wi-Fi in the Imager's
   advanced settings.
2. Give the Pi a **fixed LAN IP** (a DHCP reservation in your router is simplest).
3. An SD card works for a light workload. A USB SSD or NVMe HAT is better if you expect heavy
   use, because ntfy writes its SQLite cache constantly.

## 2. Point the domain at Cloudflare

The tunnel needs the domain's DNS managed by Cloudflare.

1. Cloudflare dashboard → **Add a site** → your domain → **Free**.
2. At your registrar, replace the nameservers with the two Cloudflare gave you.
3. Wait for the zone to show **Active**. Check the real delegation at any time:
   ```powershell
   nslookup -type=NS yourdomain.com a.dns.pt
   ```

## 3. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

Log out and back in, then check `docker --version`.

## 4. Create the tunnel and run cloudflared

1. **Activate Zero Trust** (free plan, up to 50 users). Cloudflare may ask for a card to verify
   the account; there is no charge on the free plan.
2. Zero Trust → Networks → Tunnels → **Create a tunnel** → **Cloudflared** → name it `ntfy`.
3. Copy the **token** shown on the install page. It is a secret.
4. Add a **public hostname**:
   - Subdomain: `ntfy`
   - Domain: your domain
   - Service: `HTTP`
   - URL: `127.0.0.1:2586`

   Adding this hostname creates the DNS record. Do not add a CNAME by hand.
5. Install cloudflared on the Pi and register the service with the token:
   ```bash
   curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -o /tmp/cloudflared.deb
   sudo dpkg -i /tmp/cloudflared.deb
   sudo cloudflared service install <TOKEN>
   sudo systemctl status cloudflared --no-pager
   ```

The service reads its config from the token, so there is no `config.yml` to maintain.

**Adding another service later:** bind it to `127.0.0.1:<port>`, then add a public hostname on
the same tunnel pointing at `127.0.0.1:<port>`. No tunnel changes, no restart.

**Alternative without Zero Trust:** `cloudflared tunnel login`, then
`cloudflared tunnel create ntfy` and `cloudflared tunnel route dns ntfy ntfy.yourdomain.com`,
with a `config.yml` under `/etc/cloudflared/`. Same tunnel, managed on the Pi instead of in the
browser.

## 5. Start ntfy

1. Copy this `selfhost` folder to the Pi (for example `scp -r`).
2. Create the env file:
   ```bash
   cd selfhost
   cp .env.example .env
   nano .env
   ```
   Set `NTFY_BASE_URL=https://ntfy.yourdomain.com`. `TUNNEL_TOKEN` is unused when cloudflared
   runs as a host service.
3. Create the data folder owned by the user ntfy runs as (uid 1000). Without this the cache
   file cannot be written and the container exits:
   ```bash
   sudo mkdir -p data
   sudo chown -R 1000:1000 data
   ```
4. Start it:
   ```bash
   docker compose up -d
   docker compose ps
   ```
5. Confirm it answers locally:
   ```bash
   curl -s http://127.0.0.1:2586/v1/health
   ```
   Expected: `{"healthy":true}`.

## 6. Verify through the tunnel

From your computer:

```bash
curl -s https://ntfy.yourdomain.com/v1/health
```

If that returns `{"healthy":true}`, the tunnel and ntfy are both working.

## 7. Point the project at it

1. Store the server URL as a Worker secret:
   ```powershell
   npx wrangler secret put NTFY_SERVER
   ```
   Paste `https://ntfy.yourdomain.com`.
2. Set a fresh topic, since the old one was removed:
   ```powershell
   node -e "console.log(require('crypto').randomBytes(16).toString('base64url'))"
   npx wrangler secret put NTFY_TOPIC
   ```
3. Give the Worker an access token (see the auth section below):
   ```powershell
   npx wrangler secret put NTFY_TOKEN
   ```
4. Send a test request from the extension and confirm the notification arrives.

## 7b. Require authentication

The compose file already sets `NTFY_AUTH_FILE` and `NTFY_AUTH_DEFAULT_ACCESS: deny-all`, so
anonymous publishing and reading are refused and the URL alone is useless.

1. Apply the settings:
   ```bash
   cd ~/selfhost
   docker compose up -d
   ```
2. Create an account. It prompts for a password twice:
   ```bash
   docker compose exec ntfy ntfy user add --role=admin martin
   ```
   `--role=admin` can read and write every topic; no per-topic ACL is needed for one person.
3. Create a token for the Worker and copy the `tk_...` value it prints:
   ```bash
   docker compose exec ntfy ntfy token add martin
   ```
4. Store that token on the Worker:
   ```powershell
   npx wrangler secret put NTFY_TOKEN
   ```
5. In the phone app, open the server `https://ntfy.yourdomain.com` and add the same username and
   password. Without it the app gets `401` and shows nothing.

Verify: `curl -s https://ntfy.yourdomain.com/v1/health` still answers (health is public), but
publishing without a token now returns `401`.

## 8. Phone app

1. In the ntfy app, **Add server** → `https://ntfy.yourdomain.com`.
2. Subscribe to the **same topic** the Worker uses.
3. Remove the old `ntfy.sh` subscription so you do not get stale duplicates.

## 9. Updates and backups

- Update the image:
  ```bash
  docker compose pull && docker compose up -d
  ```
- Back up by copying `selfhost/data/cache.db` while the stack is stopped. It is only a message
  cache, so losing it costs message history, not configuration.

## 10. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `ntfy` container exits, or log shows permission denied on `cache.db` | The data folder is not writable by uid 1000. Run `sudo chown -R 1000:1000 data`, then `docker compose up -d`. |
| Cloudflare returns 502 | cloudflared cannot reach ntfy. Check `curl -s http://127.0.0.1:2586/v1/health` on the Pi, and that `config.yml` points at `127.0.0.1:2586`. |
| `cloudflared tunnel route dns` fails | The zone is not active yet. Wait for the nameservers to propagate. |
| `cloudflared` service fails to start | Check `sudo journalctl -u cloudflared -n 50 --no-pager`. Usually a stale or wrong token: re-run `sudo cloudflared service install <TOKEN>`. |
| Notifications arrive late or in bursts | Confirm `NTFY_BEHIND_PROXY=true`, and stop the Pi from sleeping. |
| Worker log shows `status 401` | The instance now requires auth: set `NTFY_TOKEN` with a token from `ntfy token add`, and subscribe in the app with the account credentials. |
