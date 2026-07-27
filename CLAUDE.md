# CLAUDE.md — AI Agent Context

> This file is the primary context source for AI assistants (Claude, Copilot, Cursor, etc.).
> Read this before writing or modifying any code in this project.
> For humans: see `README.md` and `docs/`.

---

## Project overview

**Name:** EAVexa  
**Type:** CLI tool + REST API + batch runner (one core render service behind all three)  
**Purpose:** Render HTML templates to PNG images and MP4/WebM/MOV/MKV videos, pixel-accurately and deterministically.  
**Status:** Active (2.0.x)

---

## Tech stack

| Layer       | Technology                                        |
|-------------|---------------------------------------------------|
| Runtime     | Node.js >=18 (ESM, `"type": "module"`)            |
| Language    | JavaScript (no TypeScript)                        |
| Package mgr | npm                                               |
| Browser     | Playwright + Chromium (rendering and screenshots) |
| Encoding    | FFmpeg via `ffmpeg-static` (bundled binary)       |
| Persistence | JSON files under `data/` — no database            |
| HTTP        | Node `node:http` server, global `fetch` client    |
| CLI output  | `chalk`, `gradient-string`                        |
| Tests       | `node --test` (no external test runner)           |

---

## Code style rules (enforce strictly)

### Naming
- **Classes:** `PascalCase` — `class UserManager`
- **Methods & properties:** `snake_case` — `get_user()`, `this.retry_count`
- **Variables & params:** `snake_case` — `const user_id = ...`
- **Constants (module-level):** `UPPER_SNAKE_CASE` — `const MAX_RETRIES = 3`
- **Files:** `snake_case.js`— `app_config.js`

### Functions
- Use **declared functions** (`function do_thing() {}`) for all top-level and module functions
- Use **arrow functions** only when required by context (class callbacks, `.map()`, `.filter()`)
- All exported utilities are standalone functions, not methods

### Modules
- Write features as **classes** — one class per file, default export
- Keep classes focused — if a class has >5 unrelated methods, split it
- Import order: node built-ins → npm packages → local files

### Style
- Single quotes `"` for strings
- 2-space indentation
- Trailing commas in multiline objects/arrays
- Align object values with spaces when 3+ keys share a block
- Always `async/await`, never `.then()` chains
- Always handle errors with `try/catch`, never silent failures

### Comments
- Section headers use: `// ─── Section name ────────────────────`
- JSDoc for all exported functions
- Inline comments only for non-obvious logic

---

## Shared utilities quick reference

```js
import { print, banner, divider }                    from './shared/utils.js';
import { sleep, jitter, measure, retry }             from './shared/utils.js';
import { save_json, load_json, save_txt, append_txt } from './shared/utils.js';
import { chunk, unique, format_bytes, format_duration } from './shared/utils.js';
```

| Function          | Purpose                                      |
|-------------------|----------------------------------------------|
| `print(text, type)` | Styled log with timestamp. Types: `info` `system` `data` `warning` `success` `debug` `error` |
| `banner(text, sub)` | Print ASCII art banner with optional subtitle |
| `divider(label?)`   | Print section separator line                 |
| `sleep(ms)`         | Async delay                                  |
| `jitter(min, max)`  | Random delay (anti-rate-limit)               |
| `measure(fn)`       | Time an async function                       |
| `retry(fn, n, ms)`  | Retry async fn up to n times                 |
| `save_json(path, data)` | Write JSON to file                       |
| `load_json(path)`   | Read + parse JSON, returns null on error     |
| `save_txt(path, text)` | Write text to file                        |
| `append_txt(path, text)` | Append line to file                    |
| `file_exists(path)` | Check if path exists                         |
| `chunk(array, n)`     | Split array into chunks of size n            |
| `unique(array)`       | Remove duplicates from array                 |
| `format_bytes(n)`   | `1024 → "1.0 KB"`                            |
| `format_duration(ms)` | `90000 → "1m 30s"`                         |

---

## Source map

| Location                    | Responsibility                                                        |
|-----------------------------|-----------------------------------------------------------------------|
| `src/core/`                 | `RenderService` (the single render entry point), queue, browser pool, job store, storage, template registry, webhook notifier |
| `src/modules/renderer/`     | `ImageRenderer`, `VideoRenderer`, `FfmpegEncoder`                     |
| `src/modules/jobs/`         | `jobs.json` loading and render-job building                           |
| `src/modules/orchestrator/` | Batch run orchestration and result reporting                          |
| `src/cli/`                  | `eavexa` command and subcommands                                      |
| `src/server/`               | HTTP server, router, routes, auth                                     |
| `src/config/`               | `app_config.js` (all env vars), `render_config.js` (formats)          |
| `src/shared/`               | `utils.js`, `logger.js`, `messages.js`, `html_template.js`, `chromium.js` |

There is no database module and no secrets module — see *Configuration* below.

**Logging:** `src/shared/logger.js` exports `log({ level, msg })` and is what `src/core/`,
`src/server/`, and `src/modules/renderer/` use. `print()` from `utils.js` is for CLI-facing
output. Do not use raw `console.log` in either case.

---

## Key conventions for AI agents

1. **Never** access `process.env` outside `app_config.js`
2. **Never** use raw `console.log` — `log({ level, msg })` from `shared/logger.js` inside
   the render pipeline, `print()` from `shared/utils.js` for CLI-facing output
3. **Always** use `async/await` — no `.then()` chains
4. **Always** handle errors with `try/catch` — no silent failures
5. Shared helpers go in `src/shared/utils.js` as exported functions
6. Static strings go in `src/shared/messages.js`
7. The `data/` directory is runtime-only and gitignored — never hardcode paths, use `DATA_DIR` from config
8. Tests use `node --test` only — do not add a test framework dependency
9. Every render path goes through `RenderService` — CLI, HTTP, and `jobs.json` must not
   call the renderers directly

---

## Configuration

This project has no keychain integration and no `secrets_cli.js`. Configuration is plain
environment variables, read from `.env` in local development via `dotenv`.

- Every variable is read in `src/config/app_config.js` and exported as a constant.
- Never touch `process.env` anywhere else.
- Every variable has a working default, so an empty `.env` still runs.
- `.env.example` documents all of them; `docs/architecture.md` has the reference table.

`RESULT_TOKEN_SECRET` and `EAVEXA_API_KEY` are the only genuinely secret values. In production
and Docker they are set as real environment variables, not committed to `.env`.
