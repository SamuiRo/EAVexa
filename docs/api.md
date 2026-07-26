# HTTP API

`eavexa serve` exposes the same `core/render_service.js` the CLI uses, over HTTP. Every
render — sync or async — goes through the identical normalization, browser pool, and
storage logic as `eavexa render`. This is what makes a genuine non-blocking
request/response flow from n8n possible for the first time (no more Execute Command
blocking for the render's full duration).

```bash
eavexa serve --port 8080
```

See `docs/cli.md` for the CLI, `docs/architecture.md` for the internals, and
`openapi.yaml` (repo root — actually `docs/openapi.yaml`) for a machine-readable route
reference.

## Base URL and auth

All routes are under `/v1/`, except `/healthz` and `/readyz`.

If `EAVEXA_API_KEY` is set, every `/v1/*` route (and `/v1/jobs/:id/result`, unless a valid
`?token=` is given — see below) requires a matching `X-API-Key` header. Unset means open
access — a deliberate trade-off documented for localhost-only / trusted-LAN deployments
(the same default n8n itself uses). `/healthz` is always open, for load balancer probes.

Every response carries `X-Request-Id` (echoes an inbound one, or mints a fresh one).

## Route map

| Method | Path | Description |
| --- | --- | --- |
| POST | `/v1/render` | Render (sync or async, depending on the request) |
| POST | `/v1/templates/:name/render` | Sugar: body is just the vars object |
| GET | `/v1/jobs` | List job records, newest first |
| GET | `/v1/jobs/:id` | Job status + progress + result |
| GET | `/v1/jobs/:id/result` | Stream the artifact (Range/ETag-aware) |
| DELETE | `/v1/jobs/:id` | Cancel (if running) or delete (if finished) |
| POST | `/v1/jobs/:id/retry-callback` | Force a fresh webhook delivery attempt |
| GET | `/v1/templates` | List templates in the registry |
| GET | `/v1/templates/:name` | Full manifest (variable schema) |
| GET | `/v1/templates/:name/preview` | Static `preview.png`, if the template has one |
| GET | `/v1/formats` | Built-in format presets |
| GET | `/v1/version` | eavexa/Node/Playwright versions |
| GET | `/healthz` | Liveness — always 200 if the process is up |
| GET | `/readyz` | Readiness — 503 if the render queue is saturated |

> Not implemented yet: `output.type: "s3"` / `"push"` (Крок 6 storage drivers) — a request
> for either is rejected with `INVALID_REQUEST` rather than silently accepted.

## `POST /v1/render`

```jsonc
{
  "source":   { "name": "story_pricing_pro" },        // or {"html":"…"} {"path":"…"} {"url":"…"}
  "format":   "story",                                 // preset key, "1080x1920@2", or {width,height,device_scale_factor}
  "vars":     { "TITLE": "Launch week", "PRICE": "$29" },
  "video":    { "duration": 5, "fps": 30, "crf": 18 },  // omit for an image
  "output":   { "type": "binary", "filename": "promo.mp4", "dir": "campaign_42" },
  "options":  { "timeout_ms": 60000, "offline": false, "strict_assets": false },
  "callback_url":     "http://localhost:5678/webhook/eavexa-done",
  "callback_headers": { "Authorization": "Bearer …" },
  "metadata":         { "row_id": 42 },
  "mode":             "async"                          // "sync" | "async", or omit to auto-decide
}
```

`source` — exactly one of `name` (registry), `html` (inline), `path` (local file, mainly
for same-host tooling), `url` (fetched, subject to `TEMPLATE_ALLOWED_HOSTS`).

**Sync vs. async** — if `callback_url` or `"mode":"async"` is given, or the request is
expensive enough (`cost.frames > SYNC_MAX_COST`, default 90 frames), the server responds
`202` immediately and renders in the background; otherwise it responds once the render is
done. `"mode":"sync"` forces the synchronous path even for an expensive request.

**`output.type`** controls the sync response body:

| Value | Sync response |
| --- | --- |
| `binary` *(default)* | Raw bytes, with `Content-Type`/`Content-Disposition`/`X-Render-*` headers |
| `base64` | `{ ok:true, result }` with `result.data` as base64 |
| `url` / `path` | `{ ok:true, result }`, no bytes — `result.path` and `result.url` are always both present regardless of this setting |

For **async** requests, `output.type` only matters once the job finishes — inspect it via
`GET /v1/jobs/:id`.

**200 (sync, `binary`)** — headers: `Content-Type`, `Content-Disposition`,
`Content-Length`, `X-Render-Id`, `X-Render-Width`, `X-Render-Height`,
`X-Render-Duration-Ms`, `X-Result-Path`.

**202 (async):**

```jsonc
{
  "ok": true,
  "job_id": "j_01JB2K7QW8ZC3M",
  "status": "queued",
  "queue_position": 3,
  "estimate_ms": null,          // no historical timing data yet — never fabricated
  "poll_url":   "/v1/jobs/j_01JB2K7QW8ZC3M",
  "result_url": "/v1/jobs/j_01JB2K7QW8ZC3M/result"
}
```

**`Idempotency-Key` header** — a repeated request with the same key within
`IDEMPOTENCY_TTL_MS` (default 10 min) returns the original job/result instead of
rendering again. Keyed only by the header value (not a body fingerprint) — reusing a key
across genuinely different payloads returns the first request's result, by design of the
simple in-memory store.

**Even synchronous renders get a job record.** So that `result.url` is always a real,
fetchable link (`GET /v1/jobs/:render_id/result`), the server persists a `done` job record
for every render made through this endpoint, sync or async. CLI/`data/jobs.json` renders
don't do this (no server context to serve a URL from — see `docs/decisions.md` §Р2.1).

## `POST /v1/templates/:name/render`

Body is **just the variables**, no wrapper — the shortest call from an n8n HTTP Request
node passing the previous node's data through as-is:

```jsonc
{ "TITLE": "Launch week", "PRICE": "$29" }
```

Query string overrides: `?format=story&type=path&mode=async&callback_url=…`. Format and
`video` otherwise come from the template's manifest.

## `GET /v1/jobs/:id`

```jsonc
{
  "ok": true,
  "job": {
    "id": "j_01JB2K7QW8ZC3M",
    "status": "running",          // queued | running | done | failed | cancelled
    "mode": "async",
    "progress": { "phase": "capture", "current": 62, "total": 150, "ratio": 0.36 },
    "created_at": "…", "started_at": "…", "finished_at": null,
    "template": "story_pricing_pro",
    "type": "video",
    "metadata": { "row_id": 42 },
    "result": null,
    "error": null,
    "callback": { "url": "…", "state": "pending", "delivered": false, "attempts": [] }
  }
}
```

`GET /v1/jobs?status=done&limit=20&before=<id>&after=<id>` paginates newest-first;
`before`/`after` are job-id cursors (IDs sort lexicographically by creation time).

## `GET /v1/jobs/:id/result`

- Streams the file (`fs.createReadStream`, never buffers the whole thing in memory).
- `Range: bytes=…` → `206 Partial Content`.
- `ETag` = the result's checksum; `If-None-Match` → `304 Not Modified`.
- No compression is ever applied (there's no compression middleware in this server at all).
- `?token=<signed>` — when `RESULT_TOKEN_SECRET` is set, a token signed with
  `core/result_token.js` can substitute for `X-API-Key`, so a link can be shared without
  the main key. No secret configured = `?token=` never verifies, main auth always applies.
- `410 RESULT_GONE` if the file has been removed from disk since the job finished (no
  automatic retention deletes anything today — this only fires if you manually delete
  the artifact).

## `DELETE /v1/jobs/:id`

If the job is `queued`/`running`, cancels it (best-effort — see the note on `cancel` below).
If it already finished, deletes both the job record **and** its result file.

> `cancel` (via `DELETE` on a running job) can only interrupt a render that is executing
> in the very same server process — there's no distributed job coordination. Since
> `eavexa serve` is a single process holding all job state, this is actually fully
> reliable in the one-server deployment this project targets; it just doesn't extend to
> a hypothetical multi-instance setup.

## `POST /v1/jobs/:id/retry-callback`

Forces a fresh webhook delivery attempt, bypassing the normal
"already delivered / already permanently failed" guard — for a human saying "the endpoint
is back up now, please try again."

## Templates, formats, version

`GET /v1/templates[?tag=…&kind=…&refresh=1]`, `GET /v1/templates/:name`,
`GET /v1/templates/:name/preview` (serves the template's static `preview.png` if one
exists — this is a checked-in asset, not a render, so there's nothing to cache or compute).
`GET /v1/formats`, `GET /v1/version` are static/cheap lookups.

## Error format

```jsonc
{
  "ok": false,
  "error": {
    "code": "MISSING_REQUIRED_VAR",
    "message": "Template \"story_pricing_pro\" requires var \"PRICE\"",
    "details": { "template": "story_pricing_pro", "var": "PRICE" },
    "request_id": "req_01JB2K…"
  }
}
```

Codes and their HTTP status come from `core/errors.js` — the same table the CLI's exit
codes use. `NOT_FOUND` (no matching route) and `METHOD_NOT_ALLOWED` are server-routing
concerns handled the same envelope shape but aren't in that shared table.

## Webhooks

Delivery mechanics (HMAC signing, retry backoff, blocked hosts) are shared with the CLI's
`--callback-url` and documented in `docs/architecture.md` under "Jobs & Webhooks" — the
HTTP server doesn't change any of that, it's the same `core/webhook_notifier.js`.

## Lifecycle

`SIGTERM`/`SIGINT` → stop accepting new connections, wait up to `SHUTDOWN_GRACE_MS`
(default 30s) for in-flight renders to finish, then close the browser pool and exit.
`/readyz` returns `503` once the render queue is saturated (`QUEUE_MAX`); it does **not**
currently probe Chromium/FFmpeg liveness directly (that's `eavexa doctor`'s job, which can
afford to spawn processes) — a deliberate scope simplification.

## Using from n8n

This is the flow the CLI's Execute Command approach couldn't offer: a real non-blocking
request that returns immediately and calls back later. **`docs/n8n.md` has ready-to-import
workflow JSON for both patterns below**, plus troubleshooting; this section is the quick
reference.

**Image — synchronous, one node:**

```text
[Schedule] → [Google Sheets: read row]
          → [HTTP Request]
               POST http://localhost:8080/v1/templates/story_pricing_pro/render
               Body: { "TITLE": "{{$json.title}}", "PRICE": "{{$json.price}}" }
               Response Format: File
          → [Telegram: sendPhoto]
```

**Video — asynchronous, connection never held open:**

```text
[Schedule] → [HTTP Request]
               POST http://localhost:8080/v1/render
               { "source": {"name":"promo"}, "video": {"duration":30},
                 "callback_url": "{{$execution.resumeUrl}}",
                 "metadata": {"row_id":"{{$json.id}}"} }
          → [Wait: On Webhook Call]                    ← connection is not held
          → [IF event == "render.completed"]
          → [Read/Write Files from Disk]  ← {{ $json.result.path }}
          → [YouTube: upload]
```

`metadata` comes back in the webhook body as-is — that's how n8n re-associates the
response with the original row of data.
