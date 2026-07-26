# EAVexa 2.0 — Специфікація

> Повний опис того, як має працювати система. Документ для реалізації.
> Об'єднує та замінює: [pipeline_integration_plan.md](./pipeline_integration_plan.md) (аналіз),
> [implementation_plan.md](./implementation_plan.md) (структура), [decisions.md](./decisions.md) (рішення).
> **Основний сценарій розгортання — bare metal.** Docker — додатковий.

---

## 1. Принципи

1. **Одне ядро, три фронти.** CLI, HTTP і legacy `jobs.json` — рівноправні адаптери над
   `RenderService`. Жодної логіки рендеру поза ядром.
2. **Працює з коробки.** `npm i && npx playwright install chromium && npx eavexa render …` —
   нуль обов'язкових змінних оточення. Кожна змінна має робочий дефолт.
3. **Артефакти зберігаються назавжди** (`RETENTION_MODE=keep`). Видалення — тільки явна дія.
4. **Файл на диску є завжди.** Тому результат завжди містить і `path`, і `url` — споживач
   обирає, що зручніше.
5. **Довга робота не тримає з'єднання.** Все, що довше за поріг, іде через джоб + webhook.
6. **stdout священний.** У машинних режимах CLI у stdout лише результат; усі логи — у stderr.
7. **Немає тихих провалів.** Провалений ассет, обрізаний шрифт, недоставлений webhook —
   усе видно у відповіді або в статусі джоба.

---

## 2. Розгортання

### 2.1 Bare metal — основний сценарій

```bash
git clone … && cd EAVexa
npm ci
npx playwright install chromium        # ~180 МБ, один раз
npx eavexa doctor                      # перевірка оточення
```

Разовий рендер:

```bash
npx eavexa render -t story_pricing_pro --var TITLE="Launch week" -o ./out.png
```

Сервер:

```bash
npx eavexa serve                       # http://localhost:8080
```

Нічого більше не потрібно: `data/` створюється лениво, `OUTPUT_DIR` за замовчуванням
всередині проєкту, Chromium бере Playwright свій власний, FFmpeg — з `ffmpeg-static`.

**Windows** — повноцінно підтримується (розробка ведеться на ньому): шляхи через
`path.join`/`pathToFileURL`, `windowsHide: true` для FFmpeg, `CHROME_SANDBOX=auto`
(на хості пісочниця **не** вимикається).

**Як служба:**

| ОС | Спосіб |
| --- | --- |
| Linux | `systemd` unit (приклад у `docs/deployment.md`) |
| Windows | NSSM або Task Scheduler «At startup» |
| будь-яка | `pm2 start npx --name eavexa -- eavexa serve` |

### 2.2 n8n на тій самій машині

Це цільова конфігурація. n8n читає готові файли **прямо з диску** — жодних мережевих
передач бінарників:

```text
EAVexa:  OUTPUT_DIR = S:\Daedalus\Aureum\EAVexa\data\outputs
n8n:     нода "Read/Write Files from Disk" ← {{ $json.result.path }}
```

Умова — n8n має право читати цю директорію. Якщо n8n у Docker Desktop, а EAVexa на хості,
директорію треба змонтувати і виставити `OUTPUT_DIR_ALIAS` (§10).

### 2.3 Docker

Другорядний, але підтримуваний сценарій. Деталі — `docs/deployment.md`.
Ключове: `shm_size: 1g`, `init: true`, спільний том для `OUTPUT_DIR`,
`N8N_DEFAULT_BINARY_DATA_MODE=filesystem` на боці n8n.

---

## 3. Розкладка на диску

```text
EAVexa/
  templates/                          # вбудовані шаблони (в git, їдуть з додатком)
    story_pricing_pro/
      template.json
      template.html
      fonts/ images/ preview.png
  data/                               # runtime, у .gitignore
    templates/                        # шаблони користувача (TEMPLATES_DIR)
    outputs/
      2026-07-25/
        j_01JB2K7QW8ZC3M/
          promo.mp4
          promo.mp4.meta.json         # копія result — для відновлення без JobStore
    jobs/
      2026-07-25/
        j_01JB2K7QW8ZC3M.json         # запис джоба
        j_01JB2K7QW8ZC3M.html         # sidecar: inline-HTML запиту (якщо був)
    inputs/                           # legacy jobs.json
    logs/
  src/  test/  docs/
```

Правила:

- Розкладка по датах — щоб директорія не мала десятків тисяч записів при `RETENTION_MODE=keep`.
- **Один файл на джоб.** Жодного глобального індексу, який довелося б переписувати цілком.
- Запис артефакту **атомарний**: `promo.mp4.part` → `rename()`. Інакше n8n, що стартує по
  вебхуку миттєво, прочитає недописане відео.
- Кадри відео — у `TMP_DIR` (`os.tmpdir()`), **не** в `outputs`. Прибираються у `finally`;
  осиротілі — при старті процесу.
- Права файлів — `0644` явно.

---

## 4. Архітектура

```text
    CLI                     HTTP                  jobs.json
 cli/commands/*        server/routes/*        modules/orchestrator
       └───────────────────┬─────────────────────────┘
                           ▼
            core/render_request.js   normalize_request()
                           ▼
              core/render_service.js  RenderService
        ┌──────────┬───────┼────────┬──────────┬──────────┐
        ▼          ▼       ▼        ▼          ▼          ▼
   Template    Browser  Render   Job      Storage    Webhook
   Registry     Pool    Queue    Store    Adapter    Notifier
                  │
      modules/renderer/{image_renderer, video_renderer} → ffmpeg_encoder
```

**Критичне правило розміщення:** `JobStore` і `WebhookNotifier` — у `core/`, не в `server/`.
Тоді `eavexa render --callback-url …` з планувальника поводиться **точно так само**, як
HTTP-запит з n8n: один код доставки, одні ретраї, одні тести.

### 4.1 Дерево файлів

