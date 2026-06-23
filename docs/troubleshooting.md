# Troubleshooting

This guide lists common render problems and how to fix them.

## `Cannot read jobs config`

EAVexa could not find or read `data/jobs.json`.

Check:

- The file exists.
- The JSON is saved as plain text.
- You are running `npm start` from the project root.

## `jobs.json must have a non-empty "jobs" array`

The config must look like this:

```json
{
  "jobs": [
    {
      "id": "example",
      "enabled": true,
      "template": "template.html",
      "output": "example.png",
      "format": "post_square"
    }
  ]
}
```

## Job Is Missing A Required Field

Enabled jobs require:

- `id`
- `template`
- `output`
- `format`

If you want to keep a partial draft in `jobs.json`, set:

```json
"enabled": false
```

## Video Output Fails Validation

Video output extensions require a `video` block:

```json
{
  "output": "story.mp4",
  "video": {
    "duration": 5,
    "fps": 30
  }
}
```

If a job has a `video` block, its output must end with:

- `.mp4`
- `.webm`
- `.mov`
- `.mkv`

## Chromium Is Missing

Install Playwright Chromium:

```bash
npx playwright install chromium
```

If you need a custom Chrome/Chromium executable, set `CHROME_PATH`.

PowerShell:

```powershell
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
```

## FFmpeg Cannot Start

EAVexa uses `ffmpeg-static` by default. Reinstall dependencies if the binary is missing:

```bash
npm install
```

To force a local FFmpeg binary:

```powershell
$env:FFMPEG_PATH = 'C:\ffmpeg\bin\ffmpeg.exe'
```

Then run:

```bash
npm start
```

## Fonts Render Incorrectly

Use local fonts when possible:

```css
@font-face {
  font-family: 'BrandFont';
  src: url('./fonts/BrandFont.woff2') format('woff2');
  font-display: block;
}
```

For Google Fonts, use `display=block`:

```html
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=block">
```

If fonts still look wrong:

- Check the relative font path.
- Check that the font file exists in the job folder.
- Avoid relying on network fonts in offline environments.

## Images Do Not Load

Relative paths resolve from the template folder.

For:

```text
data/inputs/promo/template.html
data/inputs/promo/images/product.png
```

Use:

```html
<img src="./images/product.png" alt="">
```

Avoid absolute local paths in templates because they are harder to move between machines.

## Output Is Cropped

The HTML dimensions must match the selected format.

For `story`:

```css
html,
body {
  width: 1080px;
  height: 1920px;
  overflow: hidden;
}
```

If content extends outside that viewport, it will be clipped.

## Video Animation Looks Different Each Render

Avoid real-time animation state:

- `setTimeout()`
- `setInterval()`
- random values
- cursor or hover state
- real media playback time

Prefer deterministic frame control:

```html
<script>
  window.eavexa_render_frame = ({ progress }) => {
    document.querySelector('.title').style.opacity = progress;
  };
</script>
```

## Video Has Visual Artifacts

Use `keep_frames: true` to inspect generated PNG frames:

```json
{
  "video": {
    "duration": 5,
    "fps": 30,
    "keep_frames": true
  }
}
```

Then inspect:

```text
data/outputs/<job_id>/<output_name>_frames/
```

If the frames look correct but video does not:

- Lower `crf` for higher quality.
- Try `.mp4` first.
- Keep dimensions even.
- Use `fps: 30` before trying `fps: 60`.

## Output File Is Too Large

For MP4:

- Increase `crf` to `20`, `22`, or `23`.
- Use `preset: "slow"` for better compression.
- Lower `fps` if possible.

For WebM:

- Increase `webm_crf`.
- Keep the render duration short.

## Debug Checklist

1. Run `npm start`.
2. Read the first error message.
3. Confirm `data/jobs.json` is valid JSON.
4. Confirm the job folder matches `id`.
5. Confirm the template file exists.
6. Confirm local asset paths are relative.
7. For video, enable `keep_frames`.
8. Re-run after one fix at a time.
