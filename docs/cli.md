# CLI

`eavexa` is a thin front-end over `core/render_service.js` — the same core the legacy
`data/jobs.json` runner and, eventually, the HTTP API (Крок 4) use. Every command that
renders goes through the same normalization, browser pool, and storage logic.

> Status: Крок 2 of `docs/specification.md`. `render`, `batch`, `templates`, `formats`,
> and `doctor` exist. `serve` and `jobs` (HTTP server, async job queue, webhooks) are not
> implemented yet — see `docs/specification.md` §16 for the roadmap.

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
eavexa render     [options]              # render one template
eavexa batch      [--jobs <path>]        # render every enabled job in data/jobs.json
eavexa templates  <list|show> [name]
eavexa formats
eavexa doctor
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

## Using from n8n today

Without an HTTP server yet (Крок 4), the reliable integration point is **Execute Command**
calling `eavexa render ... --json`, parsing the single JSON line for `result.path`:

```text
[Schedule] → [Execute Command]
    Command: npx eavexa render -t story_pricing_pro --var TITLE="{{$json.title}}" \
             --var PRICE="{{$json.price}}" -o /data/outputs/{{$json.id}}.png --json
    (parse stdout as JSON in a Code/Set node)
→ [Read/Write Files from Disk] ← {{ $json.path }}
```

Long video renders block the Execute Command node for the render's full duration — there
is no async/webhook path until job queue + HTTP land in Крок 3/4.
