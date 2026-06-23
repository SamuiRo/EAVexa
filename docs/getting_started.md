# Getting Started

This guide walks through a clean setup and the first render.

## Install

From the project root:

```bash
npm install
npx playwright install chromium
```

EAVexa uses `ffmpeg-static` for video encoding. You do not need to install FFmpeg globally.

If you prefer a system FFmpeg binary, set:

```bash
FFMPEG_PATH=/path/to/ffmpeg
```

On Windows PowerShell:

```powershell
$env:FFMPEG_PATH = 'C:\ffmpeg\bin\ffmpeg.exe'
```

## Create An Image Job

Create this folder:

```text
data/inputs/hello_card/
```

Add `data/inputs/hello_card/template.html`:

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html,
    body {
      width: 1080px;
      height: 1080px;
      margin: 0;
      overflow: hidden;
      background: #111827;
      color: white;
      font-family: Arial, sans-serif;
    }

    main {
      width: 100%;
      height: 100%;
      display: grid;
      place-items: center;
    }

    h1 {
      font-size: 96px;
    }
  </style>
</head>
<body>
  <main>
    <h1>{{TITLE}}</h1>
  </main>
</body>
</html>
```

Add a job to `data/jobs.json`:

```json
{
  "jobs": [
    {
      "id": "hello_card",
      "enabled": true,
      "template": "template.html",
      "output": "hello_card.png",
      "format": "post_square",
      "vars": {
        "TITLE": "Hello EAVexa"
      }
    }
  ]
}
```

Run:

```bash
npm start
```

The output appears at:

```text
data/outputs/hello_card/hello_card.png
```

## Create A Video Job

Use the same folder and template concept, but add a `video` block and output a supported video extension:

```json
{
  "jobs": [
    {
      "id": "hello_video",
      "enabled": true,
      "template": "template.html",
      "output": "hello_video.mp4",
      "format": "story",
      "vars": {
        "TITLE": "Hello Video"
      },
      "video": {
        "duration": 5,
        "fps": 30,
        "crf": 18,
        "keep_frames": false
      }
    }
  ]
}
```

Video templates should expose `window.eavexa_render_frame(...)` when animation needs to be exact:

```html
<script>
  window.eavexa_render_frame = ({ progress }) => {
    const title = document.querySelector('h1');

    title.style.opacity = progress;
    title.style.transform = `translateY(${80 - progress * 80}px)`;
  };
</script>
```

Read the full video guide in [HTML to video rendering](video_rendering.md).

## Development Commands

```bash
npm start
npm audit
```

There is no separate build step. The project runs directly on Node.js ESM.
