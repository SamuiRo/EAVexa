# CLI

`eavexa` is a thin front-end over `core/render_service.js` — the same core the legacy
`data/jobs.json` runner and the HTTP API (`docs/api.md`) use. Every command that renders
goes through the same normalization, browser pool, and storage logic.

> Status: Крок 4 of `docs/specification.md`. Every command exists, including `serve`
> (the HTTP API). For a genuine non-blocking request/response flow from n8n, prefer
> `eavexa serve` + `docs/api.md` over the Execute Command approach below — see "Using
> from n8n today" for when each makes sense.

## Install / run locally

```bash
npm install
npx playwright install chromium
node src/cli/cli.js <command> ...     # from the project directory
```

Once published, `npm install -g eavexa` (or `npx eavexa`) exposes the `eavexa` binary
directly (`package.json` declares `bin.eavexa`).

## Commands

```text
eavexa render     [options]              # render one template (sync, or async with --callback-url)
eavexa batch      [--jobs <path>]        # render every enabled job in data/jobs.json
eavexa templates  <list|show> [name]
eavexa formats
eavexa doctor
eavexa jobs       <list|show|cancel|prune|stats>
eavexa serve      [--port 8080]           # HTTP API — see docs/api.md
```

Every command supports `--help` and, where it makes sense, `--json` for machine-readable
output.

## Output discipline

| Mode | stdout | stderr |
| --- | --- | --- |
| default (human) | pretty colored output | — |
| `--json` | **exactly one** JSON object | banner, logs, progress |
| `render -o -` | raw output bytes | banner, logs |

This is what makes `eavexa` safe to pipe: `eavexa render ... --json \| jq .path` or
`eavexa render ... -o - > out.png` never has log lines mixed into the payload.

## `eavexa render`

```bash
eavexa render -t story_pricing_pro --var TITLE="Launch week" --var PRICE='$29' -o ./out.png
eavexa render --file ./my.html --format story -o ./out.png
cat my.html | eavexa render --stdin --format story -o - > out.png
echo '{"source":{"name":"story_faq"},"format":"story"}' | eavexa render --request - --json
eavexa render -t promo --video-duration 8 --fps 30 -o ./promo.mp4
eavexa render -t story_faq --file ./story_faq.html --watch --open
```

**Source — exactly one of:**

| Flag | Meaning |
| --- | --- |
| `-t, --template <name>` | Template from the registry (`templates/`, `data/templates/`) |
| `--file <path>` | HTML file on disk |
| `--url <url>` | Remote HTML document |
| `--stdin` | Read HTML from stdin |
| `--request <path\|->` | Full JSON request (same shape `normalize_request()` produces/accepts) — bypasses every other source/format/var flag |

**Format & vars:**

| Flag | Meaning |
| --- | --- |
| `-f, --format <key\|WxH[@dpr]>` | A `formats` key (`story`) or raw dimensions (`1080x1920@2`) |
| `--var K=V` | Template variable (repeatable) |
| `--vars-file <path>` | JSON file of variables, merged before `--var` overrides |

**Video (adding `--video-duration` switches the render to video mode):**

`--video-duration <sec>` `--fps <n>` `--crf <n>` `--preset <name>` `--keep-frames`

**Output:**

| Flag | Meaning |
| --- | --- |
| `-o, --out <path\|->` | Write to this exact path, or `-` to stream raw bytes to stdout. Omit it to let the render land in the default `OUTPUT_DIR` layout. |

**Network / limits:**

`--offline` (block all external requests) · `--strict-assets` (fail on any asset load
error) · `--timeout <ms>`

**Async + webhook:**

| Flag | Meaning |
| --- | --- |
| `--callback-url <url>` | Run as a durable job (`RenderService.submit()`) and POST the result here when done, instead of blocking on the sync path |
| `--callback-header K=V` | Extra header on the callback request (repeatable) |

```bash
eavexa render -t promo --video-duration 30 -o ./promo.mp4 \
              --callback-url http://localhost:5678/webhook/eavexa-done
```

The job record is durable (`data/jobs/`) and the webhook is HMAC-signed (`WEBHOOK_SECRET`)
with retries — see "Jobs & webhooks" in `docs/architecture.md` for the full mechanics.
**This still keeps the CLI process running** until the render and first delivery attempt
finish; there's no background daemon yet (Крок 4). What it buys you: the render request
and the callback are decoupled from whatever *triggered* the CLI call, and a failed
delivery is retried durably rather than lost — see "Using from n8n today" below for when
that's actually useful versus just using the plain sync path.

**Output mode:**

`--json` · `--quiet` · `--verbose`

**Development conveniences:**