```text
src/
  cli/
    cli.js                  # bin-entry, роутинг команд
    args.js                 # парсер аргументів (без залежностей), --help
    output.js               # дисципліна stdout/stderr, human/json
    commands/
      render.js  batch.js  serve.js  templates.js  jobs.js  formats.js  doctor.js
  server/
    server.js               # node:http, lifecycle, graceful shutdown
    router.js               # мінімальний роутер (метод + патерн шляху)
    routes/
      render.js  jobs.js  templates.js  meta.js
    middleware/
      request_id.js  auth.js  limits.js  errors.js
  core/
    render_service.js
    render_request.js
    template_registry.js
    template_manifest.js
    browser_pool.js
    render_queue.js
    job_store.js
    storage_adapter.js
    webhook_notifier.js
    retention.js
    errors.js
    ids.js
  config/
    app_config.js           # ЄДИНА точка process.env
    server_config.js  limits_config.js  render_config.js  video_config.js
  modules/
    jobs/{job_loader.js, render_job_builder.js}
    orchestrator/{render_orchestrator.js, render_result_reporter.js}
    renderer/{image_renderer.js, video_renderer.js, ffmpeg_encoder.js}
  shared/
    utils.js  messages.js  logger.js
```

---

## 5. Ядро: контракти модулів

### 5.1 `core/errors.js`

```js
export class RenderError extends Error {
  constructor(code, message, details = {}) { … }
  // code, message, details, http_status, exit_code
}
```

| Код | HTTP | Exit | Коли |
| --- | --- | --- | --- |
| `INVALID_REQUEST` | 400 | 2 | схема запиту невалідна |
| `MISSING_REQUIRED_VAR` | 400 | 2 | обов'язкова змінна шаблону не задана |
| `UNKNOWN_FORMAT` | 400 | 2 | немає такого пресета |
| `LIMIT_EXCEEDED` | 400 | 2 | перевищено `MAX_*` |
| `TEMPLATE_NOT_FOUND` | 404 | 2 | немає в реєстрі |
| `TEMPLATE_INVALID` | 400 | 2 | зламаний `template.json` / немає entry |
| `TEMPLATE_FETCH_FAILED` | 502 | 1 | не вдалось завантажити `template.url` |
| `ASSET_LOAD_FAILED` | 502 | 1 | лише при `strict_assets: true` |
| `PAGE_ERROR` | 500 | 1 | JS-помилка / краш сторінки |
| `RENDER_TIMEOUT` | 408 | 3 | перевищено `timeout_ms` |
| `ENCODE_FAILED` | 500 | 1 | FFmpeg повернув ≠ 0 |
| `STORAGE_FAILED` | 500 | 1 | не вдалось записати артефакт |
| `DELIVERY_FAILED` | 502 | 5 | `s3`/`push` провалились |
| `CALLBACK_FAILED` | — | 5 | webhook не доставлено після всіх спроб |
| `RESULT_GONE` | 410 | 1 | артефакт видалено retention-ом |
| `JOB_NOT_FOUND` | 404 | 2 | немає такого джоба |
| `QUEUE_FULL` | 503 | 1 | черга переповнена, `Retry-After` |
| `UNAUTHORIZED` | 401 | 2 | немає/невірний `X-API-Key` |
| `PAYLOAD_TOO_LARGE` | 413 | 2 | тіло > `MAX_BODY_MB` |
| `DEPENDENCY_MISSING` | 503 | 4 | немає Chromium / FFmpeg |
| `INTERRUPTED` | 500 | 1 | процес перезапустився під час рендеру |
| `CANCELLED` | 499 | 1 | скасовано користувачем |
| `INTERNAL` | 500 | 1 | усе інше |

### 5.2 `core/ids.js`

Монотонні сортовані ID (ULID-подібні, без залежностей): `r_` рендер, `j_` джоб, `d_` доставка.
Сортування за рядком = сортування за часом. Це дозволяє `GET /v1/jobs` з курсорною
пагінацією без читання всіх файлів.

### 5.3 `core/template_manifest.js`

```js
export function parse_manifest(raw_json, dir_name)   // → Manifest | throws TEMPLATE_INVALID
export function infer_manifest(html, dir_name)       // → Manifest з {{VAR}} у HTML
export function validate_vars(manifest, vars)        // → { values, errors }
```

`validate_vars`:
1. підставляє `default` для незаданих;
2. кидає `MISSING_REQUIRED_VAR`, якщо `required` і немає значення;
3. перевіряє `type` (`string|number|boolean|color|url|html`) і `max_length`;
4. **невідомі змінні не є помилкою** — просто передаються далі (сумісність);
5. повертає повний набір значень для підстановки.

Схема маніфесту — §9.2.

### 5.4 `core/template_registry.js`

```js
export default class TemplateRegistry {
  constructor({ builtin_dir, user_dir, cache_ttl_ms })
  async list({ tag, kind } = {})     // → [TemplateSummary]
  async get(name)                    // → Manifest
  async resolve(name)                // → { manifest, html_path, base_dir, source }
  async read_html(name)              // → string
  async reload()
}
```

Резолв: `user_dir/<name>` → `builtin_dir/<name>`. Користувацький перекриває вбудований.
Ім'я валідується `^[a-z0-9][a-z0-9._-]*$` — захист від path traversal.
Якщо `template.json` немає → `infer_manifest()`, у відповіді `"inferred": true`.
Кеш маніфестів з `cache_ttl_ms` (дефолт 5 c) + інвалідація за `mtime` директорії.

### 5.5 `core/render_request.js`

**Найважливіший модуль.** Усе — прапорці CLI, тіло HTTP, елементи `jobs.json` — проходить
через одну функцію. Тільки так три фронти поводяться однаково.

```js
export function normalize_request(raw, ctx)   // ctx: { registry, limits, config, origin }
```

Нормалізована форма:

```js
{
  render_id: 'r_01JB2K…',
  source: {
    kind: 'registry' | 'inline' | 'file' | 'url',
    name, html, path, url,
    base_dir,                 // для резолву відносних ассетів (<base href>)
  },
  template: { name, manifest } | null,
  format:   { key, width, height, device_scale_factor },
  vars:     { TITLE: 'Launch week' },        // після validate_vars, з дефолтами
  video:    null | { duration, fps, crf, preset, webm_crf, keep_frames },
  output:   { type, filename, dir, s3, push },
  options:  { timeout_ms, settle_ms, network_timeout_ms, font_timeout_ms,
              offline, strict_assets },
  callback: null | { url, headers },
  metadata: {},
  mode:     'sync' | 'async',
  cost:     { frames, estimate_ms },
  origin:   { via: 'http' | 'cli' | 'batch', public_base_url },
}
```

