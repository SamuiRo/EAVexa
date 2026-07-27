# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Fixed
- **CI was red on Node 18 and 20: the test suite never started.** `npm test` ran
  `node --test "test/**/*.test.js"`, but `node --test` only expands glob patterns itself
  from Node 21 on — on older runtimes the pattern is taken as a literal path and the job
  dies with `Could not find '<cwd>/test/**/*.test.js'`. `npm test` now goes through
  `scripts/run_tests.mjs`, which walks `test/` and hands `node --test` explicit paths. This
  also fixes `npm test` on Windows, where no shell expands the glob either.
- **Eight browser- and server-backed test files ran without their setup on Node 20 and
  older.** Their `before`/`after` hooks sat at the file top level, and root-level hooks are
  not awaited before the first test on those runtimes (verified: fails on 20.14, works on
  21.7 and 22.17) — so every test in them hit an unconnected renderer
  (`Call connect() before render_html()`) and the run then hung on the Chromium instance the
  hook had opened in the background. The hooks now live inside a `describe()` block, which
  behaves identically on every supported runtime. Suite is 131/131 green on Node 20 and 22.
- **`<video preload="none">` stalled every render for the full `VIDEO_TAG_TIMEOUT_MS`
  and then rendered nothing.** The metadata wait listened for `loadedmetadata` without
  ever kicking the load off, and `preload="none"` means the browser never fetches
  metadata on its own — so the event never fired, the wait always timed out (measured
  ~5.8s vs ~0.8s per render), `duration` stayed unknown, and every frame captured an
  empty video element. Non-skipped videos are now switched to `preload="auto"` and
  `load()`ed before the wait.
- **The last frame of a video render wrapped back to the clip's first frame.** Per-frame
  seeking used `time_s`, which `_build_frame_state` spans over `[0, duration]` *inclusive*
  — so the final frame lands exactly on `duration` and `duration % clip_duration` is `0`
  whenever the clip is as long as the render (or divides it). It also spaced samples
  `duration/(total_frames - 1)` apart instead of `1/fps`, drifting video content off
  real time. Seeking now uses `frame_time_s` (`frame / fps`), which never reaches the
  endpoint and matches playback speed. CSS animations still follow `time_s`.
- **Inline HTML sources could not resolve local assets.** `source.base_dir` was passed
  through as a raw filesystem path, producing an unusable `<base href="C:\...">` and
  skipping the `file://` origin priming added in 2.0.2 — so the fix below never reached
  `source.html` requests. Local `base_dir` values are now converted to `file://` URLs for
  every source kind; values that are already URLs (a remote base for inline HTML) pass
  through untouched.

## [2.0.2] - 2026-07-26

### Added
- Deterministic `<video>` tag rendering. `<video>` elements embedded in a template
  are now paused, muted, and taken off `autoplay`/`loop` on load, then seeked to
  `time_s % video.duration` before every captured frame (looping short clips instead
  of freezing on their last frame) and awaited on the `seeked` event so the screenshot
  never races a still-decoding frame. Image jobs freeze `<video>` on its first frame,
  matching how CSS animations are already frozen at `t=0` for PNG output. Opt a video
  out of automatic control with `data-eavexa-skip`. New `VIDEO_TAG_TIMEOUT_MS` (default
  `5000`ms) bounds the metadata-load wait and, capped at 2000ms, the per-frame seek
  wait. See [docs/video_rendering.md](docs/video_rendering.md#video-elements-video-tag).

### Fixed
- **Local `<img>`, `<video>`, and other relative-path assets never actually loaded.**
  `page.setContent()` leaves the document at `about:blank`; a `<base href="file://...">`
  tag does not change that, and Chromium refuses "local resource" loads for any
  subresource a non-`file://` document requests — every relative asset silently failed
  (`naturalWidth: 0` for images, `MEDIA_ELEMENT_ERROR` for video) regardless of the
  documented `images/`/`fonts/`/`videos/` folder convention. Fixed by navigating the
  page to its own template directory (`file://...`) before `setContent()`, which keeps
  that as the document URL so relative local assets resolve normally. Registry, `--file`,
  and `jobs.json` sources are all affected and now fixed; remote (`http(s)`) sources were
  never affected.

## [2.0.1] - 2026-07-26

Fixes for issues found in `docs/audit_2.0.0.md`.

### Fixed
- **Async `result.url` was broken (404) prior to 2.0.1.** It was built from `render_id`
  while the job record was stored under a different `job_id`, so following the link
  from a webhook payload always 404'd — the exact scenario the async contract exists
  for. Sync requests were unaffected (their `render_id` and job record id coincide).
  Artifacts on disk are also now stored under the id a job record actually resolves
  by, fixing `outputs/<date>/<id>/...` not matching any job (A1, A8).
- Video rendering wrote log lines to stdout, corrupting `--json` output and raw
  `-o -` byte streams for every video render (A2).
- `templates/` shipped empty — every named-template example in the README and docs,
  including the first n8n workflow a user is meant to import, failed with
  `TEMPLATE_NOT_FOUND`. Added a working `story_pricing_pro` template (A3). Also added
  `promo` — the animated video template referenced by `docs/n8n/async_video.json` and
  the video examples throughout the CLI/API docs, which had no template behind it
  either; it choreographs its reveal entirely from `--eavexa-progress`/
  `--eavexa-time-ms` (no `@keyframes`), so it adapts to whatever `video.duration` a
  request asks for.
- Async + `output.type: "base64"` had no size limit, so a large artifact produced an
  oversized webhook body that a receiver like n8n would reject. Added
  `CALLBACK_INLINE_MAX_BYTES` (default 256 KiB) with automatic downgrade to a link
  (`data: null`, `downgraded_from: "base64"`) — sync requests are unaffected (A4).
- `eavexa doctor` reported `OK` for template directories without checking they
  existed, and gave no visibility into how many templates were actually found (A5).
- A render that hit its timeout or was cancelled kept running in the background
  instead of stopping, letting concurrency exceed `RENDER_CONCURRENCY`/
  `VIDEO_CONCURRENCY` under a burst of timeouts (A7, partial: the lane slot is now
  held until the render actually finishes; full mid-render cancellation is still open).
- Startup job recovery (`orphaned_running()`/`pending_callbacks()`) scanned every job
  ever written, growing without bound since job records are never deleted. Bounded to
  the last `JOB_RECOVERY_WINDOW_DAYS` (default 7) (A6).
- HTTP renders normalized the request twice per call (once to decide sync/async, once
  again inside `submit()`/`render()`), doubling template resolution work (A9).

### Removed
- Dead code: `render_file()`/`render_batch()` in both renderers, unreachable since
  `RenderService` became the only render path (A10).

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