- `--dry-run` — print the fully normalized request (post-validation, post-defaults) and
  render nothing. Useful for checking what a template/format/vars combination resolves to.
- `--watch` — requires `--file`; re-renders whenever that file changes.
- `--open` — open the rendered file with the OS default handler after the first
  successful render.

**Exit codes** (from `core/errors.js`, same table the future HTTP API uses):
`0` success · `1` render failed · `2` invalid input · `3` timeout · `4` missing dependency
(Chromium/FFmpeg).

## `eavexa batch`

Runs the exact same workflow as `npm start`: loads `data/jobs.json`, builds a render
request per enabled job, submits them all to `RenderService` (image/video concurrency
lanes applied automatically), and reports results.

```bash
eavexa batch                       # data/jobs.json
eavexa batch --jobs ./other.json --json
```

## `eavexa templates`

```bash
eavexa templates list [--json]
eavexa templates show story_pricing_pro
```

`list` shows every template the registry can see (`data/templates/` overrides
`templates/`), including ones with no `template.json` (`inferred: true` — the manifest is
built from `{{KEY}}` placeholders found in the HTML). `show` prints the full manifest,
including the variable schema.

## `eavexa formats`

Lists the built-in format presets from `src/config/render_config.js`. Custom dimensions
don't need a preset — pass `WxH@dpr` directly to `render --format`.

## `eavexa doctor`

Checks Node version, Chromium (path + existence), FFmpeg (path + `libx264`/`libvpx-vp9`
codec availability), and that `TMP_DIR`/`OUTPUT_DIR` are writable. Exits `4` if anything
fails — useful as a pre-flight step in CI or before deploying to a new host.

```bash
eavexa doctor
eavexa doctor --json
```

## `eavexa jobs`

Inspect and manage the async job records created by `render --callback-url`.

```bash
eavexa jobs list [--status done] [--limit 20] [--json]
eavexa jobs show <id>
eavexa jobs cancel <id>
eavexa jobs prune [--older-than 30d] [--status failed] [--keep-last 500] [--dry-run]
eavexa jobs stats
```

`prune` deletes both the job record **and** its result file — it is the manual retention
mechanism until `RETENTION_MODE` (Крок 6) exists. `--dry-run` reports what would be
deleted without touching anything. `cancel` can only interrupt a render that is still
running in the very same OS process; against a job from a different (or already-exited)
process it just marks the stored record `cancelled`.

## `eavexa serve`

Starts the HTTP API — `POST /v1/render`, `GET /v1/jobs/*`, etc. Full reference:
`docs/api.md` (+ `docs/openapi.yaml`).

```bash
eavexa serve --port 8080
```

`SIGTERM`/`SIGINT` trigger a graceful shutdown: stop accepting new connections, wait up to
`SHUTDOWN_GRACE_MS` for in-flight renders, close the browser pool, exit.

## Using from n8n today

**Prefer `eavexa serve` (`docs/api.md`) for anything n8n-initiated** — it's a real
non-blocking request/response, unlike either CLI option below.

The CLI remains useful for renders triggered by something other than an n8n HTTP node —
**Execute Command** calling `eavexa render ... --json`, parsing the single JSON line for
`result.path`:

```text
[Schedule] → [Execute Command]
    Command: npx eavexa render -t story_pricing_pro --var TITLE="{{$json.title}}" \
             --var PRICE="{{$json.price}}" -o /data/outputs/{{$json.id}}.png --json
    (parse stdout as JSON in a Code/Set node)
→ [Read/Write Files from Disk] ← {{ $json.path }}
```

Long video renders block the Execute Command node for the render's full duration — with
`eavexa serve` running, an **HTTP Request** node hitting `POST /v1/render` with
`callback_url` avoids that entirely (see `docs/api.md` → "Using from n8n").

**A note on `--callback-url` from n8n's Execute Command specifically:** it does *not* make
that node return sooner — it waits for the child process to exit either way, and
`--callback-url` keeps the CLI process alive until delivery, not shorter. Its actual value
is for renders triggered **outside** n8n entirely — a cron job, Windows Task Scheduler, or
any other script — that should notify an n8n workflow when done without n8n having to poll
or hold a connection open:

```text
[Task Scheduler / cron] → eavexa render -t promo --video-duration 30 -o ./promo.mp4 \
                                          --callback-url {{n8n Webhook node URL}}
                                          (this process runs and exits on its own)

[n8n: Webhook node] → receives render.completed/render.failed → [IF] → ...
```

For a genuine non-blocking request/response flow *from* n8n itself (send a request, get
an immediate acknowledgement, get called back later), use `eavexa serve` — see
`docs/api.md` → "Using from n8n".
