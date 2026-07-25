# EAVexa → Pipeline Integration Plan

> План доопрацювання EAVexa для використання в автоматизованих pipelines
> (n8n, Make, Zapier, Airflow, GitHub Actions, будь-який HTTP-клієнт).
>
> **Це документ «чому і що».** Технічна специфікація під реалізацію —
> [implementation_plan.md](./implementation_plan.md); там CLI піднято до рівноправного фронту,
> webhook-и описані як основний async-контракт, і доданий реєстр шаблонів.
> У разі розбіжностей пріоритет має `implementation_plan.md`.

---

## 1. Де ми зараз

EAVexa сьогодні — це **однократний CLI-батч**, а не сервіс:

| Аспект | Поточний стан | Чому це блокує pipeline |
| --- | --- | --- |
| Вхід | тільки `data/jobs.json` на диску | n8n не може передати дані — треба спершу писати файл |
| Шаблони | тільки `data/inputs/<job_id>/template.html` | немає inline-HTML, немає URL, немає шаблону з тіла запиту |
| Вихід | тільки файл у `data/outputs/<job_id>/` | n8n не отримує бінарник, немає URL, немає base64 |
| Процес | `npm start` → рендер усього → `exit` | немає сервера, Chromium стартує/гасне на кожен запуск (~1–3 с оверхеду) |
| Результат | кольоровий текст у stdout | неможливо розпарсити машинно |
| Помилки | `process.exitCode = 1`, текст у stdout | немає кодів помилок, немає структури |
| Конкурентність | послідовний `for` цикл | один повільний відеоджоб блокує все |
| Таймаути | відсутні | зависла сторінка = вічний процес |
| Ізоляція | `data/` всередині репозиторію | не працює в контейнері з read-only FS / кількома репліками |
| Пакування | немає Dockerfile | n8n майже завжди в Docker — потрібен образ з Chromium + FFmpeg |

Архітектура при цьому **хороша** і майже готова до сервісного режиму: рендерери (`ImageRenderer`,
`VideoRenderer`) вже мають чистий `render_html()` API з lifecycle `connect()/close()` — їх майже
не треба чіпати. Уся робота — це **обгортки навколо них**.

---

## 2. Цільова архітектура

```text
                    ┌──────────────────────────────────────┐
   n8n HTTP Request │  HTTP API  (src/server/)             │
   ─────────────────►  POST /v1/render        (sync)       │
                     │  POST /v1/render/async  (job + hook) │
   n8n Execute Cmd   │  GET  /v1/jobs/:id                   │
   ─────────────────►  GET  /v1/formats  /healthz  /readyz  │
     CLI (src/cli/)  └──────────────┬───────────────────────┘
                                    │
                          ┌─────────▼──────────┐
                          │  RenderService     │  ← єдина точка входу для всіх фронтів
                          │  (src/core/)       │
                          └─────────┬──────────┘
             ┌───────────────┬──────┴───────┬────────────────┐
             ▼               ▼              ▼                ▼
      TemplateResolver  BrowserPool   RenderQueue      StorageAdapter
      (inline/file/URL) (1 Chromium,  (concurrency,    (local / s3 /
                         N contexts)   timeout, TTL)    inline base64)
                                    │
                     ┌──────────────┴──────────────┐
                     ▼                             ▼
              ImageRenderer                  VideoRenderer → FfmpegEncoder
              (існує)                        (існує)
```

Ключовий принцип: **`RenderService` — єдине джерело правди**. CLI, HTTP і поточний
`jobs.json`-режим стають трьома тонкими адаптерами над ним. Жодної дублюючої логіки.

---

## 3. Контракт API (це те, що бачить n8n)

### 3.1 Синхронний рендер — `POST /v1/render`

Для зображень і коротких відео (< ~30 с рендеру).

