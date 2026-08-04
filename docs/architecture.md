# Architecture

EAVexa is a Node.js ESM application. It renders HTML templates through Playwright and optionally encodes video through FFmpeg.

As of Крок 4 (see `docs/specification.md`), all rendering — the `eavexa` CLI, the HTTP
server, and the legacy `data/jobs.json` batch runner alike — goes through one core:
`core/render_service.js`. Async jobs (`--callback-url`, or HTTP requests that qualify)
are durable — a job's record and webhook delivery state live in `core/job_store.js`, not
just in memory, so they survive a process restart (see "Jobs & Webhooks" below).

## Entry Points

`src/cli/cli.js` is the `eavexa` binary (`package.json` → `bin.eavexa`). It routes to one
of `src/cli/commands/{render,batch,templates,formats,doctor,jobs,serve}.js`. See `docs/cli.md`.

`src/server/server.js` (`EAVexaServer`, started via `eavexa serve`) exposes the same core
over HTTP — `POST /v1/render`, `GET /v1/jobs/*`, etc. See `docs/api.md`. Every HTTP request
goes through the identical `normalize_request()` → `RenderService.render()`/`.submit()`
path the CLI uses; the server adds routing, auth, streaming, and lifecycle on top.

`src/index.js` (`npm start`) is now a one-line alias for `eavexa batch` — the legacy
`data/jobs.json` workflow lives entirely in `cli/commands/batch.js`:

1. Print the banner.
2. Load and validate jobs (`JobLoader`).
3. Build raw render requests (`RenderJobBuilder`).
4. Submit each request to `RenderService.render()` via `RenderOrchestrator`
   (concurrency between image/video jobs is handled by `core/render_queue.js`, not here).
5. Print render results.
6. Close the browser pool.

## Source Layout

```text
src/
  cli/
    cli.js                   # bin entry, routes argv[2] to a command
    args.js                  # dependency-free flag parser
    output.js                # stdout/stderr discipline (human / --json / -o -)
    commands/
      render.js  batch.js  templates.js  formats.js  doctor.js  jobs.js  serve.js
  server/
    server.js                # EAVexaServer: node:http, lifecycle, graceful shutdown
    router.js                # minimal method+path router with :params
    public_url.js            # resolves the base URL for result.url / poll_url
    idempotency_store.js     # in-memory Idempotency-Key -> response cache
    middleware/
      request_id.js  auth.js  limits.js  errors.js
    routes/
      render.js  jobs.js  templates.js  meta.js
  core/
    render_service.js       # the one render entry point behind every front-end
    render_request.js       # normalize_request(): unifies CLI/HTTP/jobs.json into one shape
    render_queue.js         # two concurrency lanes: image, video
    browser_pool.js         # pools image/video renderer connections, restarts on BROWSER_MAX_RENDERS
    storage_adapter.js      # atomic local writes, checksum, OUTPUT_DIR_ALIAS translation
    template_registry.js    # resolves template names -> manifest + HTML (user_dir overrides builtin_dir)
    template_manifest.js    # parse/infer manifests, validate_vars()
    job_store.js             # one JSON file per async job, sharded by date, atomic writes
    webhook_notifier.js      # HMAC-signed delivery with backoff retries, resumable after restart
    result_token.js          # signed short-lived ?token= for /result links, gated on RESULT_TOKEN_SECRET
    create_render_service.js # wires registry+pool+queue+storage+job_store+notifier — the one place that does
    errors.js                # RenderError + error code table (http_status / exit_code)
    ids.js                   # monotonic sortable IDs (r_/j_/d_ prefixes)
  config/
    app_config.js
    render_config.js
    video_config.js
  modules/
    jobs/
      job_loader.js
      render_job_builder.js
    orchestrator/
      render_orchestrator.js
      render_result_reporter.js
    renderer/
      image_renderer.js
      video_renderer.js
      ffmpeg_encoder.js
  shared/
    messages.js
    utils.js
    logger.js
    html_template.js
    chromium.js
```

## Module Responsibilities

