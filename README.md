# EAVexa

EAVexa can also render deterministic videos from HTML by capturing PNG frames in Playwright and encoding them with FFmpeg.

PNG image generator from HTML templates. Renders posts, stories, and other formats via Playwright + Chromium — pixel-perfect, with support for custom fonts and high-res (Retina) export.

---

## Installation

```bash
npm install
npx playwright install chromium
```

FFmpeg is bundled through `ffmpeg-static`, so video rendering works without a system FFmpeg install. Set `FFMPEG_PATH` only if you want to force a local FFmpeg binary.

---

## Usage

```bash
npm start
```

The project reads `data/jobs.json`, finds all enabled jobs, and renders them one by one. Results are saved to `data/outputs/<job_id>/`.

To render video, add a `video` block to a job. The detailed HTML animation guide is in [`docs/video_rendering.md`](docs/video_rendering.md).

---

## Project structure

```
EAVexa/
├── data/
│   ├── jobs.json              ← main config (the only file you edit)
│   ├── inputs/
│   │   └── my_post/           ← folder for each job
│   │       ├── template.html
│   │       ├── fonts/         ← local fonts (optional)
│   │       └── images/        ← local images (optional)
│   └── outputs/
│       └── my_post/
│           └── result.png     ← rendered output
└── src/                       ← source code (do not modify)
```

---

## Adding a new job

### Step 1 — Create a folder in `data/inputs/`

```
data/inputs/my_post/
├── template.html
└── fonts/           (if using local fonts)
    └── MyFont.woff2
```

### Step 2 — Add a job to `data/jobs.json`

```json
{
  "id":       "my_post",
  "enabled":  true,
  "template": "template.html",
  "output":   "result.png",
  "format":   "post_square",
  "vars": {
    "HEADLINE": "My headline",
    "BODY":     "Post body text"
  }
}
```

### Step 3 — Run

```bash
npm start
```

---

## jobs.json fields

| Field      | Type            | Description                                                       |
|------------|-----------------|-------------------------------------------------------------------|
| `id`       | string          | Job name — must match the folder name inside `inputs/`            |
| `enabled`  | boolean         | `false` — job is skipped without removing it from the config      |
| `template` | string          | HTML filename inside the job folder                               |
| `output`   | string          | Output PNG filename                                               |
| `format`   | string / object | Output format (see below)                                         |
| `vars`     | object          | Variables injected into the template via `{{KEY}}` placeholders   |

---

## Formats

| Key              | Size (px)     | Use case                        |
|------------------|---------------|---------------------------------|
| `post_square`    | 1080 × 1080   | Instagram / Facebook post       |
| `post_portrait`  | 1080 × 1350   | Instagram portrait post (4:5)   |
| `post_landscape` | 1080 × 566    | Instagram landscape post        |
| `story`          | 1080 × 1920   | Instagram / TikTok story (9:16) |
| `twitter_card`   | 1200 × 628    | Twitter / X card                |
| `linkedin`       | 1200 × 627    | LinkedIn post                   |

All formats render with `device_scale_factor: 2` — the output PNG will be twice the logical size (e.g. `post_square` → `2160×2160px`).

**Custom size** — instead of a key, pass an object directly in `jobs.json`:

```json
"format": { "width": 1500, "height": 500, "device_scale_factor": 3 }
```

---

## Templates

HTML templates are plain files with `{{VARIABLE}}` support for dynamic content.

```html
<h1>{{HEADLINE}}</h1>
<p>{{BODY}}</p>
```

Values are injected from the `vars` field in `jobs.json`. Templates are always rendered with fixed dimensions set in `<style>`:

```css
html, body {
  width:  1080px;
  height: 1080px;
  overflow: hidden;
}
```

### Local fonts

Place the font file next to the template and reference it with a relative path:

```css
@font-face {
  font-family: 'MyFont';
  src: url('./fonts/MyFont.woff2') format('woff2');
  font-display: block;
}
```

> `font-display: block` is required — without it the renderer may take a screenshot before the font has loaded.

### Google Fonts

```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=block" rel="stylesheet">
```

---

## Disabling a job without deleting it

```json
{
  "id":      "my_post",
  "enabled": false,
  ...
}
```

---

## Full jobs.json example

```json
{
  "jobs": [
    {
      "id":       "weekly_tip",
      "enabled":  true,
      "template": "template.html",
      "output":   "tip.png",
      "format":   "post_square",
      "vars": {
        "BRAND":    "EAVexa",
        "HEADLINE": "Tip of the week",
        "BODY":     "Plan your content a month ahead — and you'll never run out of things to post.",
        "CTA":      "Read more →"
      }
    },
    {
      "id":       "promo_story",
      "enabled":  true,
      "template": "template.html",
      "output":   "story.png",
      "format":   "story",
      "vars": {
        "BRAND":    "EAVexa",
        "HEADLINE": "Sale until end of week",
        "BODY":     "-30% on all courses"
      }
    }
  ]
}
```
