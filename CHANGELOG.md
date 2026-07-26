# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [2.0.0] - 2026-07-26

Pipeline-integration rewrite (`docs/specification.md`) — EAVexa grows from a single
`data/jobs.json` batch runner into one core (`RenderService`) shared by three
front-ends: the legacy batch runner, a new `eavexa` CLI, and an HTTP API. Delivered in
six steps (Крок 0-5); see `docs/specification.md` §16 for the full plan and what's
still deliberately out of scope (S3/push storage drivers, `/metrics`, rate limiting —
Крок 6).

### Added
- **CLI (`eavexa`)** — `render`, `batch`, `templates`, `formats`, `doctor`, `jobs`,
  `serve` commands; strict stdout/stderr discipline (`--json` gives exactly one JSON
  object on stdout, everything else on stderr); `-o -` streams raw bytes.
- **Core render pipeline** (`src/core/`) — `normalize_request()` unifies CLI flags,
  HTTP bodies, and `jobs.json` entries into one shape; `RenderQueue` (independent
  image/video concurrency lanes); `BrowserPool` (lazy Chromium, scheduled restarts);
  `StorageAdapter` (atomic local writes, SHA-256 checksums, `OUTPUT_DIR_ALIAS`);
  `TemplateRegistry`/`template_manifest.js` (named templates with a `template.json`
  schema, or automatic inference from `{{KEY}}` placeholders). `RenderError` gives
  every front-end one consistent error code / HTTP status / CLI exit code table.
- **Async jobs & webhooks** — `RenderService.submit()`/`.cancel()`, a durable
  `FileJobStore` (one JSON file per job, survives a restart), and `WebhookNotifier`
  (HMAC-signed `render.completed`/`render.failed` deliveries with backoff retries).
  Crash recovery: a job left `running`/`queued` by a killed process is detected on
  the next `start()` and turns into a delivered `render.failed(INTERRUPTED)` webhook.
- **HTTP API (`eavexa serve`)** — `POST /v1/render`, `POST /v1/templates/:name/render`,
  `GET`/`DELETE /v1/jobs/*` (streamed results with `Range`/`ETag`/`304`, signed
  `?token=` links), `GET /v1/templates/*`, `/v1/formats`, `/v1/version`, `/healthz`,
  `/readyz`. `Idempotency-Key` support, graceful shutdown that drains the render queue
  before closing the browser pool. This is the first genuinely non-blocking
  integration point for n8n (`POST /v1/render` returns `202` immediately for requests
  that qualify as async).
- Deployment docs (`docs/deployment.md`) for bare metal (systemd/NSSM/Task
  Scheduler/pm2) and Docker (`Dockerfile`, `docker-compose.yml`), plus `docs/n8n.md`
  with importable workflow JSON for both the sync and async integration patterns.
- `docs/api.md`, `docs/openapi.yaml`, `docs/cli.md`, manifest docs in `docs/templates.md`.
- Test suite: `node --test`, 116 tests covering the core, CLI, and HTTP server
  end-to-end — real Chromium renders, a real local webhook receiver, a real spawned
  `eavexa serve` process for the auth tests, and a direct test of the crash-recovery
  path (a job manually left `running` gets picked up and its webhook fires).
- CI (GitHub Actions): syntax-check → test on Node 18/20/22, plus a release job that
  cuts a GitHub Release from this file's per-version section on `v*` tags.

### Fixed
- `deviceScaleFactor` was silently ignored (`newContext({ device_scale_factor })` —
  wrong casing for Playwright's actual option) — PNGs rendered at half the reported
  resolution. Now covered by a regression test that checks the *actual* PNG pixel size.
- `base_url` was a no-op for image renders (`setContent(html, { url })` isn't a real
  option) — relative asset paths didn't resolve. Fixed via `<base href>` injection.
- Template variable substitution used raw `replaceAll` with no escaping — a value
  containing `<`/`&`/etc. could break the HTML or inject markup. `{{KEY}}` is now
  escaped by default; `{{{KEY}}}` is the explicit raw-HTML opt-in.
- No render timeouts — a template stuck on `networkidle` (e.g. a polling widget)
  could hang forever. `NETWORK_TIMEOUT_MS`/`FONT_TIMEOUT_MS` now bound both.
- `CHROME_PATH` defaulted to a Linux-only path (`/opt/google/chrome/chrome`),
  breaking Windows/macOS. Defaults to `null` (Playwright's own bundled Chromium);
  `--no-sandbox` is now only added inside a detected container (`CHROME_SANDBOX=auto`).
- Image/video batch jobs rendered strictly one after another even across types — a
  slow video blocked queued images. Now split across independent concurrency lanes.

### Changed
- `npm start` is now a one-line alias for `eavexa batch` — the legacy `data/jobs.json`
  workflow's real implementation lives in `cli/commands/batch.js`, no duplicated logic.
- `ImageRenderer.js` → `src/modules/renderer/image_renderer.js` (naming convention).
- `shared/utils.js` renamed to the snake_case API documented in `CLAUDE.md`
  (`save_json`, `load_json`, `retry`, `chunk`, `format_bytes`, …); write helpers now
  throw on failure instead of silently logging and returning as if nothing happened.

## [1.2.0] - 2026-06-23

Documentation pass and orchestrator cleanup on top of the 1.x batch renderer.

## [1.1.0] - 2026-06-22

Added video rendering: deterministic PNG-frame capture driven by
`window.eavexa_render_frame(...)`, encoded with FFmpeg.

## [1.0.0] - 2026-05-14

Initial release: render PNG images from HTML templates via Playwright, driven by
`data/jobs.json`.