| Module | Responsibility |
| --- | --- |
| `src/index.js` | One-line alias for `eavexa batch` (`npm start`). |
| `cli/cli.js` | `eavexa` bin entry — routes to a command module, top-level `--help`, exit-code mapping. |
| `cli/args.js` | Dependency-free flag parser: `--k v`, `--k=v`, booleans, repeatable flags, short aliases. |
| `cli/output.js` | stdout/stderr discipline: human / `--json` / raw-stdout (`-o -`) modes. |
| `cli/commands/render.js` | `eavexa render` — one-off render from a template/file/url/stdin/full request document. |
| `cli/commands/batch.js` | `eavexa batch` — the `data/jobs.json` workflow (also used by `npm start`). |
| `cli/commands/templates.js` | `eavexa templates list\|show`. |
| `cli/commands/formats.js` | `eavexa formats`. |
| `cli/commands/doctor.js` | `eavexa doctor` — environment/dependency checks, exits `4` on failure. |
| `cli/commands/jobs.js` | `eavexa jobs list\|show\|cancel\|prune\|stats` — inspect/manage async job records. |
| `cli/commands/serve.js` | `eavexa serve` — starts `EAVexaServer`, wires `SIGTERM`/`SIGINT` to graceful shutdown. |
| `server/server.js` | `EAVexaServer` — node:http wrapper: request routing, auth, graceful shutdown, ties every route module together. |
| `server/router.js` | Minimal method+path router with `:param` segments — no dependencies. |
| `server/public_url.js` | Resolves the base URL for `result.url`/`poll_url` (`EAVEXA_PUBLIC_URL`, else `Host`/`X-Forwarded-*`). |
| `server/idempotency_store.js` | In-memory `Idempotency-Key` → response cache, TTL-bounded. |
| `server/middleware/*.js` | `request_id` (X-Request-Id), `auth` (X-API-Key), `limits` (body size + JSON parsing), `errors` (RenderError → §7.7 JSON envelope). |
| `server/routes/render.js` | `POST /v1/render`, `POST /v1/templates/:name/render` — sync/async branching, idempotency, persists a job record for sync HTTP renders too. |
| `server/routes/jobs.js` | `GET /v1/jobs`, `GET /v1/jobs/:id`, `GET /v1/jobs/:id/result` (streamed, Range/ETag), `DELETE /v1/jobs/:id`, `POST /v1/jobs/:id/retry-callback`. |
| `server/routes/templates.js` | `GET /v1/templates`, `GET /v1/templates/:name`, `GET /v1/templates/:name/preview` (serves the static `preview.png`). |
| `server/routes/meta.js` | `GET /v1/formats`, `GET /v1/version`, `GET /healthz`, `GET /readyz`. |
| `core/render_service.js` | The one render entry point: `render()` (sync), `submit()`/`cancel()` (durable async jobs), `start()` (crash recovery). |
| `core/create_render_service.js` | The one place that wires `TemplateRegistry`+`BrowserPool`+`RenderQueue`+`StorageAdapter`+`FileJobStore`+`WebhookNotifier` into a `RenderService`. |
| `core/job_store.js` | `FileJobStore` — one JSON file per job under `data/jobs/<date>/`, atomic writes, LRU cache, cursor-paginated `list()`, `orphaned_running()`/`pending_callbacks()` for restart recovery. |
| `core/webhook_notifier.js` | Delivers `render.completed`/`render.failed` with HMAC signing, backoff retries (1s→5s→20s→60s→300s), blocked-host guards; retry state persists in `job_store` so it survives a restart. `force:true` bypasses the delivered/failed_permanent guard for manual retries. |
| `core/result_token.js` | `sign_result_token()`/`verify_result_token()` — HMAC-signed, expiring `?token=` for `GET /v1/jobs/:id/result`, gated on `RESULT_TOKEN_SECRET`. |
| `core/render_request.js` | `normalize_request()` — turns a raw request (jobs.json entry, CLI flags, HTTP body) into one shape: resolved source, parsed format, validated vars, normalized video, cost/mode, output/options defaults (rejects `output.type: s3\|push` — Крок 6). |
| `core/render_queue.js` | Two independent concurrency lanes (`image`, `video`) so a long video render never blocks queued images. Per-task timeout and `AbortSignal` support. |
| `core/browser_pool.js` | Pools one `image_renderer`/`video_renderer` connection each, lazily connecting, restarting every `BROWSER_MAX_RENDERS` renders. |
| `core/storage_adapter.js` | Local driver: dated (or explicit) directory layout, atomic `.part` → `rename`, streamed SHA-256 checksum, `.meta.json` sidecar, `OUTPUT_DIR_ALIAS` path translation. |
| `core/template_registry.js` | Resolves a template name to its manifest + HTML; user templates override builtin ones; guards against path traversal. |
| `core/template_manifest.js` | Parses `template.json`, infers a manifest from `{{KEY}}` placeholders when absent, validates vars against declared types/`required`/`max_length`. |
| `core/errors.js` | `RenderError` — one error type carrying `code`, `http_status`, and `exit_code` for every front-end. |
| `core/ids.js` | Monotonic, lexicographically sortable IDs (`r_`/`j_`/`d_`) — no dependencies. |
| `config/app_config.js` | Centralized paths and environment-backed configuration. |
| `config/render_config.js` | Predefined image/video dimensions, `WxH@dpr` string parsing, and viewport options. |
| `config/video_config.js` | Supported video output extensions. |
| `modules/jobs/job_loader.js` | Read and validate `data/jobs.json`. |
| `modules/jobs/render_job_builder.js` | Convert user jobs into raw render requests (`{ source, format, vars, video, output }`) for `RenderService`. |
| `modules/orchestrator/render_orchestrator.js` | Thin adapter: submits every raw request to `RenderService.render()`. |
| `modules/orchestrator/render_result_reporter.js` | Print output summaries from `RenderResult` objects. |
| `modules/renderer/image_renderer.js` | Render HTML to PNG. |
| `modules/renderer/video_renderer.js` | Render HTML to PNG frames and request encoding; reports `on_progress` per phase. |
| `modules/renderer/ffmpeg_encoder.js` | Encode PNG frame sequences into video files. |
| `shared/utils.js` | Logging and shared helper utilities (`save_json`, `retry`, `chunk`, `format_bytes`, …). |
| `shared/logger.js` | Structured event logger (`pretty`/`json` via `LOG_FORMAT`), always to stderr — used by `core/` internals. |
| `shared/html_template.js` | Var substitution (`{{KEY}}` escaped / `{{{KEY}}}` raw), `<base href>` and font-preload injection — shared by both renderers. |
| `shared/chromium.js` | Chromium launch args and sandbox policy (`CHROME_SANDBOX`), shared by both renderers. |
| `shared/messages.js` | CLI banner text. |