```jsonc
{
  "template": {
    "html": "<html>…{{TITLE}}…</html>",   // АБО
    "url":  "https://cdn.example.com/t.html", // АБО
    "name": "story_pricing_pro"               // з реєстру шаблонів на диску
  },
  "format": "story",                       // або { "width":1080,"height":1920,"device_scale_factor":2 }
  "vars":   { "TITLE": "Launch week", "PRICE": "$29" },
  "video":  { "duration": 5, "fps": 30, "crf": 18 },  // опційно → відео замість PNG
  "output": {
    "type": "binary",        // binary | base64 | url | file
    "filename": "promo.mp4"
  },
  "options": { "timeout_ms": 60000, "settle_ms": 200 }
}
```

Відповідь (`output.type: "base64"`):

```jsonc
{
  "ok": true,
  "render_id": "r_01JABC…",
  "type": "video",
  "mime": "video/mp4",
  "width": 2160, "height": 3840, "dpr": 2,
  "duration": 5, "fps": 30, "frames": 150,
  "bytes": 4193021,
  "duration_ms": 18422,
  "data": "AAAAIGZ0eXBpc29t…"
}
```

При `output.type: "binary"` — сирі байти з `Content-Type: video/mp4` +
`X-Render-Id`, `X-Render-Width`, `X-Render-Height` у заголовках. Це **найзручніший режим для n8n**:
нода HTTP Request одразу кладе результат у `binary.data` і його можна кинути в Telegram/S3/Drive.

### 3.2 Асинхронний рендер — `POST /v1/render/async`

Для довгих відео. Те саме тіло + `"callback_url"`.

```jsonc
{ "ok": true, "job_id": "j_01JABC…", "status": "queued", "poll_url": "/v1/jobs/j_01JABC…" }
```

- `GET /v1/jobs/:id` → `{ status: "queued|running|done|failed", progress: 0.42, result: {…}, error: {…} }`
- По завершенню — `POST` на `callback_url` з тим самим payload (n8n Webhook node ловить його).
- `DELETE /v1/jobs/:id` → скасування.

### 3.3 Батч — `POST /v1/render/batch`

Приймає масив джобів (той самий формат, що `jobs.json`) → масив результатів.
Це прямий міст із поточного режиму: `jobs.json` стає просто тілом цього запиту.

### 3.4 Допоміжні

| Метод | Ендпоїнт | Призначення |
| --- | --- | --- |
| `GET` | `/v1/formats` | список пресетів — n8n може підвантажити в dropdown |
| `GET` | `/v1/templates` | список шаблонів у реєстрі |
| `GET` | `/healthz` | живий процес |
| `GET` | `/readyz` | Chromium + FFmpeg доступні, черга не переповнена |
| `GET` | `/metrics` | Prometheus (опційно) |

### 3.5 Єдиний формат помилки

```jsonc
{
  "ok": false,
  "error": {
    "code": "TEMPLATE_NOT_FOUND",   // машиночитаний
    "message": "Template \"story_x\" is not in the registry",
    "details": { "template": "story_x" },
    "render_id": "r_01JABC…"
  }
}
```

Коди: `INVALID_REQUEST`, `TEMPLATE_NOT_FOUND`, `TEMPLATE_FETCH_FAILED`, `UNKNOWN_FORMAT`,
`RENDER_TIMEOUT`, `PAGE_ERROR`, `ENCODE_FAILED`, `QUEUE_FULL`, `PAYLOAD_TOO_LARGE`,
`UNAUTHORIZED`, `INTERNAL`.
HTTP-статуси: 400 / 401 / 404 / 408 / 413 / 429 / 500 / 503 відповідно.

---

## 4. Що треба виправити в наявному коді (перед новим функціоналом)

Це реальні баги, знайдені при аналізі — вони «тихі» в CLI, але в сервісі стануть болючими.

