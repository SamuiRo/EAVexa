# HTML to Video Rendering

EAVexa renders video in three steps:

1. Opens the HTML template in Playwright.
2. Captures deterministic PNG frames: `frame_000000.png`, `frame_000001.png`, ...
3. Encodes the frames into a video through FFmpeg.

This keeps the output stable: the same HTML and the same job config produce the same video frames.

## Job config

Add a `video` block to a normal job:

```json
{
  "id": "animated_story",
  "enabled": true,
  "template": "template.html",
  "output": "animated_story.mp4",
  "format": "story",
  "vars": {
    "TITLE": "Launch week",
    "CTA": "Read more"
  },
  "video": {
    "duration": 5,
    "fps": 30,
    "crf": 18,
    "preset": "medium",
    "keep_frames": false
  }
}
```

If `video` is missing, the job is rendered as a PNG exactly like before.

Supported output extensions:

- `.mp4` - H.264, good default for social/video platforms.
- `.webm` - VP9, useful for web usage.
- `.mov` - H.264 in QuickTime container.
- `.mkv` - H.264 in Matroska container.

## Video fields

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `duration` | yes | none | Video duration in seconds. |
| `fps` | no | `30` | Frames per second. `duration: 5` and `fps: 30` creates 150 PNG frames. |
| `crf` | no | `18` | Quality for H.264 outputs. Lower means larger and cleaner. Good range: `16`-`23`. |
| `webm_crf` | no | `32` | Quality for `.webm`/VP9 outputs. Lower means larger and cleaner. |
| `preset` | no | `medium` | H.264 speed/size preset: `ultrafast`, `fast`, `medium`, `slow`. |
| `keep_frames` | no | `false` | If `true`, keeps the generated PNG frames next to the output video. |

## Recommended animation model

For best quality, do not let the browser animation run in real time.

Instead, expose this function in the template:

```html
<script>
  window.eavexa_render_frame = ({ time_s, progress, frame, fps, duration }) => {
    const title = document.querySelector('.title');

    title.style.opacity = progress;
    title.style.transform = `translateY(${40 - progress * 40}px)`;
  };
</script>
```

EAVexa calls `window.eavexa_render_frame(...)` before every screenshot.

The frame state contains:

| Field | Meaning |
| --- | --- |
| `frame` | Zero-based frame index. |
| `frame_number` | One-based frame number. |
| `total_frames` | Total PNG frames in the render. |
| `fps` | Frames per second from the job config. |
| `duration` | Duration from the job config. |
| `progress` | Normalized progress from `0` to `1`. |
| `time_s` | Render timeline time in seconds from `0` to `duration`. |
| `time_ms` | Same timeline time in milliseconds. |
| `frame_time_s` | Encoded video timestamp: `frame / fps`. |

Use `progress` for most animations. Use `time_s` when you need time-based motion.

## Built-in CSS variables

Before every screenshot, EAVexa also writes these CSS variables to `:root`:

```css
:root {
  --eavexa-time: 0s;
  --eavexa-time-ms: 0ms;
  --eavexa-progress: 0;
  --eavexa-frame: 0;
}
```

Example:

```css
.bar {
  transform-origin: left center;
  transform: scaleX(var(--eavexa-progress));
}
```

## Full HTML example

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html,
    body {
      width: 1080px;
      height: 1920px;
      margin: 0;
      overflow: hidden;
      background: #101014;
      color: white;
      font-family: Arial, sans-serif;
    }

    .scene {
      width: 100%;
      height: 100%;
      display: grid;
      place-items: center;
    }

    .title {
      font-size: 96px;
      font-weight: 800;
      opacity: 0;
      transform: translateY(60px);
    }
  </style>
</head>
<body>
  <main class="scene">
    <h1 class="title">{{TITLE}}</h1>
  </main>

  <script>
    function ease_out_cubic(t) {
      return 1 - Math.pow(1 - t, 3);
    }

    window.eavexa_render_frame = ({ progress }) => {
      const title = document.querySelector('.title');
      const eased = ease_out_cubic(progress);

      title.style.opacity = eased;
      title.style.transform = `translateY(${60 - eased * 60}px)`;
    };
  </script>
</body>
</html>
```

## CSS animations

Simple CSS animations are supported. EAVexa tries to pause all Web Animations and set their `currentTime` for each frame.

```css
.title {
  animation: title_in 5s linear both;
}

@keyframes title_in {
  from {
    opacity: 0;
    transform: translateY(60px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

For complex work, prefer `window.eavexa_render_frame`. It gives exact control and avoids timing differences between machines.

## GSAP pattern

If a template uses GSAP, create a paused timeline and set its progress manually:

```html
<script>
  const tl = gsap.timeline({ paused: true });

  tl.fromTo('.title',
    { opacity: 0, y: 60 },
    { opacity: 1, y: 0, duration: 1, ease: 'power3.out' },
  );

  window.eavexa_render_frame = ({ progress }) => {
    tl.progress(progress);
  };
</script>
```

## Canvas pattern

For `<canvas>`, redraw the whole frame inside the hook:

```html
<script>
  const canvas = document.querySelector('canvas');
  const ctx = canvas.getContext('2d');

  window.eavexa_render_frame = ({ progress }) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#101014';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(120 + progress * 840, 960, 80, 0, Math.PI * 2);
    ctx.fill();
  };
</script>
```

## Rules for reliable templates

- Keep the template size fixed with CSS, matching the selected `format`.
- Prefer local assets in the job folder: `fonts/`, `images/`, video-safe SVGs.
- Use `font-display: block` for local and Google fonts.
- Avoid `setInterval()` and `setTimeout()` for animation state.
- Avoid relying on real playback time, hover state, cursor position, or random values.
- If randomness is needed, use fixed values or a seeded generator.
- Avoid CSS transitions for timeline-critical animation; use direct styles in `eavexa_render_frame`.
- Use `keep_frames: true` when debugging visual artifacts.

## Output quality tips

- Start with `.mp4`, `fps: 30`, `crf: 18`.
- Use `fps: 60` only when motion really needs it; it doubles frame count.
- Use `crf: 16` for cleaner files, `crf: 20`-`23` for smaller files.
- Keep dimensions even when possible. EAVexa pads odd dimensions for video encoders, but even dimensions are cleaner.