Порядок обробки:

1. вибрати `source.kind` (рівно одне з `template.name` / `.html` / `.file` / `.url`);
2. для `registry` — `registry.resolve()`, підтягнути дефолти маніфесту
   (`default_format`, `video`);
3. розібрати формат: рядок-ключ, `1080x1920@2`, або об'єкт;
4. `validate_vars()`;
5. нормалізувати `video` (як зараз у `VideoRenderer._normalize_video_options`, але тут);
6. перевірити ліміти: `MAX_WIDTH/HEIGHT`, `MAX_VIDEO_DURATION`, `MAX_FPS`, `MAX_FRAMES`;
7. порахувати `cost.frames` = `video ? round(duration*fps) : 1`;
8. **обрати режим** (§6.1);
9. заповнити `output` дефолтами.

### 5.6 `core/browser_pool.js`

```js
export default class BrowserPool {
  async with_page(render_opts, fn)   // acquire → fn(page) → гарантований release
  async restart()
  async close()
  stats()   // { alive, contexts_open, renders_since_start, restarts }
}
```

- **Один Chromium на процес**, лениво стартує при першому рендері. Економія 1–3 c на запит.
- Контекст **на кожен рендер** (ізоляція) з правильним `deviceScaleFactor`.
- `browser.on('disconnected')` → позначити мертвим, наступний `with_page` підніме новий.
- `BROWSER_MAX_RENDERS` (дефолт 200) → плановий перезапуск проти витоків пам'яті;
  перезапуск чекає завершення активних рендерів.
- Аргументи запуску: поточний набір, але `--no-sandbox` **лише** якщо
  `CHROME_SANDBOX=off` або `auto` + виявлено контейнер (`/.dockerenv`).

### 5.7 `core/render_queue.js`

```js
export default class RenderQueue {
  enqueue(task, { lane, timeout_ms, signal })   // → Promise
  stats()   // { queued, running, by_lane }
}
```

**Дві незалежні смуги**, і це принципово: `image` (`RENDER_CONCURRENCY`, дефолт 3) і
`video` (`VIDEO_CONCURRENCY`, дефолт 1). Інакше одне 60-секундне відео блокує 20 картинок
по 300 мс кожна.

Понад `QUEUE_MAX` → `QUEUE_FULL` + `Retry-After`. Скасування через `AbortSignal`.

### 5.8 `core/storage_adapter.js`

```js
export default class StorageAdapter {
  async put(buffer_or_stream, { job_id, filename, dir })   // → StoredArtifact
  async get_stream(artifact, { range })                     // → ReadableStream
  async remove(artifact)
  build_public_url(artifact, { public_base_url })           // → string | null
  translate_path(abs_path)                                  // OUTPUT_DIR_ALIAS
}
```

Драйвери: `local` (дефолт), `s3`, `memory` (тести / sync без збереження).

`local.put()`:
1. `mkdir -p OUTPUT_DIR/<YYYY-MM-DD>/<job_id>/`;
2. запис у `<filename>.part`;
3. `chmod 0644`;
4. `rename()` → `<filename>` (атомарно);
5. запис `<filename>.meta.json` поруч;
6. повертає `{ storage:'local', local_path, path (з аліасом), bytes, checksum }`.

Checksum — SHA-256, рахується **потоково під час запису**, не другим проходом.

### 5.9 `core/job_store.js`

```js
export class FileJobStore {
  async create(job) / get(id) / update(id, patch) / remove(id)
  async list({ status, before, after, limit })   // курсорна пагінація за id
  async pending_callbacks()                       // для відновлення після рестарту
  async orphaned_running()                        // джоби, що «висіли» на момент старту
}
```

Запис — атомарний (`.tmp` → `rename`). У пам'яті — LRU активних джобів
(`JOB_CACHE_SIZE`, дефолт 500), не всі. `list()` читає директорії дат у зворотному
порядку і зупиняється, набравши `limit`.

### 5.10 `core/webhook_notifier.js`

```js
export default class WebhookNotifier {
  async notify(job, event)     // → delivery; сам планує ретраї
  async resume_pending()       // при старті процесу
  stats()
}
```

Деталі — §8.

### 5.11 `core/render_service.js`

```js
export default class RenderService {
  constructor({ registry, pool, queue, storage, job_store, notifier, config })
  async start()                              // відновлення після рестарту
  async render(request, { on_progress, signal })   // sync → RenderResult
  async submit(request)                            // async → Job
  async cancel(job_id)
  async close()
}
```

`start()` виконує три речі — без них обіцянка «webhook обов'язково прийде» неправдива:

1. `orphaned_running()` → статус `failed`, код `INTERRUPTED`, поставити webhook у чергу;
2. `pending_callbacks()` → відновити бекоф доставок;
3. прибрати осиротілі директорії кадрів у `TMP_DIR`.

---

## 6. Життєвий цикл рендеру

### 6.1 Вибір режиму sync / async

| Умова | Режим |
| --- | --- |
| заданий `callback_url` **або** `"mode": "async"` | async |
| `"mode": "sync"` явно | sync (навіть якщо дорого) |
| `cost.frames > SYNC_MAX_COST` (дефолт 90) | async + заголовок `Warning` |
| інакше | sync |

Картинка = 1 кадр → завжди sync. 3-секундне відео @30fps = 90 кадрів → ще sync.
5-секундне = 150 → async. Так HTTP-з'єднання ніколи не висить хвилинами, навіть якщо
користувач про це не подумав.

### 6.2 Фази

```text
queued → load → capture → encode → store → done
                                          ↘ failed | cancelled
```

| Фаза | Що відбувається | Внесок у `progress.ratio` |
| --- | --- | --- |
| `queued` | у черзі | 0 |
| `load` | контекст, `setContent`, шрифти, settle | 0 → 0.05 |
| `capture` | скріншот / цикл кадрів | 0.05 → 0.85 |
| `encode` | FFmpeg (лише відео) | 0.85 → 0.97 |
| `store` | запис артефакту, checksum | 0.97 → 1.0 |

`VideoRenderer` отримує колбек `on_progress({ phase, current, total })` у циклі кадрів —
це те, що бачить n8n при полінгу.