| # | Файл | Проблема | Виправлення |
| --- | --- | --- | --- |
| B1 | `ImageRenderer.js:93`, `video_renderer.js:111` | `newContext({ device_scale_factor })` — Playwright очікує **`deviceScaleFactor`** (camelCase). Опція мовчки ігнорується → реальний PNG виходить 1080×1080, а не 2160×2160, хоча в результаті рапортується 2160. | перейменувати ключ; додати тест, що перевіряє фактичні пікселі PNG |
| B2 | `ImageRenderer.js:105-108` | `page.setContent(html, { url })` — `setContent` не має опції `url`. `base_url` для картинок — no-op, відносні шляхи до шрифтів/картинок не резолвляться. | використати той самий підхід, що у `VideoRenderer._inject_base_url()` (тег `<base href>`) |
| B3 | обидва рендерери, `_apply_vars` | `replaceAll` без екранування → значення з `<`, `&`, лапками ламають/інжектять HTML. У сервісному режимі vars приходять ззовні — це вже проблема безпеки. | екранувати за замовчуванням, дати opt-in `{{{RAW_KEY}}}` для сирого HTML |
| B4 | обидва рендерери | немає таймаутів: `waitUntil: 'networkidle'` на шаблоні з polling-запитом = вічне очікування | `page.setDefaultTimeout()`, загальний `Promise.race` з `RENDER_TIMEOUT` |
| B5 | `render_orchestrator.js:57,65` | послідовний `for` — 20 картинок рендеряться по черзі | `p-limit`-подібний пул з `RENDER_CONCURRENCY` |
| B6 | `app_config.js:10` | `CHROME_PATH` дефолт `/opt/google/chrome/chrome` — Linux-специфічний | дефолт `null` → нехай Playwright сам знаходить свій Chromium |
| B7 | `utils.js` | експортує `saveToJson/saveToTxt/appendToTxt/ensureDir` (camelCase), а `CLAUDE.md` документує `save_json/load_json/retry/chunk/format_bytes` — половини з них не існує | привести до snake_case з CLAUDE.md; додати `retry`, `format_bytes`, `format_duration` |
| B8 | `utils.js:150` | помилки запису лише логуються, функція «успішно» повертається | кидати помилку |
| B9 | `print()` | пише в `stdout` з ANSI-кольорами | у сервер/JSON-режимі — `stderr` + JSON-рядки (див. §6) |
| B10 | `job_loader.js` | не валідує розширення для картинок (`.png`) | додати `IMAGE_OUTPUT_EXTENSIONS` |

---

## 5. Фази реалізації

### Фаза 0 — Стабілізація (0.5–1 день)

- [ ] Виправити B1–B10.
- [ ] Додати `node --test` + перший smoke-тест: рендер простого HTML → перевірити розмір і сигнатуру PNG.
- [ ] Додати `engines: { node: ">=18" }`, `files`, `bin` у `package.json`.
- [ ] `.env.example` з усіма змінними.

**Результат:** те саме, що зараз, але без тихих багів і з тестом.

---

### Фаза 1 — Ядро: `RenderService` (1–2 дні)

Нові файли:

```text
src/core/
  render_service.js        # головний фасад: render(request) → result
  render_request.js        # нормалізація + валідація вхідного запиту (одна схема для CLI/HTTP)
  template_resolver.js     # inline html | file (реєстр) | remote url → { html, base_url }
  browser_pool.js          # 1 Chromium на процес, N паралельних контекстів, авто-restart
  render_queue.js          # concurrency limit, черга, таймаути, скасування
  storage_adapter.js       # local | memory(buffer) | s3 — куди лягає результат
  errors.js                # RenderError + коди з §3.5
```

Ключові рішення:

1. **`BrowserPool` замість `connect()/close()` на кожен батч.** Один Chromium живе весь час
   роботи процесу; контексти створюються/знищуються на запит. Економія ~1–3 с на запит.
   Авто-перезапуск, якщо браузер впав (`browser.on('disconnected')`), + `max_renders_before_restart`
   проти витоків пам'яті.
