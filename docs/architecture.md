# Architecture

EAVexa is a Node.js ESM application. It renders HTML templates through Playwright and optionally encodes video through FFmpeg.

## Entry Point

`src/index.js` is intentionally thin. It wires the application modules together:

1. Print the banner.
2. Load and validate jobs.
3. Build renderer-ready job objects.
4. Render image and video jobs.
5. Print render results.
6. Close browser sessions.

Most behavior lives in focused classes under `src/modules/`.

## Source Layout

```text
src/
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
      ImageRenderer.js
      video_renderer.js
      ffmpeg_encoder.js
  shared/
    messages.js
    utils.js
```

## Module Responsibilities

| Module | Responsibility |
| --- | --- |
| `src/index.js` | High-level application orchestration only. |
| `config/app_config.js` | Centralized paths and environment-backed configuration. |
| `config/render_config.js` | Predefined image/video dimensions and viewport options. |
| `config/video_config.js` | Supported video output extensions. |
| `modules/jobs/job_loader.js` | Read and validate `data/jobs.json`. |
| `modules/jobs/render_job_builder.js` | Convert user jobs into renderer jobs with absolute paths. |
| `modules/orchestrator/render_orchestrator.js` | Split image/video jobs and run the correct renderer. |
| `modules/orchestrator/render_result_reporter.js` | Print output summaries. |
| `modules/renderer/ImageRenderer.js` | Render HTML to PNG. |
| `modules/renderer/video_renderer.js` | Render HTML to PNG frames and request encoding. |
| `modules/renderer/ffmpeg_encoder.js` | Encode PNG frame sequences into video files. |
| `shared/utils.js` | Logging and shared helper utilities. |
| `shared/messages.js` | CLI banner text. |

## Image Render Flow

```text
data/jobs.json
  -> JobLoader
  -> RenderJobBuilder
  -> RenderOrchestrator
  -> ImageRenderer
  -> data/outputs/<job_id>/<output>.png
```

`ImageRenderer`:

1. Opens Chromium.
2. Creates a fresh browser context with the requested viewport and DPR.
3. Loads the HTML template.
4. Waits for network idle and fonts.
5. Captures a PNG screenshot.
6. Writes the PNG to the output path.

## Video Render Flow

```text
data/jobs.json
  -> JobLoader
  -> RenderJobBuilder
  -> RenderOrchestrator
  -> VideoRenderer
  -> PNG frame sequence
  -> FfmpegEncoder
  -> data/outputs/<job_id>/<output>.mp4
```

`VideoRenderer`:

1. Opens Chromium.
2. Creates a browser context with the requested viewport and DPR.
3. Loads the HTML template.
4. For each frame:
   - computes `progress`, `time_s`, and frame metadata;
   - pauses Web Animations and sets their `currentTime`;
   - calls `window.eavexa_render_frame(...)` when provided;
   - captures `frame_000000.png`, `frame_000001.png`, and so on.
5. Calls `FfmpegEncoder`.
6. Removes temporary frames unless `keep_frames` is enabled.

## Configuration Rules

Environment variables are centralized in `src/config/app_config.js`. Do not read `process.env` directly in modules.

Current environment-backed settings:

| Variable | Purpose |
| --- | --- |
| `CHROME_PATH` | Optional explicit Chromium/Chrome executable path. |
| `FFMPEG_PATH` | Optional explicit FFmpeg executable path. |

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
