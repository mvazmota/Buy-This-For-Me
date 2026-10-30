# Self-hosted ntfy on a Raspberry Pi 5

Run your own ntfy instead of `ntfy.sh`, reachable at `https://ntfy.yourdomain.com`
through a Cloudflare Tunnel. The tunnel is created with the `cloudflared` CLI, so it needs
**no Zero Trust plan and no card**.

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

## 4. Install cloudflared and create the tunnel

```bash
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -o /tmp/cloudflared.deb
sudo dpkg -i /tmp/cloudflared.deb
cloudflared --version
```

1. Authorise the CLI. It prints a URL:
   ```bash
   cloudflared tunnel login
   ```
   Open that URL on your computer, log in, and pick your domain. It writes
   `~/.cloudflared/cert.pem` on the Pi.
2. Create the tunnel and its DNS record:
   ```bash
   cloudflared tunnel create ntfy
   cloudflared tunnel route dns ntfy ntfy.yourdomain.com
   ```
   The create step prints a tunnel UUID and writes `~/.cloudflared/<UUID>.json`. Keep that file
   private: it is the tunnel's credential.

## 5. Start ntfy

1. Copy this `selfhost` folder to the Pi (for example `scp -r`).
2. Create the env file:
   ```bash
   cd selfhost
   cp .env.example .env
   nano .env
   ```
   Set `NTFY_BASE_URL=https://ntfy.yourdomain.com`. `TUNNEL_TOKEN` is unused with this setup.
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

## 6. Run cloudflared as a service

1. Write `/etc/cloudflared/config.yml`. Replace `<UUID>` and the username:
   ```yaml
   tunnel: ntfy
   credentials-file: /home/YOUR_USER/.cloudflared/<UUID>.json
   ingress:
     - hostname: ntfy.yourdomain.com
       service: http://127.0.0.1:2586
     - service: http_status:404
   ```
2. Install and start the service:
   ```bash
   sudo cloudflared service install
   sudo systemctl enable --now cloudflared
   sudo systemctl status cloudflared --no-pager
   ```
3. Test from your computer:
   ```bash
   curl -s https://ntfy.yourdomain.com/v1/health
   ```

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
3. Delete the old ntfy.sh access token, which this instance does not use:
   ```powershell
   npx wrangler secret delete NTFY_TOKEN
   ```
4. Send a test request from the extension and confirm the notification arrives.

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
| `cloudflared` service fails to start | Check `sudo journalctl -u cloudflared -n 50 --no-pager`. Usually a wrong `credentials-file` path. |
| Notifications arrive late or in bursts | Confirm `NTFY_BEHIND_PROXY=true`, and stop the Pi from sleeping. |
| Worker log shows `status 401` | A stale `NTFY_TOKEN` is being sent to a server without auth. Run `npx wrangler secret delete NTFY_TOKEN`. |