2. **`TemplateResolver` з whitelist.** Для `template.url` — тільки дозволені хости
   (`TEMPLATE_ALLOWED_HOSTS`), заборона приватних IP (SSRF). Для `template.name` — тільки з
   `TEMPLATES_DIR`, з нормалізацією шляху (path traversal).
3. **Результат у пам'яті за замовчуванням.** `render_html()` вже повертає Buffer для PNG;
   для відео — читати готовий файл у Buffer і видаляти tmp. Диск — лише один із бекендів.
4. **Робота в tmpdir.** Кадри відео → `os.tmpdir()/eavexa-<uuid>/`, не в `data/outputs`.
   Обов'язкове прибирання у `finally` + прибиральник осиротілих директорій при старті.

Рефактор існуючого: `RenderOrchestrator` починає викликати `RenderService` замість
рендерерів напряму. `src/index.js` (режим `jobs.json`) продовжує працювати **без змін для користувача**.

---

### Фаза 2 — CLI (0.5 дня)

```text
src/cli/
  cli.js            # bin-entry, парсинг аргументів
  commands/render.js
  commands/serve.js
  commands/validate.js
```

```bash
# n8n Execute Command node — stdin/stdout, без файлів
echo '{"template":{"html":"<h1>{{T}}</h1>"},"format":"story","vars":{"T":"Hi"}}' \
  | eavexa render --stdin --out - --json > out.png

eavexa render --template story_pricing_pro --format story --var TITLE="Pro" --out ./pro.png
eavexa render --jobs ./jobs.json --json          # поточний режим, але з JSON-виводом
eavexa serve --port 8080
eavexa validate --jobs ./jobs.json               # dry-run, лише валідація
```

Правила:
- `--json` → у **stdout** тільки один JSON-об'єкт; усі логи → stderr.
- `--out -` → бінарник у stdout.
- Коди виходу: `0` ok, `1` render failed, `2` invalid input, `3` timeout, `4` dependency missing.

---

### Фаза 3 — HTTP-сервер (1–2 дні)

```text
src/server/
  server.js              # створення + життєвий цикл
  routes/render.js
  routes/jobs.js
  routes/meta.js         # /formats /templates /healthz /readyz
  middleware/auth.js     # X-API-Key / Bearer
  middleware/limits.js   # body size, rate limit
  middleware/errors.js   # RenderError → HTTP
  job_store.js           # in-memory (Map + TTL); інтерфейс під Redis
  webhook_notifier.js    # POST на callback_url з retry + HMAC-підписом
```

Реалізація: **чистий `node:http`** (нуль нових залежностей, у проєкті їх свідомо мало) або
`fastify`, якщо потрібні схеми/валідація «з коробки». Рекомендую `node:http` + власний
роутер — API маленький (7 ендпоїнтів), а образ залишається легким.

Обов'язково:
- `graceful shutdown` на `SIGTERM`: перестати приймати, дочекатися активних рендерів (з дедлайном), закрити браузер.
- `503` + `Retry-After`, коли черга повна — n8n коректно ретраїть.
- `Content-Length` і ліміт тіла (`MAX_BODY_MB`, дефолт 10) — inline HTML з base64-картинками буває великим.
- Ідемпотентність: заголовок `Idempotency-Key` → кеш результату на TTL (повторний запит n8n після таймауту не рендерить двічі).

---

### Фаза 4 — Docker (0.5 дня)

Це **критична** фаза: n8n майже завжди в Docker, і без готового образу інтеграція не злетить.

```dockerfile
FROM mcr.microsoft.com/playwright:v1.60.0-jammy
# ffmpeg-static підтягується npm-ом, системний ffmpeg не потрібен
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production \
    EAVEXA_PORT=8080 \
    RENDER_CONCURRENCY=2 \
    TEMPLATES_DIR=/templates \
    OUTPUT_DIR=/outputs
EXPOSE 8080
USER pwuser
HEALTHCHECK --interval=30s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/cli/cli.js", "serve"]
```

