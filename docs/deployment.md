# Deployment

**Bare metal is the primary, recommended scenario** — EAVexa has zero required
dependencies beyond Node.js, Playwright's bundled Chromium, and the bundled
`ffmpeg-static` binary. Docker is supported and covered below, but it's the secondary
path — nothing here requires it, and running `n8n` and `eavexa` as two plain OS
processes on the same machine is simpler to operate and debug.

Run `eavexa doctor` after any install to confirm Chromium, FFmpeg, and the configured
directories are all usable before wiring anything up to n8n.

## Install

```bash
git clone <repo> && cd EAVexa
npm ci --omit=dev
npx playwright install chromium
cp .env.example .env      # edit as needed — every variable has a working default
eavexa doctor
```

## Running as a service

`eavexa serve` is a plain foreground process — it needs a supervisor to survive a
terminal closing, a crash, or a reboot. Pick whichever fits your OS:

### Linux — systemd

```ini
# /etc/systemd/system/eavexa.service
[Unit]
Description=EAVexa render service
After=network.target

[Service]
Type=simple
User=eavexa
Group=eavexa
WorkingDirectory=/opt/eavexa
ExecStart=/usr/bin/node /opt/eavexa/src/cli/cli.js serve
EnvironmentFile=-/opt/eavexa/.env
Restart=on-failure
RestartSec=5
# Chromium needs a real /dev/shm; if this host's is small, either mount a larger
# tmpfs at /dev/shm or leave shm alone and rely on CHROME_SANDBOX=auto working as
# expected on bare metal (no --disable-dev-shm-usage needed outside containers).

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now eavexa
sudo systemctl status eavexa
journalctl -u eavexa -f
```

### Windows — Task Scheduler (no extra tooling)

1. Task Scheduler → Create Task…
2. General: name it `EAVexa`; "Run whether user is logged on or not" if you want it up
   without an interactive session.
3. Triggers: New… → "At startup" (and optionally "At log on").
4. Actions: New… → Program/script: `node.exe` (full path, e.g.
   `C:\Program Files\nodejs\node.exe`) → Arguments: `src\cli\cli.js serve` → Start in:
   the project directory (e.g. `S:\Daedalus\Aureum\EAVexa`).
5. Settings: check "Restart the task if it fails", every 1 minute, up to 3 times.

### Windows — NSSM (nicer service semantics, proper stdout/stderr log files)

```powershell
nssm install EAVexa "C:\Program Files\nodejs\node.exe" "src\cli\cli.js serve"
nssm set EAVexa AppDirectory "S:\Daedalus\Aureum\EAVexa"
nssm set EAVexa AppStdout "S:\Daedalus\Aureum\EAVexa\data\logs\eavexa.out.log"
nssm set EAVexa AppStderr "S:\Daedalus\Aureum\EAVexa\data\logs\eavexa.err.log"
nssm set EAVexa AppEnvironmentExtra EAVEXA_PORT=8123 EAVEXA_HOST=127.0.0.1
nssm start EAVexa
```

### Any OS — pm2

```bash
npm install -g pm2
pm2 start src/cli/cli.js --name eavexa -- serve
pm2 save
pm2 startup      # prints (and can run) the OS-specific boot-time command
```

## Configuration for a real deployment

Defaults are safe for "just try it on localhost." Before pointing n8n at this for real,
decide on:

| Setting | Recommendation |
| --- | --- |
| `EAVEXA_API_KEY` | Set one even on localhost — cheap insurance, and required if `EAVEXA_HOST` is ever changed from `127.0.0.1`. |
| `EAVEXA_HOST` | Keep `127.0.0.1` unless n8n runs on a different host or in a separate container (see below). |
| `WEBHOOK_SECRET` | Set one so outgoing webhooks carry `X-EAVexa-Signature` — cheap, and n8n's Webhook node can verify it if you want to. |
| `OUTPUT_DIR` | Fine as default (`data/outputs`) for same-host n8n. Only relevant to change for the Docker case below. |
| Retention | Nothing is deleted automatically (`docs/specification.md` §3/§Р3). Schedule `eavexa jobs prune --older-than 30d` (Task Scheduler / cron) if you don't want `data/outputs` and `data/jobs` growing forever. |

Then read `docs/n8n.md` to wire up the actual workflows.

## Docker (secondary)

A `Dockerfile` and `docker-compose.yml` are provided at the repo root. Key points if you
adapt them:

- Base image `mcr.microsoft.com/playwright:v1.60.0-jammy` matches the `playwright` npm
  version in `package.json` — Chromium is already installed in the image, so there's no
  `npx playwright install` step at build time. If you bump the `playwright` dependency,
  bump the base image tag to match.
- `shm_size: 1gb` and `init: true` — Chromium needs real shared memory in a container
  (the default Docker `/dev/shm` is 64 MB and Chromium will crash under load without
  this), and `init: true` reaps zombie processes from Chromium/FFmpeg child processes.
- `CHROME_SANDBOX=auto` (the default) already detects `/.dockerenv` and disables the
  sandbox only inside a container — no image-specific config needed.
- For n8n to read result files via `result.path`, mount the **same path** in both
  containers (see `docker-compose.yml` — both mount `eavexa_output` at `/data/outputs`).
  If the paths can't match, set `OUTPUT_DIR_ALIAS` on the `eavexa` service to whatever
  path the *other* container sees.
- On the n8n side, set `N8N_DEFAULT_BINARY_DATA_MODE=filesystem` — without it, n8n keeps
  binaries in memory for the whole execution, which is a problem for anything beyond
  small images.

```bash
docker compose up -d --build
docker compose exec eavexa node src/cli/cli.js doctor
```

Everything else — the routes, auth, webhook mechanics — is identical to bare metal.
