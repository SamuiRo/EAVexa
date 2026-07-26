# HTML Templates

Templates are normal HTML files. EAVexa opens them in Playwright Chromium, waits for the page and fonts, then captures the result.

## Two ways templates are organized

**Legacy — `data/jobs.json` / `eavexa batch`:** every job has its own folder under
`data/inputs/<job_id>/`, referenced by filename from the job entry:

```text
data/inputs/<job_id>/
  template.html
  fonts/
  images/
```

```json
{
  "id": "weekly_tip",
  "template": "template.html"
}
```

**Registry — `eavexa render -t <name>`, `eavexa templates`, and the HTTP API's
`source.name`:** a named directory under `templates/` (builtin, checked into git) or
`data/templates/` (user-added; overrides a builtin template of the same name):

```text
templates/story_pricing_pro/        (or data/templates/story_pricing_pro/)
  template.json                     # optional manifest — see below
  template.html
  preview.png                       # optional — served by GET /v1/templates/:name/preview
  fonts/
  images/
```

Both paths end up in the exact same place: an HTML file, substituted the same way
(`{{KEY}}` escaped, `{{{KEY}}}` raw), rendered by the same renderer. Everything below this
point — placeholders, assets, fonts, layout — applies identically to either.

## Template Manifest (`template.json`)

Optional. Without one, EAVexa **infers** a manifest: `name` from the directory name,
`entry` = `template.html` (or the one `.html` file present if there's exactly one),
`vars` = every unique `{{KEY}}`/`{{{KEY}}}` found in the HTML (all treated as optional
strings), `kind: "both"`. `eavexa templates show <name>` and `GET /v1/templates/:name`
both mark an inferred manifest with `"inferred": true` — this means **every existing
template already works through the registry with zero changes.**

Add a `template.json` to declare a proper variable schema, restrict which formats make
sense, or default video settings:

```jsonc
{
  "name": "story_pricing_pro",
  "title": "Pricing — Pro plan",
  "description": "Instagram story with the Pro tier price",
  "version": "1.0.0",
  "entry": "template.html",
  "kind": "image",                       // image | video | both
  "network": "required",                 // required | optional | none — informational only, not enforced
  "default_format": "story",
  "supported_formats": ["story", "post_portrait"],
  "video": { "duration": 5, "fps": 30 }, // default video block when the caller doesn't send one
  "vars": [
    { "name": "TITLE", "type": "string", "required": true,
      "description": "Headline", "example": "Launch week", "max_length": 60 },
    { "name": "PRICE", "type": "string", "required": true, "example": "$29" },
    { "name": "SUBTITLE", "type": "string", "required": false, "default": "" }
  ],
  "tags": ["pricing", "story", "en"]
}
```

`vars[]` fields: `name` (required), `type` (`string|number|boolean|color|url|html` —
informational/validated for length only, not coerced), `required`, `default` (used when
the var is omitted), `example` (documentation only — shown by `templates show` /
`GET /v1/templates/:name`, for whoever is about to call the template), `max_length`,
`description`. A required var with no value throws `MISSING_REQUIRED_VAR` before any
rendering happens — this is what makes the HTTP API and CLI fail fast with a clear
message instead of silently rendering `{{PRICE}}` literally onto the image.

`preview.png` (optional) is a plain static image you commit alongside the template — it
is **not** rendered on demand or cached; `GET /v1/templates/:name/preview` just streams
that file as-is. If it's missing, the endpoint 404s.

## Minimal Template

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
      background: white;
    }
  </style>
</head>
<body>
  <h1>{{TITLE}}</h1>
</body>
</html>
```

## Match The Format Size

The HTML page should use the same logical dimensions as the selected format.

For `post_square`:

```css
html,
body {
  width: 1080px;
  height: 1080px;
  overflow: hidden;
}
```

For `story`:

```css
html,
body {
  width: 1080px;
  height: 1920px;
  overflow: hidden;
}
```

EAVexa clips screenshots to the configured viewport. Content outside the viewport is not visible.

## Placeholders

Use `{{KEY}}` placeholders for values from `jobs.json`:

```html
<h1>{{HEADLINE}}</h1>
<p>{{BODY}}</p>
```

Job config:

```json
{
  "vars": {
    "HEADLINE": "New course",
    "BODY": "Registration is open"
  }
}
```

Keep placeholder names clear and stable:

- Good: `{{HEADLINE}}`, `{{SUBTITLE}}`, `{{CTA}}`
- Avoid: `{{text}}`, `{{x}}`, `{{1}}`

`{{KEY}}` values are HTML-escaped (`& < > " '`) before insertion — safe by default for
plain text. To insert raw HTML (e.g. a value that legitimately contains markup), use
triple braces: `{{{KEY}}}`. Unknown placeholders are left untouched rather than causing
an error.

## Local Images

Put images next to the template:

```text
data/inputs/promo_story/
  template.html
  images/
    product.png
```

Reference them with relative URLs:

```html
<img src="./images/product.png" alt="">
```

## Local Fonts

Put font files in a `fonts/` folder:

```text
data/inputs/promo_story/
  template.html
  fonts/
    Inter-Bold.woff2
```

Use `font-display: block` so Playwright waits for correct font rendering:

```css
@font-face {
  font-family: 'Inter Local';
  src: url('./fonts/Inter-Bold.woff2') format('woff2');
  font-weight: 700;
  font-style: normal;
  font-display: block;
}

body {
  font-family: 'Inter Local', Arial, sans-serif;
}
```

## Google Fonts

Use `display=block`:

```html
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=block">
```

Local fonts are safer for repeatable renders, especially in offline or CI environments.

## Layout Recommendations

- Set `margin: 0` on `html` and `body`.
- Set fixed `width` and `height`.
- Set `overflow: hidden`.
- Avoid content that depends on scroll position.
- Use local assets for predictable output.
- Avoid remote images unless the render environment has reliable network access.
- Test long text values from `vars`; real content is often longer than sample content.

## Image Rendering Notes

Image jobs call `page.screenshot()` after:

1. The HTML content is loaded.
2. Network activity is idle.
3. `document.fonts.ready` resolves.
4. A small settle delay completes.

CSS animations are disabled for PNG screenshots so the image is captured in a stable state.

## Video Rendering Notes

Video jobs keep animations controllable per frame. For precise videos, expose:

```html
<script>
  window.eavexa_render_frame = ({ progress, time_s }) => {
    // set DOM, SVG, canvas, or animation state here
  };
</script>
```

Read [HTML to video rendering](video_rendering.md) for the full frame API.