Плюс `docker-compose.yml` з готовим стеком **n8n + eavexa** в одній мережі — щоб з n8n можна було
одразу звертатись на `http://eavexa:8080/v1/render`. Це найкраща «демка» проєкту.

Важливо: `--no-sandbox` уже є в аргументах запуску, але для Docker краще додати
`--disable-gpu`, `--shm-size=1g` у compose (інакше Chromium падає на великих сторінках),
і `init: true` (щоб зомбі-процеси Chromium прибирались).

---

### Фаза 5 — Готовність до продакшену (1 день)

- [ ] **Логи**: `LOG_FORMAT=pretty|json`. У `json` — по рядку на подію
      (`{ts, level, msg, render_id, job_id, duration_ms}`), у stderr. Наскрізний `render_id`.
- [ ] **Ліміти ресурсів**: `MAX_WIDTH/MAX_HEIGHT` (дефолт 4096), `MAX_VIDEO_DURATION` (дефолт 60 c),
      `MAX_FRAMES`. Без цього один запит `duration: 3600` покладе сервіс.
- [ ] **Безпека шаблонів**: приймаючи довільний HTML, ми приймаємо довільний JS.
      Мінімум — окремий browser context на запит (вже так), заборона `file://` через
      `--allow-file-access-from-files: off`, блокування приватних підмереж через
      `page.route()`, і чітко задокументувати: **сервіс не призначений для публічного доступу
      з ненадійним HTML** — тільки за API-ключем у довіреному периметрі.
- [ ] **Ретраї**: `retry()` навколо рендеру (1 повтор при `PAGE_ERROR`), не при `INVALID_REQUEST`.
- [ ] **Метрики**: `renders_total{type,status}`, `render_duration_seconds`, `queue_depth`, `browser_restarts_total`.
- [ ] **Тести**: unit (template_resolver, render_request, ffmpeg args) + integration
      (реальний рендер 200×200 PNG, 3-кадрове відео) + API-контракт (supertest-подібний).
- [ ] **CI** (GitHub Actions): lint → test → build Docker → push у GHCR по тегу.

---

### Фаза 6 — Нативна n8n-нода (опційно, 1–2 дні)

Після Фази 3 EAVexa **вже повністю використовується** в n8n через HTTP Request node.
Окрема нода — це UX-цукор, не необхідність.

```text
n8n-nodes-eavexa/
  credentials/EAVexaApi.credentials.ts   # baseUrl + apiKey
  nodes/EAVexa/EAVexa.node.ts            # resource: image|video, operation: render
  nodes/EAVexa/EAVexa.node.json
```

Фішки, які дає нода: dropdown форматів (тягне `/v1/formats`), dropdown шаблонів
(`/v1/templates`), автоматичне перетворення відповіді в n8n binary, вбудований polling
для async-джобів. Публікація в npm як `n8n-nodes-eavexa` з ключовим словом
`n8n-community-node-package`.

---

## 6. Конфігурація (нові змінні → `app_config.js`)

| Змінна | Дефолт | Призначення |
| --- | --- | --- |
| `EAVEXA_PORT` | `8080` | порт HTTP |
| `EAVEXA_HOST` | `0.0.0.0` | інтерфейс |
| `EAVEXA_API_KEY` | — | якщо задано — вимагається `X-API-Key` |
| `RENDER_CONCURRENCY` | `2` | паралельних рендерів |
| `QUEUE_MAX` | `50` | глибина черги перед `503` |
| `RENDER_TIMEOUT_MS` | `60000` | ліміт одного рендеру |
| `MAX_VIDEO_DURATION` | `60` | секунд |
| `MAX_WIDTH` / `MAX_HEIGHT` | `4096` | ліміт розміру |
| `MAX_BODY_MB` | `10` | ліміт тіла запиту |
| `TEMPLATES_DIR` | `data/inputs` | реєстр шаблонів |
| `OUTPUT_DIR` | `data/outputs` | для `output.type: "file"` |
| `TMP_DIR` | `os.tmpdir()` | кадри відео |
| `TEMPLATE_ALLOWED_HOSTS` | — | whitelist для `template.url` |
| `STORAGE_DRIVER` | `local` | `local` \| `s3` \| `memory` |
| `LOG_FORMAT` | `pretty` | `pretty` \| `json` |
| `JOB_TTL_MS` | `3600000` | скільки жиє результат async-джоба |
| `CHROME_PATH`, `FFMPEG_PATH` | — | існуючі |

