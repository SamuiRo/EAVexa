# EAVexa

EAVexa renders high-quality social images and deterministic videos from HTML templates.

It uses Playwright + Chromium for pixel-accurate HTML rendering. Image jobs export PNG files. Video jobs capture PNG frames from the same HTML template and encode them with FFmpeg.

## What It Does

- Render PNG images from HTML templates.
- Render MP4, WebM, MOV, and MKV videos from animated HTML.
- Support local fonts, images, SVG, CSS, and JavaScript-driven layouts.
- Inject variables through `{{PLACEHOLDER}}` values in `data/jobs.json`.
- Keep input templates and output artifacts organized per job.

## Requirements

- Node.js 18 or newer.
- npm.
- Playwright Chromium.

FFmpeg is bundled through `ffmpeg-static`, so a system FFmpeg install is not required. If you want to use your own FFmpeg binary, set `FFMPEG_PATH`.

## Install

```bash
npm install
npx playwright install chromium
```

## Run

```bash
npm start
```

The app reads `data/jobs.json`, renders all enabled jobs, and writes results to `data/outputs/<job_id>/`.

## Minimal Image Job

```json
{
  "id": "weekly_tip",
  "enabled": true,
  "template": "template.html",
  "output": "weekly_tip.png",
  "format": "post_square",
  "vars": {
    "TITLE": "Tip of the week"
  }
}
```

Template location:

```text
data/inputs/weekly_tip/template.html
```

## Minimal Video Job

```json
{
  "id": "animated_story",
  "enabled": true,
  "template": "template.html",
  "output": "animated_story.mp4",
  "format": "story",
  "vars": {
    "TITLE": "Launch week"
  },
  "video": {
    "duration": 5,
    "fps": 30,
    "crf": 18,
    "keep_frames": false
  }
}
```

If a job has no `video` block, it renders as PNG. If a job has a `video` block, it renders as video.

## Documentation

Start here:

- [Documentation index](docs/index.md)
- [Getting started](docs/getting_started.md)
- [Jobs configuration](docs/jobs.md)
- [HTML templates](docs/templates.md)
- [HTML to video rendering](docs/video_rendering.md)
- [Architecture](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)

## Project Layout

```text
EAVexa/
  data/
    jobs.json
    jobs.example.json
    inputs/
      <job_id>/
        template.html
        fonts/
        images/
    outputs/
      <job_id>/
  docs/
  src/
    config/
    modules/
      jobs/
      orchestrator/
      renderer/
    shared/
```

## License

GPL-3.0
