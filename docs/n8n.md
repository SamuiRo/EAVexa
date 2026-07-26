# n8n Integration

Two ready-to-import workflows live in `docs/n8n/`: `sync_image.json` (one HTTP node,
blocking) and `async_video.json` (submit + Wait-for-webhook, non-blocking). Both assume
EAVexa is reachable at `http://localhost:8080` — same-machine bare metal, the target
deployment (`docs/deployment.md`).

> **Node schema caveat:** these were hand-written against a recent n8n HTTP
> Request/Wait/If node schema, not exported from a running n8n instance, and n8n's node
> parameter shape does shift between versions. If import fails or a node shows
> unrecognized fields, use the prose descriptions below to rebuild it manually — that's
> the authoritative reference either way.

## Required n8n settings for large files

Regardless of which workflow below you use, set these once for n8n if you'll ever move
files bigger than a few MB through it:

```bash
N8N_DEFAULT_BINARY_DATA_MODE=filesystem   # binaries go to disk, not RAM
N8N_PAYLOAD_SIZE_MAX=32                   # MB — only matters if you actually send bytes through n8n
NODE_OPTIONS=--max-old-space-size=2048
```

## Import

n8n → Workflows → **Import from File** → pick `docs/n8n/sync_image.json` or
`async_video.json`. Both need an `EAVEXA_API_KEY` environment variable available to n8n
if you've set one on the EAVexa side (n8n → Settings → Environment Variables, or your
process manager's env) — if you haven't set `EAVEXA_API_KEY` at all, delete the
`X-API-Key` header parameter from the HTTP Request node, it's a no-op either way.

## `sync_image.json` — one request, blocking

```text
[Manual Trigger] → [Set: sample TITLE/PRICE] → [HTTP Request: POST /v1/templates/story_pricing_pro/render]
```

Replace the **Set** node with whatever actually produces your row of data (Google
Sheets, a database node, a webhook trigger). The HTTP Request node:

| Field | Value |
| --- | --- |
| Method | `POST` |
| URL | `http://localhost:8080/v1/templates/story_pricing_pro/render` |
| Body | JSON: `{ "TITLE": "{{$json.title}}", "PRICE": "{{$json.price}}" }` |
| Response Format | **File** (so the node output is a binary item, ready for e.g. Telegram `sendPhoto`) |
| Header (optional) | `X-API-Key: {{$env.EAVEXA_API_KEY}}` |

Add whatever comes after — Telegram, Slack, S3 upload, etc. — reading the binary output
of this node directly.

Swap `story_pricing_pro` for your own template name (`eavexa templates list` to see
what's registered), and the format via `?format=` if it shouldn't use the template's
`default_format`.

## `async_video.json` — non-blocking, webhook callback

```text
[Manual Trigger] → [Set: sample data]
  → [HTTP Request: POST /v1/render, callback_url = {{$execution.resumeUrl}}]
  → [Wait: On Webhook Call]                              ← connection is not held
  → [IF event == "render.completed"]
       true  → [Read/Write Files from Disk] ← {{$json.body.result.path}}
       false → (handle render.failed — add alerting here)
```

The trick that makes this non-blocking: `$execution.resumeUrl` is a URL n8n reserves for
*this specific paused execution* before it even reaches the Wait node — you send that URL
to EAVexa as `callback_url`, EAVexa POSTs to it whenever the render finishes (possibly
minutes later, possibly after this n8n process restarts), and n8n resumes exactly this
workflow run at the Wait node with the webhook body as its output.

HTTP Request node body:

```json
{
  "source": { "name": "promo" },
  "video": { "duration": 30 },
  "callback_url": "{{ $execution.resumeUrl }}",
  "metadata": { "row_id": "{{ $json.row_id }}" }
}
```

Wait node: **Resume → On Webhook Call** (defaults are fine).

IF node condition: `{{ $json.body.event }}` equals `render.completed`. (Some n8n versions
place the incoming webhook body directly at `$json` instead of `$json.body` — if the
condition never matches, try `{{ $json.event }}` instead and check the Wait node's actual
output in the n8n editor.)

`metadata` comes back verbatim in the webhook payload — that's how you re-associate the
response with `row_id` (or whatever you put there) without any state kept in n8n itself.

**Why this beats the CLI's `--callback-url` from inside n8n**: an Execute Command node
running `eavexa render --callback-url ...` still blocks until that child process exits —
the CLI can't return early. The HTTP Request node above returns the moment EAVexa accepts
the job (`202`), and n8n's own Wait mechanism — not a held-open connection — is what
resumes the workflow later. See `docs/cli.md` → "Using from n8n today" for when the CLI
path is still the right tool (renders triggered by something other than n8n itself).

## Troubleshooting

- **`ECONNREFUSED`** — `eavexa serve` isn't running, or `EAVEXA_HOST`/port don't match
  the URL in the HTTP Request node. `eavexa doctor` on the EAVexa side doesn't check this
  (it's not a dependency check); confirm with `curl http://localhost:8080/healthz`.
- **`401`** — `EAVEXA_API_KEY` is set on the EAVexa side but the request has no (or the
  wrong) `X-API-Key` header.
- **Wait node never resumes** — check `eavexa jobs list --status failed` /
  `eavexa jobs show <id>` for the job; if `callback.state` is `failed_permanent` or stuck
  `pending`, the webhook delivery itself is the problem, not n8n. `POST
  /v1/jobs/:id/retry-callback` forces a fresh attempt without re-rendering.
- **Video too slow / times out in an unrelated way** — nothing on the n8n side times out
  waiting on a Wait node (it can wait indefinitely), so this usually means the render
  itself is failing; check `eavexa jobs show <id>` for `error`.