Правило з CLAUDE.md зберігається: `process.env` — **тільки** в `app_config.js`.

---

## 7. Підсумковий цільовий layout

```text
EAVexa/
  Dockerfile
  docker-compose.yml            # eavexa + n8n демо-стек
  .env.example
  src/
    cli/
      cli.js                    # bin: eavexa
      commands/{render,serve,validate}.js
    server/
      server.js
      routes/{render,jobs,meta}.js
      middleware/{auth,limits,errors}.js
      job_store.js
      webhook_notifier.js
    core/
      render_service.js
      render_request.js
      template_resolver.js
      browser_pool.js
      render_queue.js
      storage_adapter.js
      errors.js
    config/                     # + server_config.js, limits_config.js
    modules/                    # без змін по суті (+ фікси B1–B5)
    shared/                     # utils приведені до CLAUDE.md
  test/
    unit/  integration/  fixtures/
  docs/
    api.md  deployment.md  n8n.md  pipeline_integration_plan.md
```

---

## 8. Порядок і оцінка

| Фаза | Обсяг | Залежить від | Цінність для pipeline |
| --- | --- | --- | --- |
| 0. Стабілізація | 0.5–1 д | — | без цього все інше успадкує баги |
| 1. `RenderService` | 1–2 д | 0 | ★★★ фундамент |
| 2. CLI | 0.5 д | 1 | ★★ вже працює в n8n Execute Command |
| 3. HTTP API | 1–2 д | 1 | ★★★ головна мета |
| 4. Docker | 0.5 д | 3 | ★★★ без нього n8n-юзер не запустить |
| 5. Продакшн | 1 д | 3, 4 | ★★ стабільність під навантаженням |
| 6. n8n-нода | 1–2 д | 3 | ★ UX, опційно |

**Мінімальний шлях до «працює в n8n»: Фази 0 → 1 → 3 → 4 (≈ 3–5 днів).**
Фаза 2 (CLI) — дешевий бонус, який можна зробити паралельно.

---

## 9. Сумісність

- `npm start` і `data/jobs.json` **продовжують працювати як зараз** — це залишається одним із
  адаптерів над `RenderService`. Жодних ламаючих змін для існуючих користувачів.
- Версія після Фази 3 → `2.0.0` (нові точки входу, змінена структура `src/`).
- API версіонується префіксом `/v1/` з першого дня.

---

## 10. Приклад використання в n8n (ціль)

```text
[Schedule Trigger]
      ↓
[Google Sheets: read row]  → { title, price, lang }
      ↓
[HTTP Request]
   POST http://eavexa:8080/v1/render
   Headers: X-API-Key: {{$credentials.key}}
   Body: {
     "template": { "name": "story_pricing_pro" },
     "format": "story",
     "vars": { "TITLE": "{{$json.title}}", "PRICE": "{{$json.price}}" },
     "output": { "type": "binary", "filename": "pricing.png" }
   }
   Response Format: File → binary
      ↓
[Telegram: sendPhoto]  /  [S3: upload]  /  [Instagram: publish]
```

Для відео — той самий вузол на `/v1/render/async` + `[Wait]` / `[Webhook]` для callback.
