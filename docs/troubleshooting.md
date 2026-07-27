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

Relative paths need a template folder to resolve against. Registry templates,
`--file`/`source.path`, and `jobs.json` entries all have one. **Inline HTML**
(`source.html`, `eavexa render --stdin`) does not — pass `source.base_dir` next to the
markup, or the asset silently renders blank. Remote `source.url` templates resolve
relative paths against the URL as usual.

## `<video>` Renders Blank Or Black

Work through these in order:

1. **Codec.** The bundled Playwright Chromium decodes H.264 (`.mp4`) and VP8/VP9/AV1
   (`.webm`). H.265/HEVC and Theora are not supported — re-encode the clip:

   ```bash
   ffmpeg -i input.mov -c:v libx264 -pix_fmt yuv420p -an videos/loop.mp4
   ```

2. **Path.** A local `<video src="./videos/loop.mp4">` resolves the same way as an
   `<img>` — see *Images Do Not Load* above.
3. **`data-eavexa-skip`.** A video carrying this attribute is left entirely alone, so it
   shows whatever the template itself put on screen. Remove the attribute to hand control
   back to EAVexa.
4. **A `Video metadata loading exceeded …ms` warning in the log** means the clip never
   reported its duration within `VIDEO_TAG_TIMEOUT_MS` (default `5000`). Rendering
   continues with videos untouched, which usually looks like a blank element. A large
   remote clip may just need a higher limit; a local clip that trips this is normally a
   codec or path problem instead.

## `Frame N: … video seek(s) exceeded …ms` Warnings

Each frame waits for the browser's `seeked` event before the screenshot, bounded by
`VIDEO_TAG_TIMEOUT_MS` capped at `2000`ms. Frequent warnings mean seeking is slower than
that limit, and those frames may capture a stale image.

Long-GOP clips are the usual cause — seeking to an arbitrary timestamp forces the decoder
back to the previous keyframe. Re-encode with dense keyframes:

```bash
ffmpeg -i input.mp4 -c:v libx264 -g 12 -keyint_min 12 -pix_fmt yuv420p -an videos/loop.mp4
```

Shrinking the clip to the rendered element's actual pixel size helps too — a 4K source
scaled into a 1080px box decodes 4K frames for nothing.

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

`<video>` elements are the exception — EAVexa pauses them and seeks each one per captured
frame, so a plain `<video>` tag is already deterministic and needs no special handling.

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
