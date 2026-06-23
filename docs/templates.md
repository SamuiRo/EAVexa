# HTML Templates

Templates are normal HTML files. EAVexa opens them in Playwright Chromium, waits for the page and fonts, then captures the result.

## Location

Every job has its own folder:

```text
data/inputs/<job_id>/
  template.html
  fonts/
  images/
```

The job config points to the template filename:

```json
{
  "id": "weekly_tip",
  "template": "template.html"
}
```

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