### 6.3 Sync-потік

```text
normalize_request → queue.enqueue(lane)
  → pool.with_page → renderer → Buffer
  → storage.put()  (якщо PERSIST_SYNC_RENDERS або output.type ≠ binary/base64)
  → відповідь
```

### 6.4 Async-потік

```text
normalize_request → job_store.create(status:'queued') → 202 клієнту
  ↓ (фонова черга)
job.status='running' → фази з оновленням progress
  → storage.put() → job.result → status='done'
  → notifier.notify(job, 'render.completed')
       ↓ провал → ретраї з бекофом → callback.state='failed'
```

Клієнт може або чекати webhook, або полити `GET /v1/jobs/:id`. Обидва шляхи завжди доступні.

### 6.5 Схема результату

Однакова для sync-відповіді, `GET /v1/jobs/:id` і тіла webhook:

```jsonc
{
  "render_id": "r_01JB2K7QW8ZC3M",
  "type":      "video",                  // image | video
  "mime":      "video/mp4",
  "filename":  "promo.mp4",
  "bytes":     41930210,
  "checksum":  "sha256:9f86d081884c7d65…",
  "width": 2160, "height": 3840, "dpr": 2,
  "duration": 5, "fps": 30, "frames": 150,     // null для картинок

  "storage":    "local",
  "path":       "/data/outputs/2026-07-25/j_01JB2K/promo.mp4",   // з OUTPUT_DIR_ALIAS
  "local_path": "S:\\…\\data\\outputs\\2026-07-25\\j_01JB2K\\promo.mp4",
  "url":        "http://localhost:8080/v1/jobs/j_01JB2K/result",
  "data":       null,                                             // base64 на запит

  "timings": { "total_ms": 18422, "load_ms": 812, "capture_ms": 12903,
               "encode_ms": 4210, "store_ms": 497 },
  "assets":  { "requested": 7, "failed": 0, "external": 2,
               "fonts_ready": true, "failures": [] }
}
```

**`path` і `url` заповнюються одночасно** при `storage: "local"`. Споживач обирає потрібне
у своєму workflow, а не в запиті. `url` = `null`, якщо джоб створено з CLI без сервера.

---

## 7. HTTP API

Базовий шлях `/v1`. Автентифікація: `X-API-Key`, якщо задано `EAVEXA_API_KEY` (інакше
відкрито — прийнятно для localhost, задокументовано в `deployment.md`).
Кожна відповідь має `X-Request-Id`.

### 7.1 Мапа

| Метод | Шлях | Опис |
| --- | --- | --- |
| POST | `/v1/render` | рендер (sync або async) |
| POST | `/v1/templates/:name/render` | цукор: тіло = самі змінні |
| GET | `/v1/jobs` | список з пагінацією |
| GET | `/v1/jobs/:id` | стан + прогрес + результат |
| GET | `/v1/jobs/:id/result` | сам артефакт (стрім) |
| DELETE | `/v1/jobs/:id` | скасувати / видалити |
| POST | `/v1/jobs/:id/retry-callback` | переслати webhook |
| GET | `/v1/templates` | список шаблонів |
| GET | `/v1/templates/:name` | маніфест зі схемою змінних |
| GET | `/v1/templates/:name/preview` | PNG-прев'ю (кешоване) |
| GET | `/v1/formats` | пресети форматів |
| GET | `/v1/version` | версії EAVexa / Playwright / Chromium / FFmpeg |
| GET | `/healthz` `/readyz` | liveness / readiness |

### 7.2 `POST /v1/render`

```jsonc
{
  "template": { "name": "story_pricing_pro" },   // або {"html":"…"} {"url":"…"} {"file":"…"}
  "format":   "story",
  "vars":     { "TITLE": "Launch week", "PRICE": "$29" },
  "video":    { "duration": 5, "fps": 30, "crf": 18 },
  "output":   { "type": "binary", "filename": "promo.mp4", "dir": "campaign_42" },
  "options":  { "timeout_ms": 60000, "offline": false, "strict_assets": false },
  "callback_url":     "http://localhost:5678/webhook/eavexa-done",
  "callback_headers": { "Authorization": "Bearer …" },
  "metadata":         { "row_id": 42 },
  "mode":             "async"
}
```

`output.type`:

| Значення | Sync | Async |
| --- | --- | --- |
| `binary` *(дефолт sync)* | сирі байти + заголовки | трактується як звичайний результат |
| `base64` | JSON з `data` | у webhook, якщо `bytes < CALLBACK_INLINE_MAX_BYTES`, інакше авто-деградація до посилання + `"downgraded_from":"base64"` |
| `url` / `path` | JSON без байтів | — (обидва поля і так завжди є) |
| `s3` | JSON з presigned URL | EAVexa вивантажує сам |
| `push` | JSON зі статусом доставки | EAVexa постить multipart на вказаний ендпоїнт |

**200 (sync, `binary`)** — тіло = байти, заголовки:

```text
Content-Type: video/mp4
Content-Disposition: attachment; filename="promo.mp4"
Content-Length: 41930210
X-Render-Id: r_01JB2K…
X-Render-Width: 2160
X-Render-Height: 3840
X-Render-Duration-Ms: 18422
X-Result-Path: /data/outputs/2026-07-25/j_01JB2K/promo.mp4
```

**202 (async):**

```jsonc
{
  "ok": true,
  "job_id": "j_01JB2K7QW8ZC3M",
  "status": "queued",
  "queue_position": 3,
  "estimate_ms": 18000,
  "poll_url":   "/v1/jobs/j_01JB2K7QW8ZC3M",
  "result_url": "/v1/jobs/j_01JB2K7QW8ZC3M/result"
}
```

Заголовок `Idempotency-Key` → повторний запит з тим самим ключем протягом
`IDEMPOTENCY_TTL_MS` (дефолт 10 хв) повертає **той самий** джоб, не рендерить удруге.
Це рятує, коли n8n ретраїть після власного таймауту.

### 7.3 `POST /v1/templates/:name/render`

Тіло — **просто змінні**, без обгорток. Найкоротший виклик з n8n: дані попередньої ноди
як є.

```jsonc
{ "TITLE": "Launch week", "PRICE": "$29" }
```