## Render Flow

Three front-ends build a raw request and hand it to the same `RenderService.render()`:
`eavexa render` (flags -> request), `eavexa batch` / `data/jobs.json` (one request per
job via `RenderJobBuilder`), and `eavexa serve` (`server/routes/render.js`).

```text
data/jobs.json
  -> JobLoader
  -> RenderJobBuilder            (raw render request per job)
  -> RenderOrchestrator
  -> RenderService.render()
       -> normalize_request()     (core/render_request.js)
       -> RenderQueue.enqueue()   (image or video lane)
       -> load HTML (registry / inline / file / url) + apply_vars()
       -> BrowserPool.with_image() / .with_video()
            -> image_renderer.js  -> PNG buffer
            -> video_renderer.js  -> PNG frame sequence -> FfmpegEncoder
       -> StorageAdapter.put() / .finalize()
            -> data/outputs/<job_id>/<output>  (atomic .part -> rename, checksum, .meta.json)
  -> RenderResult { render_id, type, width, height, path, url, checksum, bytes, timings, ... }
```

`image_renderer.js`:

1. Opens Chromium (via `BrowserPool`, lazily on first use).
2. Creates a fresh browser context with the requested viewport and DPR.
3. Navigates to the template's own directory when the base URL is `file://`, so the
   document has a real local origin — `page.setContent()` alone leaves it at
   `about:blank`, where Chromium refuses every local subresource. See
   `prime_local_file_origin()` in `src/shared/chromium.js`.
