# EAVexa — Implementation Plan (CLI + HTTP + Webhooks + Template Registry)

> Технічна специфікація під реалізацію.
> Аналіз «чому саме так» — у [pipeline_integration_plan.md](./pipeline_integration_plan.md).
> Цей документ описує **що саме писати**: файли, сигнатури, контракти, порядок.
>
> ⚠️ **Застаріло частково.** Головний документ для реалізації —
> [specification.md](./specification.md): він зводить цей план разом із рішеннями
> з [decisions.md](./decisions.md) (bare metal як основа, retention `keep`,
> `path` + `url` одночасно, доставка великих файлів). Цей файл лишається як чернетка структури.

---

## 0. Три рівнозначні фронти

Не «HTTP головний, CLI бонус». Три рівноправні адаптери над одним ядром:

```text
   CLI                    HTTP API                jobs.json (legacy)
   eavexa render          POST /v1/render         npm start
   eavexa batch           POST /v1/jobs
   eavexa serve           GET  /v1/templates
        │                      │                        │
        └──────────────────────┼────────────────────────┘
                               ▼
                      ┌─────────────────┐
                      │  RenderService  │   src/core/render_service.js
                      └────────┬────────┘
        ┌────────────┬─────────┼─────────┬────────────┬──────────────┐
        ▼            ▼         ▼         ▼            ▼              ▼
 TemplateRegistry BrowserPool RenderQueue JobStore StorageAdapter WebhookNotifier
        │                      │
        │              ImageRenderer / VideoRenderer → FfmpegEncoder   (існують)
        ▼
  templates/ (built-in)  +  $TEMPLATES_DIR (user)
```

**Наслідок, який визначає структуру коду:** `JobStore` і `WebhookNotifier` живуть у `core/`,
а не в `server/`. Тоді `eavexa render --callback-url …` з cron-а працює точно так само, як
HTTP-запит з n8n. Один код доставки, одна поведінка, один набір тестів.

---

## 1. Реєстр шаблонів

### 1.1 Дві директорії

| Шар | Шлях | Призначення |
| --- | --- | --- |
| built-in | `templates/` (у репозиторії, **не** в `.gitignore`) | шаблони, що їдуть разом із додатком і Docker-образом |
| user | `$TEMPLATES_DIR` (дефолт `data/templates`, у Docker — том `/templates`) | шаблони користувача |