Query перекриває: `?format=story&type=base64&mode=async&callback_url=…`.
Формат і `video` беруться з маніфесту шаблону.

### 7.4 `GET /v1/jobs/:id`

```jsonc
{
  "ok": true,
  "job": {
    "id": "j_01JB2K7QW8ZC3M",
    "status": "running",         // queued|running|done|failed|cancelled
    "mode": "async",
    "progress": { "phase": "capture", "current": 62, "total": 150, "ratio": 0.36 },
    "created_at": "2026-07-25T10:00:00.000Z",
    "started_at": "2026-07-25T10:00:02.100Z",
    "finished_at": null,
    "template": "story_pricing_pro",
    "type": "video",
    "metadata": { "row_id": 42 },
    "result": null,
    "error": null,
    "callback": { "url": "http://localhost:5678/webhook/…", "state": "pending",
                  "delivered": false, "attempts": [] }
  }
}
```

### 7.5 `GET /v1/jobs/:id/result`

Вимоги до реалізації — тут легко зробити гірше, ніж n8n:

- `fs.createReadStream(...).pipe(res)` — **ніколи** не `readFile` цілком;
- `Content-Length`, `Content-Type`, `Content-Disposition`;
- `Range` → `206 Partial Content` (докачка, часткові читання);
- `ETag` = checksum, `If-None-Match` → `304`;
- **без стиснення** для відео/PNG;
- `?token=` — одноразовий підписаний токен (`RESULT_TOKEN_SECRET`), щоб посилання можна
  було давати назовні без основного API-ключа;
- `410 RESULT_GONE`, якщо артефакт видалено retention-ом.

### 7.6 `GET /v1/templates` та `/:name`

```jsonc
// список
[{ "name":"story_pricing_pro", "title":"Pricing — Pro", "kind":"image",
   "source":"builtin", "default_format":"story", "vars_count":2,
   "network":"required", "has_preview":true, "inferred":false }]

// один — повний маніфест зі схемою змінних (§9.2)
```

Це те, що робить HTTP зручним: перед викликом видно, які змінні є, які обов'язкові
й якого типу. `?refresh=1` — примусовий ре-скан.

### 7.7 Формат помилки

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

### 7.8 Життєвий цикл сервера

- `SIGTERM`/`SIGINT` → перестати приймати нові, дочекатись активних рендерів
  (`SHUTDOWN_GRACE_MS`, дефолт 30 c), спробувати доставити webhook-и, закрити браузер.
- `/readyz` = `false`, якщо браузер мертвий, FFmpeg недоступний або черга переповнена.

---

## 8. Webhooks

### 8.1 Payload

```jsonc
{
  "event": "render.completed",          // render.completed | render.failed
  "job_id": "j_01JB2K7QW8ZC3M",
  "delivery_id": "d_01JB2K8T…",
  "sent_at": "2026-07-25T10:00:21.400Z",
  "template": "story_pricing_pro",
  "metadata": { "row_id": 42 },
  "result": { … §6.5 … },
  "error": null
}
```

Для `render.failed` — `result: null`, `error: { code, message, details }`.

**Байти в тілі webhook не передаються.** Тіло несе `path` і `url` — далі споживач сам
вирішує. Причина: типовий ліміт тіла в n8n ~16 МБ, base64 додає +33%, і тримання
великого відео в пам'яті кладе воркер.

### 8.2 Заголовки та підпис

```text
X-EAVexa-Event:     render.completed
X-EAVexa-Job-Id:    j_01JB2K7QW8ZC3M
X-EAVexa-Delivery:  d_01JB2K8T…
X-EAVexa-Timestamp: 1785060021
X-EAVexa-Signature: sha256=<hmac>
```

`HMAC-SHA256(WEBHOOK_SECRET, "<timestamp>.<raw_body>")` — timestamp у базі підпису захищає
від replay. Якщо секрет не заданий — заголовок не надсилається (+ warning у лог).

> На практиці для n8n надійніший `callback_headers` з власним токеном: n8n перепаковує JSON,
> тож побайтна відповідність тіла не гарантована. Обидва механізми підтримуються;
> у `docs/n8n.md` рекомендуємо `callback_headers`.

### 8.3 Ретраї

```text
Успіх:      2xx
Ретрай:     мережа, таймаут, 5xx, 408, 429 (поважати Retry-After)
Без ретраю: інші 4xx → state='failed_permanent'
Бекоф:      1s → 5s → 20s → 60s → 300s      (WEBHOOK_MAX_ATTEMPTS, дефолт 5)
Таймаут:    WEBHOOK_TIMEOUT_MS (дефолт 10000)
```

Кожна спроба пишеться у `job.callback.attempts[]`:
`{ at, status_code, error, duration_ms, next_retry_at }`.
**Ретраї переживають рестарт процесу** — черга у `JobStore`, відновлюється у `start()`.
Ручне переслання: `POST /v1/jobs/:id/retry-callback`.

### 8.4 Дозволені адреси

Основний сценарій — внутрішня адреса (`http://localhost:5678/...`), тож:

- `WEBHOOK_ALLOW_PRIVATE` = **`true`** за замовчуванням;
- `WEBHOOK_ALLOWED_HOSTS` — опційний строгий whitelist;
- завжди блокуються: `file:`, `ftp:`, `169.254.169.254` (метадані хмар), власний порт сервісу.

Це усвідомлений компроміс — задокументований, а не тихий.

---

## 9. Шаблони

### 9.1 Структура

```text
templates/story_pricing_pro/
  template.json      # опційний
  template.html      # entry
  preview.png        # опційний
  fonts/  images/
```

Мережеві й локальні ассети **однаково легальні** — це навмисна можливість проєкту.
`network` у маніфесті лише інформує, а не обмежує.

### 9.2 Маніфест

```jsonc
{
  "name": "story_pricing_pro",
  "title": "Pricing — Pro plan",
  "description": "Instagram story з тарифом Pro",
  "version": "1.0.0",
  "entry": "template.html",
  "kind": "image",                       // image | video | both
  "network": "required",                 // required | optional | none  (інформаційно)
  "default_format": "story",
  "supported_formats": ["story", "post_portrait"],
  "video": { "duration": 5, "fps": 30 },
  "vars": [
    { "name": "TITLE", "type": "string", "required": true,
      "description": "Заголовок", "example": "Launch week", "max_length": 60 },
    { "name": "PRICE", "type": "string", "required": true, "example": "$29" }
  ],
  "tags": ["pricing", "story", "en"]
}
```