4. Loads the HTML template (vars already substituted, `<base href>` already injected).
5. Waits for network idle and fonts, each bounded by its own timeout.
6. Pauses, mutes, and freezes every `<video>` on its first frame, bounded by
   `VIDEO_TAG_TIMEOUT_MS` — the counterpart to screenshotting with
   `animations: 'disabled'`. Elements marked `data-eavexa-skip` are left alone.
7. Captures a PNG screenshot.

`video_renderer.js`:

1. Opens Chromium (via `BrowserPool`).
2. Creates a browser context with the requested viewport and DPR.
3. Loads the HTML template, priming the local `file://` origin exactly as above.
4. Pauses and mutes every non-skipped `<video>` and waits for its metadata, so
   `duration` is known before the frame loop starts.
5. For each frame:
   - computes `progress`, `time_s`, and frame metadata;
   - pauses Web Animations and sets their `currentTime`;
   - seeks each `<video>` to `frame_time_s % video.duration` and awaits the `seeked`
     event, so short clips loop and the screenshot never races a decoding frame;
   - calls `window.eavexa_render_frame(...)` when provided;
   - captures `frame_000000.png`, `frame_000001.png`, and so on;
   - reports progress via `on_progress({ phase, current, total, ratio })`.
6. Calls `FfmpegEncoder`, writing directly to a `TMP_DIR` temp path.
7. `RenderService` hands the encoded temp file to `StorageAdapter.finalize()`, which
   moves it into place atomically (with a copy+delete fallback across drives) and
   removes temporary frames unless `keep_frames` is enabled.

## Jobs & Webhooks

`RenderService.submit(raw_request)` is the async counterpart to `render()`: it creates a
durable record via `job_store.create()`, returns immediately with `{ job, done }`, and
runs the actual render in the background through the same `_execute()` used by `render()`.
`done` resolves once the render (and the first webhook delivery attempt, if any) settles.

```text
submit() -> job_store.create(status:'queued')
         -> (background) status:'running' -> _execute() -> status:'done'|'failed'
         -> notifier.notify(job_id, 'render.completed'|'render.failed')
```

Progress updates from `video_renderer.js`'s `on_progress` callback are written straight
to the job record (`job_store.update(id, { progress })`), so polling `jobs show <id>`
mid-render reflects the current phase/ratio.

**Crash recovery** — `RenderService.start()` (called by the CLI at the top of `render`,
`batch`, and `render --watch`) does three things before anything else runs:

1. `job_store.orphaned_running()` — any job still `queued`/`running` was left there by a
   process that died mid-render (there is no other way for that status to persist across a
   restart, since a fresh process starts with an empty in-memory queue). Each one is marked
   `failed` with `error.code: 'INTERRUPTED'`, and its webhook (if any) fires.
2. `notifier.resume_pending()` — jobs whose webhook retry was scheduled by a `setTimeout`
   in a since-exited process (retry timers are `unref()`'d, so they never keep a one-shot
   CLI invocation alive) get a fresh delivery attempt.
3. Orphaned `.eavexa_*` frame directories under `TMP_DIR` are removed.

**Cancellation** — `RenderService.cancel(job_id)` aborts the job's `AbortSignal` (wired
into `RenderQueue.enqueue()`) and waits for the run to actually settle before recording
`status: 'cancelled'`, so a cancel racing against natural completion can never clobber a
successful result. This only works within the process actually executing the job. Since
`eavexa serve` is a single process holding all job state, `DELETE /v1/jobs/:id` is fully
reliable there — the limitation only bites across separate CLI invocations, which don't
share memory.

**Webhook delivery** (`core/webhook_notifier.js`) — HMAC-SHA256 signs
`"<timestamp>.<raw_body>"` into `X-EAVexa-Signature` when `WEBHOOK_SECRET` is set; retries
on network errors, timeouts, `408`/`429`/`5xx` with backoff `1s → 5s → 20s → 60s → 300s`
(`WEBHOOK_MAX_ATTEMPTS`, default 5); any other `4xx` is recorded `failed_permanent`
immediately (no retry). `file:`/`ftp:` URLs and the cloud metadata address
(`169.254.169.254`) are always blocked; `WEBHOOK_ALLOW_PRIVATE`/`WEBHOOK_ALLOWED_HOSTS`
control everything else. Every attempt is appended to `job.callback.attempts[]`.
`POST /v1/jobs/:id/retry-callback` (and the equivalent CLI-less internal call) passes
`force: true`, the one way to re-attempt a `delivered`/`failed_permanent` callback.

