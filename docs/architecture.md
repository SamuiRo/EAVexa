# Architecture

EAVexa is a Node.js ESM application. It renders HTML templates through Playwright and optionally encodes video through FFmpeg.

As of Крок 2 (see `docs/specification.md`), all rendering — the `eavexa` CLI, and the
legacy `data/jobs.json` batch runner alike — goes through one core:
`core/render_service.js`. The HTTP front-end (Крок 4) will call the same
`RenderService.render()` used here.

## Entry Points

`src/cli/cli.js` is the `eavexa` binary (`package.json` → `bin.eavexa`). It routes to one
of `src/cli/commands/{render,batch,templates,formats,doctor}.js`. See `docs/cli.md`.

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
      render.js  batch.js  templates.js  formats.js  doctor.js
  core/
    render_service.js       # the one render entry point behind every front-end
    render_request.js       # normalize_request(): unifies CLI/HTTP/jobs.json into one shape
    render_queue.js         # two concurrency lanes: image, video
    browser_pool.js         # pools image/video renderer connections, restarts on BROWSER_MAX_RENDERS
    storage_adapter.js      # atomic local writes, checksum, OUTPUT_DIR_ALIAS translation
    template_registry.js    # resolves template names -> manifest + HTML (user_dir overrides builtin_dir)
    template_manifest.js    # parse/infer manifests, validate_vars()
    create_render_service.js # wires registry+pool+queue+storage — the one place that does
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
| `core/render_service.js` | The one render entry point: loads the template, applies vars, renders via the browser pool, stores the artifact, builds the result. |
| `core/create_render_service.js` | The one place that wires `TemplateRegistry`+`BrowserPool`+`RenderQueue`+`StorageAdapter` into a `RenderService`. |
| `core/render_request.js` | `normalize_request()` — turns a raw request (jobs.json entry, future CLI/HTTP body) into one shape: resolved source, parsed format, validated vars, normalized video, cost/mode, output/options defaults. |
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
job via `RenderJobBuilder`), and — once Крок 4 lands — the HTTP API.

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
3. Loads the HTML template (vars already substituted, `<base href>` already injected).
4. Waits for network idle and fonts, each bounded by its own timeout.
5. Captures a PNG screenshot.

`video_renderer.js`:

1. Opens Chromium (via `BrowserPool`).
2. Creates a browser context with the requested viewport and DPR.
3. Loads the HTML template.
4. For each frame:
   - computes `progress`, `time_s`, and frame metadata;
   - pauses Web Animations and sets their `currentTime`;
   - calls `window.eavexa_render_frame(...)` when provided;
   - captures `frame_000000.png`, `frame_000001.png`, and so on;
   - reports progress via `on_progress({ phase, current, total, ratio })`.
5. Calls `FfmpegEncoder`, writing directly to a `TMP_DIR` temp path.
6. `RenderService` hands the encoded temp file to `StorageAdapter.finalize()`, which
   moves it into place atomically (with a copy+delete fallback across drives) and
   removes temporary frames unless `keep_frames` is enabled.

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
| `BROWSER_MAX_RENDERS` | Renders per browser kind before `BrowserPool` restarts it (default `200`). |
| `RENDER_CONCURRENCY` / `VIDEO_CONCURRENCY` | `RenderQueue` lane concurrency (default `3` / `1`). |
| `QUEUE_MAX` | Max combined queued+running renders before `QUEUE_FULL` (default `100`). |
| `RENDER_TIMEOUT_MS` | Default per-render timeout enforced by the queue (default `60000`). |
| `SYNC_MAX_COST` | Frame-count threshold above which `normalize_request` marks a request `async` (default `90`) — informational until Крок 3's job queue exists. |
| `MAX_WIDTH` / `MAX_HEIGHT` | Max viewport dimensions (default `4096`). |
| `MAX_VIDEO_DURATION` / `MAX_FPS` / `MAX_FRAMES` | Video limits enforced during request normalization. |
| `OUTPUT_DIR` / `OUTPUT_DIR_ALIAS` | Where artifacts are written, and the path a remote consumer (e.g. n8n in a container) should see instead. |
| `TEMPLATES_DIR` / `BUILTIN_TEMPLATES_DIR` | User and builtin template registry roots. |
| `TMP_DIR` | Where video frames and in-progress encodes live (default `os.tmpdir()`). |
| `TEMPLATE_ALLOWED_HOSTS` | Optional comma-separated allowlist for `source.url` template fetches (SSRF guard). |
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

Runs `node --test` over `test/**/*.test.js` and `test/core/**/*.test.js`:

- unit tests for `shared/html_template.js` (var escaping, `{{{RAW}}}`, `<base href>`
  injection), `RenderJobBuilder`/`JobLoader` validation, `core/ids.js`, `core/errors.js`;
- `core/render_queue.js` — lane concurrency, `QUEUE_FULL`, `RENDER_TIMEOUT`, cancellation;
- `core/storage_adapter.js` — atomic writes, checksum, dated vs. explicit layout,
  `OUTPUT_DIR_ALIAS` translation;
- `core/template_registry.js` — manifest parsing, inference, user/builtin precedence,
  path-traversal rejection;
- `core/render_service.js` — end-to-end renders (registry and file sources) through a
  real Chromium instance, plus error-code mapping (`MISSING_REQUIRED_VAR`, `UNKNOWN_FORMAT`);
- `cli/args.js` — flag parsing (aliases, booleans, repeated flags, `--`);
- `cli/commands/render.js` — spawns the real `eavexa` binary as a child process and
  asserts the actual stdout/stderr split for `--json` and `-o -`, plus exit codes;
- an integration smoke test that renders real PNGs and checks the **actual** pixel
  dimensions — the regression check for the DPR bug described in `docs/specification.md`
  §12 (B1).