### 9.3 Інференс

Немає `template.json` → маніфест будується автоматично: `name` = ім'я директорії,
`entry` = `template.html` (або єдиний `.html`), `vars` = унікальні `{{KEY}}` з HTML
(усі `string`, `required: false`), `kind: "both"`, `inferred: true`.

**Наслідок:** усі 10 наявних шаблонів працюють через API без жодних правок.

### 9.4 Підстановка змінних

- `{{KEY}}` — значення **екранується** (`& < > " '`). Це обов'язково: у сервісному режимі
  значення приходять ззовні.
- `{{{KEY}}}` — сира вставка HTML, свідомий opt-in.
- Невідомі плейсхолдери лишаються як є (не падаємо).
- Базовий URL для відносних ассетів — через `<base href>` (як зараз у `VideoRenderer`;
  в `ImageRenderer` це треба полагодити, §12).

---

## 10. Конфігурація

Правило CLAUDE.md зберігається: `process.env` читається **тільки** в `config/app_config.js`.

| Змінна | Дефолт | Опис |
| --- | --- | --- |
| **Шляхи** | | |
| `DATA_DIR` | `<project>/data` | корінь runtime-даних |
| `TEMPLATES_DIR` | `data/templates` | шаблони користувача |
| `BUILTIN_TEMPLATES_DIR` | `templates` | вбудовані |
| `OUTPUT_DIR` | `data/outputs` | артефакти |
| `OUTPUT_DIR_ALIAS` | `null` | як шлях бачить споживач (n8n у контейнері) |
| `JOB_STORE_DIR` | `data/jobs` | записи джобів |
| `TMP_DIR` | `os.tmpdir()` | кадри відео |
| **Сервер** | | |
| `EAVEXA_PORT` / `EAVEXA_HOST` | `8080` / `127.0.0.1` | HTTP |
| `EAVEXA_API_KEY` | `null` | якщо задано — потрібен `X-API-Key` |
| `EAVEXA_PUBLIC_URL` | `null` | інакше — з `X-Forwarded-*` / `Host` |
| `MAX_BODY_MB` | `10` | ліміт тіла |
| `SHUTDOWN_GRACE_MS` | `30000` | graceful shutdown |
| `IDEMPOTENCY_TTL_MS` | `600000` | вікно `Idempotency-Key` |
| `RESULT_TOKEN_SECRET` | `null` | підписані `?token=` для `/result` |
| **Рендер** | | |
| `RENDER_CONCURRENCY` | `3` | смуга картинок |
| `VIDEO_CONCURRENCY` | `1` | смуга відео |
| `QUEUE_MAX` | `100` | глибина черги |
| `RENDER_TIMEOUT_MS` | `60000` | ліміт одного рендеру |
| `SYNC_MAX_COST` | `90` | кадрів; більше → примусово async |
| `NETWORK_TIMEOUT_MS` | `15000` | зовнішні ресурси сторінки |
| `FONT_TIMEOUT_MS` | `5000` | `document.fonts.ready` |
| `SETTLE_MS` | `200` / `100` | пауза перед знімком (image / video) |
| `BROWSER_MAX_RENDERS` | `200` | плановий перезапуск браузера |
| `CHROME_SANDBOX` | `auto` | `auto` \| `on` \| `off` |
| `CHROME_PATH` | `null` | явний бінарник (інакше — Playwright свій) |
| `FFMPEG_PATH` | `null` | інакше `ffmpeg-static` |
| **Ліміти** | | |
| `MAX_WIDTH` / `MAX_HEIGHT` | `4096` | розмір |
| `MAX_VIDEO_DURATION` / `MAX_FPS` | `60` / `60` | відео |
| `MAX_FRAMES` | `3600` | загальний запобіжник |
| **Зберігання** | | |
| `STORAGE_DRIVER` | `local` | `local` \| `s3` \| `memory` |
| `PERSIST_SYNC_RENDERS` | `true` | писати на диск також sync-рендери |
| `RETENTION_MODE` | `keep` | `keep` \| `ttl` \| `consume` |
| `RETENTION_TTL_MS` | `null` | лише для `ttl` |
| `RETENTION_MAX_BYTES` | `null` | м'яка межа сховища |
| `JOB_CACHE_SIZE` | `500` | LRU активних джобів |
| `S3_*` | — | endpoint, bucket, key, secret, region, `force_path_style` (MinIO) |
| **Webhooks** | | |
| `WEBHOOK_SECRET` | `null` | HMAC |
| `WEBHOOK_MAX_ATTEMPTS` | `5` | спроб доставки |
| `WEBHOOK_TIMEOUT_MS` | `10000` | таймаут спроби |
| `WEBHOOK_ALLOW_PRIVATE` | `true` | внутрішні адреси |
| `WEBHOOK_ALLOWED_HOSTS` | `null` | строгий whitelist |
| `CALLBACK_INLINE_MAX_BYTES` | `262144` | межа base64 у webhook |
| **Інше** | | |
| `TEMPLATE_ALLOWED_HOSTS` | `null` | whitelist для `template.url` (SSRF) |
| `LOG_FORMAT` / `LOG_LEVEL` | `pretty` / `info` | логування |

---

## 11. CLI

### 11.1 Команди

```bash
eavexa render     [опції]                    # один рендер
eavexa batch      [--jobs data/jobs.json]    # legacy-режим
eavexa serve      [--port 8080]
eavexa templates  <list|show|preview|validate|new>
eavexa jobs       <list|show|cancel|prune|stats>
eavexa formats
eavexa doctor
```

### 11.2 `render`

```bash
eavexa render -t story_pricing_pro --var TITLE="Launch week" --var PRICE='$29' -o ./out.png
eavexa render --file ./my.html --format story -o ./out.png
cat my.html | eavexa render --stdin --format story -o - > out.png
echo '{"template":{"name":"story_faq"},"format":"story"}' | eavexa render --request - --json
eavexa render -t promo --video-duration 8 --fps 30 -o ./promo.mp4 \
              --callback-url http://localhost:5678/webhook/done
eavexa render -t story_faq --watch --open       # ре-рендер при зміні файлу
```