Резолв за іменем: спершу user, потім built-in (user перекриває built-in з тим самим ім'ям).
Наявні `data/inputs/<job_id>/` продовжують працювати як третій, legacy-шар для `jobs.json`.

**Міграція:** скопіювати поточні 10 шаблонів зі `data/inputs/` у `templates/` і зняти
`data/inputs/` з `.gitignore`-логіки (лишити ігнор, але built-in тепер у `templates/`).

### 1.2 Структура шаблону

```text
templates/story_pricing_pro/
  template.json      # маніфест (опційний, але дуже бажаний)
  template.html      # entry
  preview.png        # опційно; генерується `eavexa templates preview`
  fonts/  images/    # локальні ассети
```

### 1.3 Маніфест `template.json`

```jsonc
{
  "name":        "story_pricing_pro",
  "title":       "Pricing — Pro plan",
  "description": "Instagram story з тарифом Pro",
  "version":     "1.0.0",
  "entry":       "template.html",
  "kind":        "image",              // image | video | both
  "default_format":    "story",
  "supported_formats": ["story", "post_portrait"],
  "video": { "duration": 5, "fps": 30 },   // дефолти, якщо kind підтримує відео
  "vars": [
    {
      "name":        "TITLE",
      "type":        "string",          // string | number | boolean | color | url | html
      "required":    true,
      "default":     "",
      "description": "Заголовок картки",
      "example":     "Launch week",
      "max_length":  60
    },
    { "name": "PRICE", "type": "string", "required": true, "example": "$29" }
  ],
  "tags": ["pricing", "story", "en"]
}
```

### 1.4 Інференс маніфесту (важливо для сумісності)

Якщо `template.json` немає — реєстр **сам збирає** маніфест:

- `name` = ім'я директорії,
- `entry` = `template.html` (або єдиний `.html` у корені),
- `vars` = унікальні `{{KEY}}`, знайдені регуляркою в HTML, усі `type:"string"`, `required:false`,
- `kind` = `"both"`, `default_format` = `null`,
- прапорець `"inferred": true` у відповіді API.

Так усі 10 наявних шаблонів працюють через API **без жодних правок**.

### 1.5 API реєстру

```js
// src/core/template_registry.js
export default class TemplateRegistry {
  constructor({ builtin_dir, user_dir, cache_ttl_ms })

  async list({ tag, kind } = {})   // → [{ name, title, kind, source:'builtin'|'user',
                                   //      default_format, vars_count, has_preview, inferred }]
  async get(name)                  // → повний маніфест | throws TEMPLATE_NOT_FOUND
  async resolve(name)              // → { manifest, html_path, base_dir }
  async read_html(name)            // → рядок HTML
  validate_vars(manifest, vars)    // → { values, errors:[{var, code, message}] }
  async reload()                   // ре-скан (викликається у watch-режимі та по /v1/templates?refresh=1)
}
```

`validate_vars` — це те, що робить HTTP зручним: відсутній обов'язковий `TITLE`
дає `400 MISSING_REQUIRED_VAR` замість тихого рендеру літерального `{{TITLE}}` у картинці.
Дефолти з маніфесту підставляються автоматично.

---

## 2. HTTP API

### 2.1 Мапа ендпоїнтів

| Метод | Шлях | Опис |
| --- | --- | --- |
| `POST` | `/v1/render` | рендер: sync або async — залежно від тіла |
| `GET` | `/v1/jobs` | список джобів (`?status=&limit=&offset=`) |
| `GET` | `/v1/jobs/:id` | стан + прогрес + результат |
| `GET` | `/v1/jobs/:id/result` | сам артефакт (бінарник) |
| `DELETE` | `/v1/jobs/:id` | скасувати активний / видалити завершений |
| `POST` | `/v1/jobs/:id/retry-callback` | переслати webhook вручну |
| `GET` | `/v1/templates` | список шаблонів |
| `GET` | `/v1/templates/:name` | маніфест зі схемою змінних |
| `GET` | `/v1/templates/:name/preview` | PNG-прев'ю (кешоване) |
| `POST` | `/v1/templates/:name/render` | цукор: рендер шаблону, тіло = самі `vars` |
| `GET` | `/v1/formats` | пресети форматів |
| `GET` | `/healthz` `/readyz` | liveness / readiness |
| `GET` | `/v1/version` | версія, playwright, ffmpeg, chromium |

### 2.2 `POST /v1/render` — єдиний ендпоїнт, два режими

```jsonc
{
  "template": { "name": "story_pricing_pro" },      // або {"html":"…"} / {"url":"https://…"}
  "format":   "story",                               // або {width,height,device_scale_factor}
  "vars":     { "TITLE": "Launch week", "PRICE": "$29" },
  "video":    { "duration": 5, "fps": 30, "crf": 18 },   // присутній → відео
  "output":   { "type": "binary", "filename": "promo.png" },
  "options":  { "timeout_ms": 60000, "settle_ms": 200 },

  "callback_url":     "http://n8n:5678/webhook/eavexa-done",   // ← наявність = async
  "callback_headers": { "Authorization": "Bearer …" },
  "callback_include": "meta",                                   // meta | base64
  "metadata":         { "row_id": 42 }                          // ехо назад у webhook
}
```

**Правило вибору режиму** (просте й передбачуване):

| Умова | Режим | Відповідь |
| --- | --- | --- |
| є `callback_url` **або** `"mode":"async"` | async | `202` + envelope джоба |
| інакше, і оцінена вартість ≤ `SYNC_MAX_COST` | sync | `200` + результат/бінарник |
| інакше (важке відео без callback) | async | `202` + envelope + `Warning`-заголовок |

Оцінка вартості: `frames = duration × fps`; поріг `SYNC_MAX_COST` у кадрах (дефолт `90` ≈ 3 c відео).
Картинка = 1 кадр → завжди sync. Це гарантує, що HTTP-з'єднання ніколи не висить хвилинами.

**202 envelope:**

```jsonc
{
  "ok": true,
  "job_id": "j_01JB2K7QW8ZC3M",
  "status": "queued",
  "queue_position": 3,
  "estimate_ms": 18000,
  "poll_url":   "/v1/jobs/j_01JB2K7QW8ZC3M",
  "result_url": "/v1/jobs/j_01JB2K7QW8ZC3M/result",
  "callback_url": "http://n8n:5678/webhook/eavexa-done"
}
```

**200 sync** — при `output.type:"binary"` сирі байти + заголовки
`Content-Type`, `Content-Disposition`, `X-Render-Id`, `X-Render-Width`, `X-Render-Height`,
`X-Render-Duration-Ms`. При `"base64"`/`"url"`/`"file"` — JSON (див. §5.1 попереднього документа).

### 2.3 `GET /v1/jobs/:id`

```jsonc
{
  "ok": true,
  "job": {
    "id": "j_01JB2K7QW8ZC3M",
    "status": "running",                  // queued|running|done|failed|cancelled|expired
    "progress": { "phase": "capture", "current": 62, "total": 150, "ratio": 0.41 },
    "created_at": "2026-07-25T10:00:00.000Z",
    "started_at": "2026-07-25T10:00:02.100Z",
    "finished_at": null,
    "template": "story_pricing_pro",
    "type": "video",
    "metadata": { "row_id": 42 },
    "result": null,
    "error": null,
    "callback": { "url": "http://n8n:5678/…", "delivered": false, "attempts": [] }
  }
}
```

`phase`: `queued → load → capture → encode → store → done`.
Прогрес для відео оновлюється у циклі кадрів (`VideoRenderer` отримує колбек `on_progress`).

### 2.4 `POST /v1/templates/:name/render` — цукор для n8n

Тіло — це **просто змінні**, без обгорток:

```jsonc
{ "TITLE": "Launch week", "PRICE": "$29" }
```

Формат береться з `default_format` маніфесту, вихід — `binary`.
Query-параметри перекривають: `?format=story&type=base64&callback_url=…`.
Це найкоротший можливий виклик з n8n — один URL, тіло з даних попередньої ноди як є.

---

## 3. Webhooks (async-контракт)

### 3.1 Payload

```jsonc
{
  "event": "render.completed",           // render.completed | render.failed
  "job_id": "j_01JB2K7QW8ZC3M",
  "delivery_id": "d_01JB2K8T…",
  "sent_at": "2026-07-25T10:00:21.400Z",
  "template": "story_pricing_pro",
  "metadata": { "row_id": 42 },
  "result": {
    "type": "video",
    "mime": "video/mp4",
    "filename": "promo.mp4",
    "bytes": 4193021,
    "width": 2160, "height": 3840, "dpr": 2,
    "duration": 5, "fps": 30, "frames": 150,
    "duration_ms": 18422,
    "result_url": "http://eavexa:8080/v1/jobs/j_01JB2K7QW8ZC3M/result",
    "expires_at": "2026-07-25T11:00:21.400Z",
    "data": null                          // base64, лише при callback_include:"base64"
  },
  "error": null
}
```

Для `render.failed` — `result: null`, `error: { code, message, details }`.

**Бінарник за замовчуванням НЕ вкладається у webhook.** Причини: 4 МБ base64 у тілі
вебхука ламає ліміти n8n і роздуває пам'ять. Правильний потік: webhook → n8n бачить
`result_url` → друга нода HTTP Request завантажує файл. Для картинок < `CALLBACK_INLINE_MAX_BYTES`
(дефолт 256 КБ) можна `callback_include:"base64"`.

### 3.2 Заголовки та підпис

```text
Content-Type:        application/json
User-Agent:          EAVexa/2.0
X-EAVexa-Event:      render.completed
X-EAVexa-Job-Id:     j_01JB2K7QW8ZC3M
X-EAVexa-Delivery:   d_01JB2K8T…
X-EAVexa-Timestamp:  1785060021
X-EAVexa-Signature:  sha256=9f86d081884c7d65…
```

Підпис: `HMAC-SHA256(secret, "<timestamp>.<raw_body>")`, `secret` = `WEBHOOK_SECRET`.
Timestamp у базі підпису — захист від replay (одержувач відкидає старші за 5 хв).
Якщо `WEBHOOK_SECRET` не заданий — заголовок підпису не надсилається (і це логується як warning).

Перевірка на боці n8n (Code node):

```js
const crypto = require('crypto');
const ts   = $input.first().headers['x-eavexa-timestamp'];
const sig  = $input.first().headers['x-eavexa-signature'];
const body = JSON.stringify($input.first().json);
const mine = 'sha256=' + crypto.createHmac('sha256', $env.EAVEXA_WEBHOOK_SECRET)
  .update(`${ts}.${body}`).digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mine))) throw new Error('bad signature');
```

> Застереження: n8n перепаковує JSON, тому побайтна відповідність можлива не завжди.
> Тому додатково підтримуємо простіший режим: `callback_headers` з власним токеном
> користувача (`{"Authorization":"Bearer …"}`) — для n8n це надійніше за HMAC.
> Обидва механізми доступні; у docs/n8n.md рекомендуємо `callback_headers`.

### 3.3 Ретраї

```text
Успіх:        HTTP 2xx
Ретрай:       мережева помилка, таймаут, 5xx, 408, 429  (поважати Retry-After)
Без ретраю:   інші 4xx  →  status: callback_failed, доставка позначається як permanent_failure
Бекоф:        1s → 5s → 20s → 60s → 300s   (WEBHOOK_MAX_ATTEMPTS, дефолт 5)
Таймаут:      WEBHOOK_TIMEOUT_MS (дефолт 10000)
```

Кожна спроба пишеться в `job.callback.attempts[]`: `{ at, status_code, error, next_retry_at }`.
Ручне переслання — `POST /v1/jobs/:id/retry-callback` (лічильник спроб скидається).

Ретраї переживають рестарт процесу: черга доставок лежить у `JobStore`, при старті
сервіс піднімає всі `pending`-доставки й продовжує бекоф.

### 3.4 Дозволені адреси callback

`callback_url` — це керований користувачем вихідний запит, тобто потенційний SSRF.
Але **основний сценарій — це саме внутрішня мережа** (`http://n8n:5678/...` у docker-compose).

Рішення:
- `WEBHOOK_ALLOW_PRIVATE` — **дефолт `true`** (сервіс задуманий як internal-only за API-ключем),
- `WEBHOOK_ALLOWED_HOSTS` — опційний whitelist; якщо заданий, діє строго,
- завжди блокуються: `file:`, `ftp:`, метадані хмар (`169.254.169.254`), `localhost:<порт самого сервісу>`,
- у `docs/deployment.md` — явне попередження не виставляти EAVexa у публічний інтернет без whitelist.

Це усвідомлений компроміс, і його треба задокументувати, а не робити тихо.

---

## 4. CLI

### 4.1 Команди

```bash
eavexa render      [опції]         # один рендер
eavexa batch       [--jobs f.json] # поточний jobs.json-режим
eavexa templates   <list|show|preview|validate|new>
eavexa serve       [--port 8080]
eavexa formats
eavexa jobs        <list|show|cancel>   # проти локального JobStore або віддаленого API
eavexa doctor                          # діагностика оточення
```

### 4.2 `eavexa render`

```bash
# зі вбудованого шаблону
eavexa render -t story_pricing_pro --var TITLE="Launch week" --var PRICE='$29' -o ./out.png

# з файлу / з stdin / у stdout
eavexa render --file ./my.html --format story -o ./out.png
cat my.html | eavexa render --stdin --format story -o - > out.png

# JSON-запит на stdin — той самий контракт, що в HTTP
echo '{"template":{"name":"story_faq"},"format":"story"}' | eavexa render --request - --json

# відео + webhook (той самий notifier, що в сервері)
eavexa render -t promo --video-duration 8 --fps 30 -o ./promo.mp4 \
  --callback-url http://n8n:5678/webhook/done

# розробка шаблонів
eavexa render -t story_faq --watch --open      # ре-рендер при зміні файлу
```

| Прапорець | Опис |
| --- | --- |
| `-t, --template <name>` | шаблон із реєстру |
| `--file <path>` / `--url <url>` / `--stdin` | інші джерела HTML |
| `--request <path\|->` | повний JSON-запит (контракт HTTP API) |
| `-f, --format <key\|WxH>` | `story` або `1080x1920@2` |
| `--var K=V` (повторюваний), `--vars-file <json>` | змінні |
| `--video-duration`, `--fps`, `--crf`, `--preset`, `--keep-frames` | відео |
| `-o, --out <path\|->` | `-` = stdout |
| `--callback-url`, `--callback-header K=V` | webhook після завершення |
| `--json` | машинний вивід у stdout, логи → stderr |
| `--quiet`, `--verbose` | рівень логів |
| `--timeout <ms>`, `--concurrency <n>` | ліміти |
| `--watch`, `--open` | dev-режим |
| `--dry-run` | лише валідація |

### 4.3 Правила виводу (критично для pipelines)

- Без `--json`: людський кольоровий вивід у **stdout**, як зараз.
- З `--json`: у stdout **рівно один** JSON-об'єкт, більше нічого. Усі логи, банер, прогрес → **stderr**.
- `-o -`: бінарник у stdout, логи → stderr, банер вимкнено автоматично.
- `NO_COLOR` / не-TTY → без ANSI.

### 4.4 Коди виходу

| Код | Значення |
| --- | --- |
| `0` | успіх |
| `1` | рендер провалився (`PAGE_ERROR`, `ENCODE_FAILED`) |
| `2` | некоректний вхід (`INVALID_REQUEST`, `TEMPLATE_NOT_FOUND`, `UNKNOWN_FORMAT`) |
| `3` | таймаут |
| `4` | відсутня залежність (Chromium/FFmpeg) — `eavexa doctor` підкаже |
| `5` | рендер ок, але доставка webhook провалилась остаточно |

### 4.5 `eavexa templates`

```bash
eavexa templates list --json          # → [{name,title,kind,vars_count,source}]
eavexa templates show story_faq       # маніфест + таблиця змінних
eavexa templates preview story_faq -o ./preview.png
eavexa templates validate             # усі маніфести + наявність entry/ассетів
eavexa templates new my_story --from story_faq    # скафолд із template.json
```

### 4.6 `eavexa doctor`

Перевіряє: версію Node, наявність Chromium (і чи `CHROME_PATH` валідний), FFmpeg і його кодеки
(`libx264`, `libvpx-vp9`), права на `TMP_DIR`, доступність `TEMPLATES_DIR`, вільне місце,
а в Docker — чи `/dev/shm` достатнього розміру. Виводить таблицю `OK/FAIL` і код виходу `4` при фейлі.

---

## 5. Файлова структура (цільова)

```text
src/
  cli/
    cli.js                    # bin, роутинг команд, глобальні прапорці
    args.js                   # парсер (без залежностей) + --help
    output.js                 # human/json вивід, stdout/stderr дисципліна
    commands/
      render.js  batch.js  serve.js  templates.js  jobs.js  formats.js  doctor.js
  server/
    server.js                 # node:http, роутер, graceful shutdown
    router.js
    routes/
      render.js  jobs.js  templates.js  meta.js
    middleware/
      auth.js  limits.js  errors.js  request_id.js
  core/
    render_service.js         # фасад
    render_request.js         # нормалізація + валідація (спільна для CLI/HTTP)
    template_registry.js
    template_manifest.js      # парсинг/інференс/валідація маніфесту
    browser_pool.js
    render_queue.js
    job_store.js              # інтерфейс + FileJobStore + MemoryJobStore
    webhook_notifier.js
    storage_adapter.js        # local | memory | s3
    errors.js                 # RenderError + коди
    ids.js                    # r_/j_/d_ ідентифікатори
  config/
    app_config.js             # єдина точка process.env
    server_config.js  limits_config.js  render_config.js  video_config.js
  modules/
    jobs/         { job_loader.js, render_job_builder.js }     # legacy jobs.json
    orchestrator/ { render_orchestrator.js, render_result_reporter.js }
    renderer/     { image_renderer.js, video_renderer.js, ffmpeg_encoder.js }
  shared/
    utils.js  messages.js  logger.js       # logger: pretty|json, stderr
templates/                    # built-in шаблони (у git)
test/
  unit/  integration/  fixtures/
docs/
  api.md  cli.md  n8n.md  templates.md  deployment.md
Dockerfile  docker-compose.yml  .env.example
```

---

## 6. Ключові контракти модулів

```js
// core/render_service.js
export default class RenderService {
  constructor({ registry, pool, queue, storage, notifier, job_store, limits })
  async render(request, { on_progress, signal } = {})   // синхронний шлях → RenderResult
  async submit(request)                                  // async шлях → Job (queued)
  async close()
}

// core/render_request.js
export function normalize_request(raw, { registry, limits })  // → NormalizedRequest | throws RenderError
// Єдина функція, через яку проходять І CLI-прапорці, І HTTP-тіло.
// Тут: резолв формату, підстановка дефолтів шаблону, валідація змінних,
// перевірка лімітів (MAX_WIDTH, MAX_VIDEO_DURATION, MAX_FRAMES), вибір sync/async.

// core/browser_pool.js
export default class BrowserPool {
  async with_page(render_opts, fn)   // acquire → fn(page) → release, гарантований cleanup
  async restart()                    // на 'disconnected' або після max_renders
  stats()                            // { contexts_open, renders_since_start, restarts }
}

// core/render_queue.js
export default class RenderQueue {
  enqueue(task, { lane: 'image'|'video', timeout_ms, signal })   // → Promise
  stats()   // { queued, running, by_lane }
}

// core/job_store.js
export class FileJobStore {
  async create(job) / get(id) / update(id, patch) / list(filter) / remove(id)
  async pending_callbacks()   // для відновлення доставок після рестарту
  async sweep()               // TTL + orphan recovery
}

// core/webhook_notifier.js
export default class WebhookNotifier {
  async notify(job, event)          // → delivery record; сам планує ретраї
  async resume_pending()            // викликається при старті процесу
}
```

### Дві черги, не одна

`RENDER_CONCURRENCY` (image, дефолт 3) і `VIDEO_CONCURRENCY` (дефолт 1) — окремі смуги.
Інакше одне 60-секундне відео блокує 20 картинок, які рендеряться по 300 мс.

### Відновлення після рестарту

При старті `RenderService`:
1. джоби у статусі `running` → `failed` з `code: "INTERRUPTED"` + надсилається `render.failed` webhook;
2. `pending`-доставки з `job_store` ставляться в чергу нотифікатора;
3. осиротілі tmp-директорії кадрів прибираються.

Без цього обіцянка «webhook обов'язково прийде» неправдива, а pipeline зависає назавжди.

---

## 7. Конфігурація (додатки до `app_config.js`)

| Змінна | Дефолт | Опис |
| --- | --- | --- |
| `EAVEXA_PORT` / `EAVEXA_HOST` | `8080` / `0.0.0.0` | HTTP |
| `EAVEXA_API_KEY` | — | якщо задано, вимагається `X-API-Key` |
| `EAVEXA_PUBLIC_URL` | — | база для `result_url` у webhook (обов'язково в Docker) |
| `TEMPLATES_DIR` | `data/templates` | користувацькі шаблони |
| `BUILTIN_TEMPLATES_DIR` | `templates` | вбудовані |
| `RENDER_CONCURRENCY` / `VIDEO_CONCURRENCY` | `3` / `1` | смуги черги |
| `QUEUE_MAX` | `100` | глибина перед `503` |
| `RENDER_TIMEOUT_MS` | `60000` | ліміт одного рендеру |
| `SYNC_MAX_COST` | `90` | кадрів; більше → примусово async |
| `MAX_WIDTH` / `MAX_HEIGHT` | `4096` | ліміт розміру |
| `MAX_VIDEO_DURATION` / `MAX_FPS` | `60` / `60` | ліміти відео |
| `MAX_BODY_MB` | `10` | ліміт тіла |
| `JOB_TTL_MS` | `3600000` | скільки живуть джоб і артефакт |
| `JOB_STORE_DIR` | `data/jobs` | FileJobStore |
| `WEBHOOK_SECRET` | — | HMAC |
| `WEBHOOK_MAX_ATTEMPTS` / `WEBHOOK_TIMEOUT_MS` | `5` / `10000` | доставка |
| `WEBHOOK_ALLOW_PRIVATE` | `true` | дозволити внутрішні адреси |
| `WEBHOOK_ALLOWED_HOSTS` | — | строгий whitelist |
| `CALLBACK_INLINE_MAX_BYTES` | `262144` | межа для `callback_include:"base64"` |
| `TEMPLATE_ALLOWED_HOSTS` | — | whitelist для `template.url` (SSRF) |
| `STORAGE_DRIVER` | `local` | `local` \| `memory` \| `s3` |
| `TMP_DIR` | `os.tmpdir()` | кадри відео |
| `LOG_FORMAT` / `LOG_LEVEL` | `pretty` / `info` | логи |
| `CHROME_PATH` / `FFMPEG_PATH` | — | існуючі |

---

## 8. Порядок реалізації

### Крок 0 — Фікси (0.5–1 д) · нічого нового не додає, але все далі на цьому стоїть

- [ ] `device_scale_factor` → `deviceScaleFactor` в обох рендерерах (**DPR зараз не працює**)
- [ ] прибрати неіснуючу опцію `setContent(..., {url})`; додати `<base href>` як у `VideoRenderer`
- [ ] екранування у `_apply_vars` + синтаксис `{{{RAW}}}` для сирого HTML
- [ ] таймаути: `page.setDefaultTimeout()` + загальний дедлайн рендеру
- [ ] `CHROME_PATH` дефолт → `null`
- [ ] `ImageRenderer.js` → `image_renderer.js` (правило CLAUDE.md)
- [ ] `utils.js` привести до snake_case з CLAUDE.md (+ `retry`, `format_bytes`, `format_duration`)
- [ ] `node --test` + smoke-тест: рендер 200×200 → перевірити реальні пікселі PNG
- [ ] `package.json`: `bin`, `engines`, `files`, скрипти `test`/`serve`/`cli`

### Крок 1 — Ядро (1.5–2 д)

- [ ] `core/errors.js`, `core/ids.js`, `shared/logger.js` (pretty/json, stderr)
- [ ] `core/template_manifest.js` + `core/template_registry.js` (+ інференс)
- [ ] `core/render_request.js` — нормалізація/валідація, спільна для всіх фронтів
- [ ] `core/browser_pool.js`
- [ ] `core/render_queue.js` (дві смуги)
- [ ] `core/storage_adapter.js` (`memory` + `local`)
- [ ] `core/render_service.js` — поки лише синхронний `render()`
- [ ] `on_progress` у `VideoRenderer` (колбек з циклу кадрів)
- [ ] перевести `RenderOrchestrator` на `RenderService` — `npm start` працює як раніше
- [ ] тести: registry, request, manifest inference, ffmpeg args

### Крок 2 — CLI (1 д) · перший фронт, який реально можна вживати

- [ ] `cli/args.js`, `cli/output.js`, `cli/cli.js`
- [ ] `render`, `batch`, `formats`, `templates list|show`, `doctor`
- [ ] дисципліна stdout/stderr, `--json`, `-o -`, коди виходу
- [ ] `--watch` для розробки шаблонів
- [ ] `docs/cli.md`

### Крок 3 — Джоби + webhooks (1.5 д) · ядро async-режиму

- [ ] `core/job_store.js` (`MemoryJobStore` + `FileJobStore`)
- [ ] `core/webhook_notifier.js` (HMAC, ретраї, бекоф, `resume_pending`)
- [ ] `RenderService.submit()` + оновлення прогресу
- [ ] відновлення після рестарту (`running` → `failed` + webhook)
- [ ] `--callback-url` у CLI (той самий notifier)
- [ ] `eavexa jobs list|show|cancel`
- [ ] тести: ретраї на 5xx, зупинка на 4xx, підпис, відновлення

### Крок 4 — HTTP (1.5 д)

- [ ] `server/server.js` + `router.js` на `node:http`, graceful shutdown
- [ ] middleware: `request_id`, `auth`, `limits`, `errors`
- [ ] `/v1/render` (sync/async), `/v1/jobs/*`
- [ ] `/v1/templates`, `/v1/templates/:name`, `/preview`, `/:name/render`
- [ ] `/v1/formats`, `/healthz`, `/readyz`, `/v1/version`
- [ ] `Idempotency-Key`
- [ ] `eavexa serve`
- [ ] `docs/api.md` + `openapi.yaml`

### Крок 5 — Docker + n8n (0.5–1 д)

- [ ] `Dockerfile` на `mcr.microsoft.com/playwright`
- [ ] `docker-compose.yml`: eavexa + n8n, `shm_size: 1g`, `init: true`, том `/templates`
- [ ] healthcheck, non-root
- [ ] `docs/n8n.md` + готовий workflow-JSON для імпорту
- [ ] `docs/deployment.md` (включно з застереженням про довільний HTML і публічний доступ)

### Крок 6 — Продакшн-поліш (1 д)

- [ ] `/metrics`, ліміти ресурсів, rate limit
- [ ] `STORAGE_DRIVER=s3` + presigned URL
- [ ] integration-тести API, CI (lint → test → docker → GHCR)
- [ ] `2.0.0`, CHANGELOG

**Разом ≈ 7–9 днів. Придатне до вжитку вже після Кроку 2 (CLI), інтегроване в n8n — після Кроку 5.**

---

## 9. Цільові сценарії n8n

**Швидка картинка (sync):**

```text
[Trigger] → [HTTP Request  POST /v1/templates/story_pricing_pro/render
             Body: {"TITLE":"{{$json.title}}","PRICE":"{{$json.price}}"}
             Response Format: File]
          → [Telegram sendPhoto]
```

**Довге відео (async + webhook):**

```text
[Trigger] → [HTTP Request  POST /v1/render
             {"template":{"name":"promo"},"video":{"duration":30},
              "callback_url":"{{$execution.resumeUrl}}",   ← або окремий Webhook node
              "callback_headers":{"Authorization":"Bearer …"},
              "metadata":{"row_id":"{{$json.id}}"}}]
          → [Wait: On Webhook Call]              ← з'єднання не висить
          → [IF event == render.completed]
          → [HTTP Request  GET {{$json.result.result_url}}  Response Format: File]
          → [S3 Upload] → [Instagram Publish]
```

`metadata` повертається у webhook як є — саме так n8n зшиває відповідь із вихідним рядком даних.

---

## 10. Відкриті питання — ЗАКРИТІ

Усі чотири рішення зафіксовані в [decisions.md](./decisions.md):

| # | Питання | Рішення |
| --- | --- | --- |
| Р1 | Мережеві шрифти в шаблонах | обидва режими рівноправні; додаємо таймаути, `--offline`, діагностику ассетів |
| Р2 | `result_url` та робота без Docker | storage ≠ delivery; `EAVEXA_PUBLIC_URL` **не обов'язкова** (фолбек на `Host`); bare metal — базовий сценарій |
| Р3 | TTL артефактів | за замовчуванням **зберігаємо назавжди** (`RETENTION_MODE=keep`); TTL опційний |
| Р4 | Великі файли в n8n | байти не йдуть через тіло webhook; чотири стратегії — `url` / `path` / `s3` / `push` |
