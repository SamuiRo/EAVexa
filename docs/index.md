# EAVexa Documentation

This documentation explains how to use, extend, and troubleshoot EAVexa.

## User Guides

- [Getting started](getting_started.md) - install, configure, and run the renderer.
- [Jobs configuration](jobs.md) - every supported `data/jobs.json` field.
- [HTML templates](templates.md) - how to structure HTML, assets, fonts, and placeholders.
- [HTML to video rendering](video_rendering.md) - deterministic animation rendering and FFmpeg output.
- [Troubleshooting](troubleshooting.md) - common failures and fixes.

## Maintainer Guides

- [Architecture](architecture.md) - source layout, render flow, and module responsibilities.

## Main Concepts

EAVexa has three main concepts:

- A job describes what to render.
- A template is the HTML file used as the visual source.
- A renderer turns the template into either a PNG image or a video file.

Image jobs and video jobs share the same template and format system. Video jobs add a `video` block to control duration, FPS, quality, and frame debugging.

## Typical Workflow

1. Create `data/inputs/<job_id>/template.html`.
2. Add a job with the same `id` to `data/jobs.json`.
3. Run `npm start`.
4. Collect outputs from `data/outputs/<job_id>/`.

For video jobs, design animations around `window.eavexa_render_frame(...)` for repeatable frame-perfect output.