| Прапорець | Опис |
| --- | --- |
| `-t, --template <name>` | шаблон із реєстру |
| `--file <path>` / `--url <url>` / `--stdin` | інші джерела |
| `--request <path\|->` | повний JSON-запит (той самий контракт, що HTTP) |
| `-f, --format <key\|WxH[@dpr]>` | `story` або `1080x1920@2` |
| `--var K=V` (повторюваний), `--vars-file <json>` | змінні |
| `--video-duration --fps --crf --preset --keep-frames` | відео |
| `-o, --out <path\|->` | `-` = stdout |
| `--callback-url`, `--callback-header K=V` | webhook після завершення |
| `--offline`, `--strict-assets` | контроль зовнішніх ресурсів |
| `--json`, `--quiet`, `--verbose` | вивід |
| `--timeout <ms>`, `--concurrency <n>` | ліміти |
| `--watch`, `--open`, `--dry-run` | розробка |

### 11.3 Дисципліна виводу

| Режим | stdout | stderr |
| --- | --- | --- |
| звичайний | людський кольоровий вивід | — |
| `--json` | **рівно один** JSON-об'єкт | усі логи, банер, прогрес |
| `-o -` | сирі байти | усі логи, банер вимкнено |

`NO_COLOR` або не-TTY → без ANSI. Це те, що робить CLI придатним для pipeline.

### 11.4 Коди виходу

`0` успіх · `1` рендер провалився · `2` некоректний вхід · `3` таймаут ·
`4` немає залежності (Chromium/FFmpeg) · `5` рендер ок, але webhook не доставлено.

### 11.5 `doctor`

Перевіряє: версію Node, Chromium (і валідність `CHROME_PATH`), FFmpeg + кодеки
(`libx264`, `libvpx-vp9`), права на `TMP_DIR`/`OUTPUT_DIR`, доступність директорій шаблонів,
вільне місце, у контейнері — розмір `/dev/shm`. Таблиця `OK/FAIL`, exit `4` при фейлі.

---

## 12. Виправлення в наявному коді (Крок 0)

Реальні баги, знайдені при аналізі. У CLI вони «тихі», у сервісі стануть болючими.

| # | Файл | Проблема | Дія |
| --- | --- | --- | --- |
| B1 | `ImageRenderer.js:93`, `video_renderer.js:111` | `newContext({ device_scale_factor })` — Playwright очікує **`deviceScaleFactor`**. Опція мовчки ігнорується: PNG виходить 1080×1080, а рапортується 2160×2160 | перейменувати; тест на **фактичні** пікселі |
| B2 | `ImageRenderer.js:105` | `setContent(html, { url })` — такої опції немає, `base_url` для картинок no-op | `<base href>`, як у `VideoRenderer._inject_base_url()` |
| B3 | обидва `_apply_vars` | `replaceAll` без екранування → зламаний HTML / інжекція | екранування + `{{{RAW}}}` |
| B4 | обидва рендерери | немає таймаутів: `networkidle` на polling-шаблоні = вічне зависання | `setDefaultTimeout` + загальний дедлайн |
| B5 | `render_orchestrator.js` | послідовний `for` | смуги `RenderQueue` |
| B6 | `app_config.js:10` | `CHROME_PATH` дефолт `/opt/google/chrome/chrome` (Linux) | `null` + `CHROME_SANDBOX=auto` |
| B7 | `utils.js` | експортує `saveToJson/saveToTxt/appendToTxt/ensureDir`, а CLAUDE.md документує `save_json/load_json/retry/chunk/format_bytes` — половини не існує | привести до snake_case, додати відсутні |
| B8 | `utils.js:150` | помилки запису лише логуються, функція «успішна» | кидати |
| B9 | `render_job_builder.js:28` | `mkdirSync` у конструкторі — побічний ефект при імпорті | ленива побудова |
| B10 | `job_loader.js` | не валідує розширення картинок | `IMAGE_OUTPUT_EXTENSIONS` |
| B11 | `ImageRenderer.js` | ім'я файлу порушує CLAUDE.md | → `image_renderer.js` |

---

## 13. Логування та спостережуваність

- `shared/logger.js`: `LOG_FORMAT=pretty|json`. У `json` — рядок на подію:
  `{ ts, level, msg, request_id, job_id, render_id, phase, duration_ms }`.
- **Усі логи — у stderr.** stdout зарезервований під результат.
- Наскрізний `request_id` / `job_id` через увесь ланцюг.
- `GET /metrics` (Крок 6): `renders_total{type,status}`, `render_duration_seconds`,
  `queue_depth{lane}`, `browser_restarts_total`, `webhook_deliveries_total{status}`,
  `storage_bytes_total`.

---

## 14. Сумісність

- `npm start` і `data/jobs.json` працюють **як зараз** — це третій адаптер над `RenderService`.
  `RenderOrchestrator` перестає викликати рендерери напряму.
- `data/inputs/<job_id>/` лишається як третій шар резолву шаблонів (після user і builtin).
- API версіонується `/v1/` з першого дня.
- Версія після Кроку 4 → `2.0.0` (нові точки входу, змінена структура `src/`).

---

## 15. Тести

| Рівень | Що покриваємо |
| --- | --- |
| unit | `normalize_request` (усі гілки), інференс маніфесту, `validate_vars`, екранування, аргументи FFmpeg, бекоф ретраїв, парсер CLI |
| integration | реальний рендер 200×200 PNG (**перевірка фактичних пікселів** — регресія B1), 3-кадрове відео, атомарність запису, `Range` у `/result` |
| API | контракт кожного ендпоїнта, коди помилок, `Idempotency-Key` |
| resilience | рестарт із `running`-джобом → `INTERRUPTED` + webhook; webhook 5xx → ретрай; 4xx → зупинка |

Раннер — вбудований `node --test`, без нових залежностей.

---

## 16. Порядок реалізації

### Крок 0 — Фікси та фундамент (0.5–1 д) ✅
- [x] B1–B11 з §12
- [x] `node --test` + smoke-тест на фактичні пікселі
- [x] `package.json`: `bin`, `engines`, `files`, скрипти
- [x] `.env.example`
- **Готово, коли:** `npm test` зелений, PNG має правильний реальний розмір.

