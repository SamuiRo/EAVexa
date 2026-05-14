# CLAUDE.md — AI Agent Context

> This file is the primary context source for AI assistants (Claude, Copilot, Cursor, etc.).
> Read this before writing or modifying any code in this project.
> For humans: see `README.md` and `docs/`.

---

## Project overview

<!-- Fill in when starting a new project -->

**Name:** [Project name]  
**Type:** [CLI tool | REST API | Bot | Scraper | MCP server | Web app]  
**Purpose:** [One sentence — what does this do and why]  
**Status:** [In development | Active | Maintenance]

---

## Tech stack

| Layer       | Technology                        |
|-------------|-----------------------------------|
| Runtime     | Node.js (ESM, `"type": "module"`) |
| Language    | JavaScript (no TypeScript)        |
| Package mgr | npm                               |
| Database    | SQLite / none                     |
| HTTP client | axios / fetch                     |
| Other       | [list key libraries]              |


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

## Environment variables

All env vars are centralized in `src/config/app_config.js`.  
Never access `process.env` directly outside that file.  
See `.env.example` for required variables.

---

## Optional built-in modules

| Module   | Location                          | Use when                              |
|----------|-----------------------------------|---------------------------------------|
| DbManager | `src/modules/db/index.js`        | Project uses SQLite storage           |
| Logger   | `src/modules/logger/index.js`     | Need persistent log files in `data/logs/` |

**DbManager quick reference:**
```js
const db = new DbManager();   // uses DB_PATH from config
await db.connect();            // opens connection + runs migrations
db.run(sql, params)            // INSERT / UPDATE / DELETE
db.get(sql, params)            // single row or undefined
db.all(sql, params)            // all matching rows
db.transaction(fn)             // atomic multi-statement block
db.close()                     // clean shutdown
```

---

## Key conventions for AI agents

1. **Never** access `process.env` outside `app_config.js`
2. **Always** use `print()` from utils — never raw `console.log` in modules
3. **Always** use `async/await` — no `.then()` chains
5. Shared helpers go in `src/shared/utils.js` as exported functions
6. Static strings go in `src/shared/messages.js`
7. The `data/` directory is runtime-only and gitignored — never hardcode paths, use `DATA_DIR` from config
8. `sharp` are optional — only install if the project uses them

---

## Secrets management

Secrets (API keys, tokens, passwords) are stored in the OS keychain — NOT in `.env`.

**Platform:** Windows Credential Manager / Linux libsecret / macOS Keychain  
**CLI tool:** `secrets_cli.js` (project root)  
**Module:** `src/modules/secrets/index.js`

```bash
# First-time setup: move .env contents to keychain
npm run secrets:import

# Day-to-day
npm run secrets:list                        # list all stored keys
node secrets_cli.js set API_KEY             # add/update a secret (prompts for value)
node secrets_cli.js get API_KEY             # print a value
node secrets_cli.js delete API_KEY          # remove
node secrets_cli.js export                  # dump to .env.exported (gitignored)
```

**In code — never `process.env` for secrets. Use async getters from config:**
```js
import { get_telegram_token } from '../../config/app_config.js';
const token = await get_telegram_token();
```

**In production / Docker:** set env vars normally — `secret()` checks `process.env` first,
keychain is only used as fallback for local dev.