## HTTP Server

`EAVexaServer` (`server/server.js`) is a thin `node:http` wrapper: a request comes in,
`server/router.js` matches it to a handler in `server/routes/*.js`, which builds a raw
request and calls `RenderService.render()`/`.submit()` — the exact same core the CLI uses.

A few things exist only at this layer, deliberately kept out of `core/` because they need
an actual inbound HTTP request to make sense:

- **`result.url`** — `core/render_service.js` builds it from
  `request.origin.public_base_url` (see `server/public_url.js`:
  `EAVEXA_PUBLIC_URL` if set, else the request's own `Host`/`X-Forwarded-*`). CLI/jobs.json
  renders never set `origin.public_base_url`, so `result.url` stays `null` for them — this
  is intentional (`docs/decisions.md` §Р2.1), not a bug.
- **A job record for every sync HTTP render.** `server/routes/render.js` persists a
  `done` job keyed by `result.render_id` after a synchronous `POST /v1/render`/
  `POST /v1/templates/:name/render`, purely so the `result.url` it just handed back is a
  real, fetchable `GET /v1/jobs/:render_id/result` link. The CLI and `data/jobs.json`
  paths don't do this — there's no URL to make real.
- **`Idempotency-Key`** (`server/idempotency_store.js`) — an in-memory, TTL-bounded cache
  keyed by the header value alone (no request-body fingerprinting). A repeat within
  `IDEMPOTENCY_TTL_MS` replays the original job/result instead of rendering again.
- **`?token=` on `GET /v1/jobs/:id/result`** (`core/result_token.js`) — an HMAC-signed,
  expiring alternative to `X-API-Key` so a result link can be shared standalone. Disabled
  entirely (never verifies) unless `RESULT_TOKEN_SECRET` is set.
- **Streaming** — `GET /v1/jobs/:id/result` always uses `fs.createReadStream`, supports
  `Range` (`206`) and `ETag`/`If-None-Match` (`304`), and never compresses (there is no
  compression middleware anywhere in this server).
- **Graceful shutdown** — `EAVexaServer.close()` stops accepting new connections
  (`http.Server.close()`), polls `RenderQueue.stats()` until it's empty or
  `SHUTDOWN_GRACE_MS` elapses, then closes the browser pool. Wired to `SIGTERM`/`SIGINT`
  by `cli/commands/serve.js`; idempotent and directly unit-tested (`test/server/shutdown.test.js`)
  rather than relying on OS signal delivery, which is unreliable to script in tests
  (especially on Windows).

## Configuration Rules

Environment variables are centralized in `src/config/app_config.js`. Do not read `process.env` directly in modules.

Current environment-backed settings (see `.env.example`):

| Variable | Purpose |
| --- | --- |
| `CHROME_PATH` | Optional explicit Chromium/Chrome executable path. Defaults to `null` — Playwright's own bundled Chromium is used. |
| `CHROME_SANDBOX` | `auto` (default) \| `on` \| `off`. `--no-sandbox` is only added when `off`, or `auto` and a container is detected (`/.dockerenv`) — never unconditionally on a bare-metal host. |
| `FFMPEG_PATH` | Optional explicit FFmpeg executable path. |
| `NETWORK_TIMEOUT_MS` | Max time to wait for page network activity to settle (default `15000`). Bounds `page.setContent`/`networkidle` so a dead CDN or polling template can't hang the render forever. |
| `FONT_TIMEOUT_MS` | Max time to wait for `document.fonts.ready` (default `5000`). Rendering proceeds with a warning if exceeded. |
| `VIDEO_TAG_TIMEOUT_MS` | Max time to wait for `<video>` elements to load metadata (default `5000`). Also bounds the per-frame seek wait during video jobs, capped at `2000`. Rendering proceeds with a warning if exceeded. |
| `BROWSER_MAX_RENDERS` | Renders per browser kind before `BrowserPool` restarts it (default `200`). |
| `RENDER_CONCURRENCY` / `VIDEO_CONCURRENCY` | `RenderQueue` lane concurrency (default `3` / `1`). |
| `QUEUE_MAX` | Max combined queued+running renders before `QUEUE_FULL` (default `100`). |
| `RENDER_TIMEOUT_MS` | Default per-render timeout enforced by the queue (default `60000`). |
| `SYNC_MAX_COST` | Frame-count threshold above which `normalize_request` marks a request `async` (default `90`). The HTTP server acts on this (auto-picks `202` vs. sync); the CLI doesn't — `eavexa render` always calls `render()` unless `--callback-url` is given, regardless of cost. |
| `MAX_WIDTH` / `MAX_HEIGHT` | Max viewport dimensions (default `4096`). |
| `MAX_VIDEO_DURATION` / `MAX_FPS` / `MAX_FRAMES` | Video limits enforced during request normalization. |
| `OUTPUT_DIR` / `OUTPUT_DIR_ALIAS` | Where artifacts are written, and the path a remote consumer (e.g. n8n in a container) should see instead. |
| `TEMPLATES_DIR` / `BUILTIN_TEMPLATES_DIR` | User and builtin template registry roots. |
| `JOB_STORE_DIR` | Where async job records live, one JSON file per job under a per-day folder (default `data/jobs`). |
| `JOB_CACHE_SIZE` | LRU size for in-memory job records; older ones are re-read from disk (default `500`). |
| `WEBHOOK_SECRET` | HMAC key for `X-EAVexa-Signature`. Unset = unsigned webhooks (logged once as a warning on first delivery attempt). |
| `WEBHOOK_MAX_ATTEMPTS` / `WEBHOOK_TIMEOUT_MS` | Delivery attempts before `failed_permanent` (default `5`), per-attempt timeout (default `10000`). |
| `WEBHOOK_ALLOW_PRIVATE` / `WEBHOOK_ALLOWED_HOSTS` | Allow localhost/LAN webhook targets (default `true` — the common n8n-on-the-same-host case), or restrict to an explicit hostname allowlist. |
| `TMP_DIR` | Where video frames and in-progress encodes live (default `os.tmpdir()`). |
| `TEMPLATE_ALLOWED_HOSTS` | Optional comma-separated allowlist for `source.url` template fetches (SSRF guard). |
| `EAVEXA_PORT` / `EAVEXA_HOST` | `eavexa serve` bind address (default `8123` / `127.0.0.1`). |
| `EAVEXA_API_KEY` | If set, every `/v1/*` route requires a matching `X-API-Key`. Unset = open access. |
| `EAVEXA_PUBLIC_URL` | Overrides the inferred base URL for `result.url`/`poll_url` — needed behind a reverse proxy or in a container where `Host` isn't reliable. |
| `MAX_BODY_MB` | Max HTTP request body size before `PAYLOAD_TOO_LARGE` (default `10`). |
| `SHUTDOWN_GRACE_MS` | How long graceful shutdown waits for in-flight renders (default `30000`). |
| `IDEMPOTENCY_TTL_MS` | `Idempotency-Key` replay window (default `600000` = 10 min). |
| `RESULT_TOKEN_SECRET` | HMAC key for signed `?token=` result links. Unset = `?token=` never verifies. |
| `LOG_FORMAT` / `LOG_LEVEL` | `shared/logger.js` output format (`pretty`\|`json`) and minimum level. |

## Adding A New Output Format

For a new image size:

1. Add a key to `FORMATS` in `src/config/render_config.js`.
2. Use that key in `data/jobs.json`.

For a new video container:

1. Add the extension to `VIDEO_OUTPUT_EXTENSIONS` in `src/config/video_config.js`.
2. Add codec arguments in `FfmpegEncoder._build_codec_args()`.
3. Document the new extension in `docs/jobs.md` and `docs/video_rendering.md`.

## Design Principles

- Keep `src/index.js` thin.
- Keep PNG rendering stable and backwards compatible.
- Add video behavior as an opt-in job feature.
- Keep config validation early and explicit.
- Keep rendering deterministic wherever possible.
- Prefer local assets for repeatable output.

## Tests

```bash
npm test
```

`scripts/run_tests.mjs` collects every `*.test.js` under `test/` (recursively) and runs
them through `node --test` as explicit paths — `node --test` only expands glob patterns
itself from Node 21 on, and the project supports Node >= 18.

Suites that need setup (a Chromium instance, a live HTTP server, a temp fixture) keep their
`before`/`after` hooks **inside** a `describe()` block. Root-level hooks are not awaited
before the first test on Node 20 and older: the tests run against unconnected objects and
the process then hangs on whatever the hook opened. Coverage:

- unit tests for `shared/html_template.js` (var escaping, `{{{RAW}}}`, `<base href>`
  injection), `RenderJobBuilder`/`JobLoader` validation, `core/ids.js`, `core/errors.js`;
- `core/render_queue.js` — lane concurrency, `QUEUE_FULL`, `RENDER_TIMEOUT`, cancellation;
- `core/storage_adapter.js` — atomic writes, checksum, dated vs. explicit layout,
  `OUTPUT_DIR_ALIAS` translation;
- `core/template_registry.js` — manifest parsing, inference, user/builtin precedence,
  path-traversal rejection;
- `core/render_service.js` — end-to-end renders (registry and file sources) through a
  real Chromium instance, plus error-code mapping (`MISSING_REQUIRED_VAR`, `UNKNOWN_FORMAT`);
- `core/job_store.js` — atomic writes, disk fallback when the LRU cache evicts an entry,
  cursor pagination, `pending_callbacks()`/`orphaned_running()` queries;
- `core/webhook_notifier.js` — HMAC signature correctness, retryable vs.
  `failed_permanent` 4xx, backoff-then-succeed retry, blocked protocols, `resume_pending()`
  — against a real local `http.createServer`, no mocking;
- `core/render_service_jobs.test.js` — `submit()`/`cancel()` end-to-end, and **the Крок 3
  acceptance scenario**: a job record manually left in `status: 'running'` (simulating a
  killed process) is picked up by a fresh `RenderService.start()` and turns into a
  delivered `render.failed(INTERRUPTED)` webhook;
- `cli/args.js` — flag parsing (aliases, booleans, repeated flags, `--`);
- `cli/commands/render.js` — spawns the real `eavexa` binary as a child process and
  asserts the actual stdout/stderr split for `--json` and `-o -`, plus exit codes;
- `cli/commands/jobs.js` — `render --callback-url` followed by `jobs list/show/stats/prune`
  through the real CLI binary, including that `--dry-run` prunes nothing;
- `server/router.js` — path-param extraction, `method_not_allowed` vs. no-match, static
  vs. dynamic segment precedence;
- `server/server.test.js` — a real `EAVexaServer` hit with `fetch`: sync binary/base64/path
  responses with correct headers, `result.url` round-tripping back through
  `GET /v1/jobs/:id/result`, async `202` → webhook delivery, `Range`/`ETag`/`304`,
  `Idempotency-Key` replay, `DELETE` cancel-vs-delete, `output.type: s3` rejection, and
  `retry-callback` bypassing the `failed_permanent` guard;
- `server/shutdown.test.js` — `close()` drains an in-flight render before closing the
  browser pool, gives up cleanly after `grace_ms` when nothing's running, and is safe to
  call twice — tested by calling the method directly rather than sending OS signals;
- `server/auth.test.js` — a real `eavexa serve` child process with `EAVEXA_API_KEY` set:
  401 without/with-wrong key, 200 with the right one, `/healthz` staying open, and a
  `?token=` signed with `RESULT_TOKEN_SECRET` substituting for the key on `/result`;
- an integration smoke test that renders real PNGs and checks the **actual** pixel
  dimensions — the regression check for the DPR bug described in `docs/specification.md`
  §12 (B1).