### Крок 1 — Ядро (1.5–2 д) ✅
- [x] `errors.js`, `ids.js`, `shared/logger.js`
- [x] `template_manifest.js` + `template_registry.js` (+ інференс)
- [x] `render_request.js` — нормалізація для всіх фронтів
- [x] `browser_pool.js`, `render_queue.js` (дві смуги)
- [x] `storage_adapter.js` (`local` + аліас + атомарний запис + checksum)
- [x] `render_service.js` — поки лише `render()`
- [x] `on_progress` у `VideoRenderer`
- [x] `RenderOrchestrator` → через `RenderService`
- **Готово, коли:** `npm start` працює як раніше, але через нове ядро.
- Відхилення від букви специфікації: `browser_pool.js` пулить цілі
  `image_renderer`/`video_renderer`, а не сирі Playwright-сторінки (§5.6) —
  свідомий компроміс, щоб не переписувати вже протестовані рендерери.

### Крок 2 — CLI (1 д) ✅
- [x] `args.js`, `output.js`, `cli.js`
- [x] `render`, `batch`, `formats`, `templates list|show`, `doctor`
- [x] дисципліна stdout/stderr, `--json`, `-o -`, коди виходу
- [x] `--watch`
- [x] `docs/cli.md`
- **Готово, коли:** `eavexa render … --json | jq` дає чистий JSON; **проєкт уже придатний до вжитку**.

### Крок 3 — Джоби та webhooks (1.5 д) ✅
- [x] `job_store.js` (тільки `File` — `Memory`-варіант не знадобився: тести
      використовують `FileJobStore` у тимчасовій директорії, що досить швидко)
- [x] `webhook_notifier.js` (HMAC, ретраї, `resume_pending`)
- [x] `RenderService.submit()` + прогрес
- [x] відновлення у `start()`
- [x] `--callback-url` у CLI
- [x] `eavexa jobs list|show|cancel|prune|stats`
- **Готово, коли:** вбити процес під час рендеру → після старту прилітає `render.failed`.
  Перевірено тестом, що імітує «осиротілий» джоб (`test/core/render_service_jobs.test.js`).
- Відоме обмеження: `jobs cancel` перериває рендер лише в межах того самого
  процесу (немає між-процесного сигналу до появи HTTP-сервера в Кроці 4);
  проти джоба з іншого процесу він просто позначає запис скасованим.

### Крок 4 — HTTP (1.5 д) ✅
- [x] `server.js`, `router.js`, middleware
- [x] `/v1/render`, `/v1/jobs/*`, `/v1/templates/*`, `/v1/formats`, `/healthz`, `/readyz`
- [x] стрімінг `/result` з `Range` і `ETag`
- [x] `Idempotency-Key`, graceful shutdown
- [x] `eavexa serve`
- [x] `docs/api.md` + `openapi.yaml`
- **Готово, коли:** повний цикл з n8n на тій самій машині працює через `result.path`.
  Перевірено вручну (`curl` end-to-end: sync binary/JSON, async + webhook, `GET /result`
  з `Range`/`ETag`/`304`) і автотестами (`test/server/`, 30+ тестів).
- Свідомі спрощення проти букви специфікації:
  - `/readyz` перевіряє лише насиченість черги (`QUEUE_MAX`), не живучість
    Chromium/FFmpeg напряму — це вже покриває `eavexa doctor`, який може дозволити
    собі спавнити процеси; `/readyz` викликається часто і має бути дешевим.
  - `GET /v1/templates/:name/preview` віддає статичний `preview.png` шаблону
    (як і описано в §9.1 — це вкладений asset, не рендер), а не рендерить/кешує
    щось на льоту.
  - `Idempotency-Key` кешується лише за значенням заголовка, без звірки тіла
    запиту — повторний виклик з тим самим ключем але іншим тілом поверне
    перший результат.
  - `output.type: "s3"`/`"push"` свідомо відхиляються з `INVALID_REQUEST`
    (Крок 6, ще не реалізовано) замість тихого прийняття.

### Крок 5 — Розгортання та документація (0.5–1 д)
- [ ] `docs/deployment.md`: **спершу bare metal** (systemd / Windows service / pm2), потім Docker
- [ ] `Dockerfile` + `docker-compose.yml` (eavexa + n8n)
- [ ] `docs/n8n.md` + готові workflow-JSON (sync-картинка, async-відео)
- [ ] `docs/templates.md` — маніфест

### Крок 6 — Полірування (1 д)
- [ ] `s3` і `push` драйвери, `/metrics`, rate limit
- [ ] `templates vendor` (локалізація віддалених шрифтів) — опційно
- [ ] CI: lint → test → (docker) → реліз
- [ ] `2.0.0` + CHANGELOG

**Разом ≈ 7–9 днів. Придатне до вжитку після Кроку 2, інтегроване з n8n — після Кроку 4.**

---

## 17. Цільові сценарії n8n (bare metal, одна машина)

**Картинка — синхронно, один вузол:**

```text
[Schedule] → [Google Sheets: read row]
          → [HTTP Request]
               POST http://localhost:8080/v1/templates/story_pricing_pro/render
               Body: { "TITLE": "{{$json.title}}", "PRICE": "{{$json.price}}" }
               Response Format: File
          → [Telegram: sendPhoto]
```

**Відео — асинхронно, файл із диску:**

```text
[Schedule] → [HTTP Request]
               POST http://localhost:8080/v1/render
               { "template": {"name":"promo"}, "video": {"duration":30},
                 "callback_url": "{{$execution.resumeUrl}}",
                 "metadata": {"row_id":"{{$json.id}}"} }
          → [Wait: On Webhook Call]                    ← з'єднання не висить
          → [IF event == "render.completed"]
          → [Read/Write Files from Disk]  ← {{ $json.result.path }}
          → [YouTube: upload]
```

`metadata` повертається у webhook як є — саме цим n8n зшиває відповідь із вихідним рядком даних.

Для Instagram Graph API, який тягне медіа по URL сам, замість читання з диску береться
`result.url` (або `output.type: "s3"`) — і байти взагалі не проходять через n8n.
