# Jobs Configuration

Jobs live in `data/jobs.json`. EAVexa reads the file, skips disabled jobs, validates the enabled jobs, and renders each one.

## File Shape

```json
{
  "jobs": [
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
  ]
}
```

`jobs` must be a non-empty array.

## Required Fields

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Job id. Must match a folder inside `data/inputs/`. |
| `template` | string | HTML file inside the job input folder. |
| `output` | string | Output filename inside `data/outputs/<job_id>/`. |
| `format` | string or object | Predefined format key or custom dimensions object. |

## Optional Fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Set to `false` to skip a job. |
| `vars` | object | `{}` | Values injected into `{{KEY}}` placeholders. |
| `opts` | object | `{}` | Extra renderer options for advanced usage. |
| `video` | object | none | Enables video rendering for this job. |

## Image Jobs

An image job has no `video` block and usually outputs `.png`.

```json
{
  "id": "promo_post",
  "enabled": true,
  "template": "template.html",
  "output": "promo_post.png",
  "format": "post_square",
  "vars": {
    "HEADLINE": "Spring sale",
    "CTA": "Shop now"
  }
}
```

## Video Jobs

A video job has a `video` block and must use one of these output extensions:

- `.mp4`
- `.webm`
- `.mov`
- `.mkv`

```json
{
  "id": "promo_story",
  "enabled": true,
  "template": "template.html",
  "output": "promo_story.mp4",
  "format": "story",
  "vars": {
    "HEADLINE": "Spring sale",
    "CTA": "Shop now"
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

If `output` is a video extension but `video` is missing, EAVexa stops with a clear validation error. This prevents accidentally writing PNG bytes into a `.mp4` file.

## Predefined Formats

| Key | Size | Use case |
| --- | --- | --- |
| `post_square` | `1080 x 1080` | Instagram / Facebook square post |
| `post_portrait` | `1080 x 1350` | Instagram portrait post |
| `post_landscape` | `1080 x 566` | Instagram landscape post |
| `story` | `1080 x 1920` | Instagram / TikTok story |
| `twitter_card` | `1200 x 628` | Twitter / X card |
| `linkedin` | `1200 x 627` | LinkedIn post |

Predefined formats currently render with `device_scale_factor: 2`.

That means `story` uses a logical viewport of `1080 x 1920`, but the final PNG/video frame is `2160 x 3840`.

## Custom Format

Use a custom dimensions object when a predefined format is not enough:

```json
{
  "format": {
    "width": 1500,
    "height": 500,
    "device_scale_factor": 2
  }
}
```

All dimensions are logical CSS pixels. The final rendered pixel size is:

```text
width * device_scale_factor
height * device_scale_factor
```

## Job Folder Rules

For a job with `"id": "promo_story"`, EAVexa expects:

```text
data/inputs/promo_story/template.html
```

Outputs are written to:

```text
data/outputs/promo_story/
```

Relative asset paths inside HTML resolve from the template folder:

```html
<img src="./images/product.png">
```

## Variables

`vars` replaces exact `{{KEY}}` placeholders in the HTML:

```json
{
  "vars": {
    "TITLE": "Hello",
    "BODY": "Rendered from jobs.json"
  }
}
```

Template:

```html
<h1>{{TITLE}}</h1>
<p>{{BODY}}</p>
```

Variable replacement is simple text replacement. Keep placeholder names unique and uppercase for readability.

## Disabled Jobs

Use `enabled: false` to keep a job in the config without rendering it:

```json
{
  "id": "draft_story",
  "enabled": false,
  "template": "template.html",
  "output": "draft_story.png",
  "format": "story"
}
```
