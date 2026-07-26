# EAVexa 2.0.0 — Аудит реалізації

> Перевірка коду проти [specification.md](./specification.md) і [decisions.md](./decisions.md).
> Дата: 2026-07-26. Ревізія на момент аудиту: `e78865c v2.0.0 major release`.
> Стан тестів тоді: **116/116 зелені**, `npm run lint` чистий.
>
> Усі проблеми нижче відтворені **емпірично** (команди й реальний вивід наведені),
> окрім явно позначених як «знайдено читанням коду».

---

## ✅ Статус: усе закрито у 2.0.1

Повторна перевірка 2026-07-26 після виправлень: **120/120 тестів**, lint чистий,
кожен пункт A1–A10 підтверджено тим самим способом, яким ловився (див. «Підтверджено»
у кожному розділі). A11 — свідомі пропуски, лишаються за планом.

Документ збережено як історію: він пояснює, **чому** код виглядає саме так, і на що
дивитись, якщо щось із цього повернеться. Коментарі в коді посилаються сюди за ID.

## Зведення

| # | Рівень | Проблема | Файл | Статус |
| --- | --- | --- | --- | --- |
| [A1](#a1) | 🔴 критично | Async webhook віддає `result.url` на неіснуючий джоб → 404 | `core/render_service.js` | ✅ 2.0.1 |
| [A2](#a2) | 🔴 критично | Відео-рендер пише логи в stdout → `--json` і `-o -` зламані | `modules/renderer/video_renderer.js` | ✅ 2.0.1 |
| [A3](#a3) | 🟠 високо | Реєстр шаблонів порожній — `templates/` не існує | (відсутня директорія) | ✅ 2.0.1 |
| [A4](#a4) | 🟠 високо | Немає авто-деградації base64 → великий вебхук убʼє n8n | `core/render_service.js` | ✅ 2.0.1 |
| [A5](#a5) | 🟡 середньо | `doctor` рапортує OK для неіснуючих директорій | `cli/commands/doctor.js` | ✅ 2.0.1 |
| [A6](#a6) | 🟡 середньо | Старт читає **всі** джоби — лінійна деградація назавжди | `core/job_store.js` | ✅ 2.0.1 |
| [A7](#a7) | 🟡 середньо | Таймаут не зупиняє рендер — ліміт конкурентності обходиться | `core/render_queue.js` | ✅ 2.0.1 (частково, див. розділ) |
| [A8](#a8) | 🟡 середньо | Артефакт лягає в директорію `render_id`, а не `job_id` | `core/render_service.js` | ✅ 2.0.1 |
| [A9](#a9) | 🟢 низько | Подвійна нормалізація запиту на кожен HTTP-виклик | `server/routes/render.js` | ✅ 2.0.1 |
| [A10](#a10) | 🟢 низько | Мертвий код: `render_file` / `render_batch` в обох рендерерах | `modules/renderer/*` | ✅ 2.0.1 |
| [A11](#a11) | ⚪ інфо | Свідомі пропуски проти специфікації | різне | за планом |

Порядок виправлення був: A2 → A1 → A3 → A4 → решта (A2 першим, бо доки stdout брудний,
не можна довіряти виводу під час перевірки решти).

---

<a id="a1"></a>
## A1 🔴 Async webhook віддає посилання на неіснуючий джоб

### Симптом

n8n отримує вебхук, іде по `result.url` — і ловить `404 JOB_NOT_FOUND`.
Це рівно той сценарій, заради якого будувався весь async-контракт
([specification.md §17](./specification.md), приклад «Відео — асинхронно»).

### Відтворення

Async-рендер із `callback_url`, потім перехід по посиланню з вебхука:

```text
envelope.job_id      : j_01KYF2X04TH5ZS4MBFBVR8
webhook job_id       : j_01KYF2X04TH5ZS4MBFBVR8
result.render_id     : r_01KYF2X04TH5ZS4MBFBVR7
result.url           : http://127.0.0.1:63053/v1/jobs/r_01KYF2X04TH5ZS4MBFBVR7/result

--- FOLLOW result.url (те, що робить n8n) ---
status: 404
{"ok":false,"error":{"code":"JOB_NOT_FOUND",
 "message":"Job \"r_01KYF2X04TH5ZS4MBFBVR7\" was not found"}}

--- FOLLOW envelope.result_url ---
status: 200   bytes: 803
```

### Корінь

[`render_service.js:356-359`](../src/core/render_service.js#L356) будує URL з `request.render_id`:

```js
_build_result_url(request) {
  if (!request.origin?.public_base_url) return null;
  return `${request.origin.public_base_url}/v1/jobs/${request.render_id}/result`;
}
```

А запис джоба створюється в [`_build_initial_job`](../src/core/render_service.js#L146) з
окремим `new_job_id()`. Два різні ідентифікатори — посилання вказує в порожнечу.

**Чому тести це пропустили:** синхронний шлях працює випадково — 
[`render.js:76`](../src/server/routes/render.js#L76) `persist_sync_job_record()` створює запис
із `id: result.render_id`, тож для sync ідентифікатори збігаються. Наскрізного async-тесту
з переходом по `result.url` немає.

### Фікс

Прокинути `job_id` через ланцюг виконання і використовувати його для посилання:

```js
// _run_job: передати job_id у виконання
() => this._execute(request, on_progress, job_id)

// _execute(request, on_progress, link_id) → далі в _render_image / _render_video

// _build_result(request, stored, media, started_at, link_id)
const url = stored.url ?? this._build_result_url(request, link_id ?? request.render_id);

_build_result_url(request, id) {
  if (!request.origin?.public_base_url) return null;
  return `${request.origin.public_base_url}/v1/jobs/${id}/result`;
}
```

Той самий `link_id` треба передати і в `storage.put()` / `storage.finalize()` — див. [A8](#a8),
це один і той самий корінь.

> Альтернатива (дешевша, але грубіша): у `submit()` створювати джоб із `id = request.render_id`,
> відмовившись від `new_job_id()`. Тоді ідентифікатори збігаються скрізь, але префікс `j_`
> перестає використовуватись, і async-джоби стають незрізняними від sync за ID.

### ✅ Підтверджено у 2.0.1

Обрано основний варіант (прокидання `link_id`), префікс `j_` збережено:

```text
envelope.job_id  : j_01KYFE0VZQTASA47KQ4BWP
result.render_id : r_01KYFE0VZQTASA47KQ4BWN
result.url       : http://127.0.0.1:58177/v1/jobs/j_01KYFE0VZQTASA47KQ4BWP/result
→ FOLLOW result.url : status 200, bytes 803
```

Регресійний тест на місці (`test/server/server.test.js`) — і він перевіряє не форму рядка,
а реальний перехід:

```js
assert.match(webhook_payload.result.url, new RegExp(`^${base_url}/v1/jobs/${body.job_id}/result$`));
const file_res = await fetch(webhook_payload.result.url);
assert.equal(file_res.status, 200, 'result.url from the webhook payload must resolve, not 404');
```

---

<a id="a2"></a>
## A2 🔴 Відео-рендер пише логи в stdout

### Симптом

Принцип №1 специфікації («stdout священний») порушено для **всього відео** — тобто саме
для того режиму, заради якого робився async.

### Відтворення

```bash
eavexa render --file v.html --format 200x200@1 --video-duration 1 --fps 10 -o out.mp4 --json
```

```text
SyntaxError: Unexpected token '▲', "▲ │ 2026-0"... is not valid JSON
```

Бінарний режим псується так само — потік починається не з MP4-хедера:

```bash
eavexa render --file v.html --video-duration 1 --fps 5 -o -
```

```text
bytes: 2105 | first 12: "â² â 2026"
```

Для картинок stdout чистий — але **випадково**: логи стоять у `render_file()`/`render_batch()`,
якими ядро не користується, а `render_html()` картинок мовчить.

### Корінь

[`logger.js`](../src/shared/logger.js) коректно пише в stderr, але рендерери досі кличуть
`print()` із `shared/utils.js`, а той — `console.log` → stdout.

Живі виклики (у тих методах, які реально викликає `RenderService`):

| Файл | Рядки |
| --- | --- |
| [`video_renderer.js`](../src/modules/renderer/video_renderer.js#L115) | `115`, `140`, `239`, `285` |
| [`image_renderer.js`](../src/modules/renderer/image_renderer.js#L197) | `197` |

Решта викликів `print()` у цих файлах — у мертвому коді, див. [A10](#a10).

### Фікс

У `image_renderer.js` і `video_renderer.js` замінити `print()` на `log()` з
`shared/logger.js`:

```js
import { log } from '../../shared/logger.js';

log({ level: 'info',  msg: `Capturing ${total_frames} frame(s) at ${video_options.fps}fps` });
log({ level: 'debug', msg: `Frame ${frame_index + 1}/${total_frames}` });
```

`print()` лишити **тільки** в [`render_result_reporter.js`](../src/modules/orchestrator/render_result_reporter.js) —
це legacy-батч, там stdout і є інтерфейсом користувача.

### ✅ Підтверджено у 2.0.1

`grep -rn "print(" src/modules/renderer/` — порожньо. Обидва режими чисті:

```text
video --json : PARSED OK — type video, frames 10, bytes 1932
video -o -   : bytes 1785 | ftyp at 4-8: "ftyp" | valid MP4: true
```

Два регресійні тести в `test/cli/render_command.test.js` — саме на **відео**, бо для картинок
stdout був чистий випадково.

---

<a id="a3"></a>
## A3 🟠 Реєстр шаблонів порожній

### Симптом

```js
registry.list() → []
```

Директорії `templates/` у проєкті **немає**. При цьому на `story_pricing_pro` посилаються:

- `README.md`
- [`docs/api.md`](./api.md), [`docs/cli.md`](./cli.md), [`docs/templates.md`](./templates.md), [`docs/n8n.md`](./n8n.md)
- готовий до імпорту workflow [`docs/n8n/sync_image.json`](./n8n/sync_image.json)

Тобто **всі приклади з документації не працюють** — включно з тим, який користувач
імпортує в n8n першим.

Додатково: `package.json` → `"files": ["src", "templates", …]` перелічує неіснуючу
директорію; `npm pack` мовчки покладе порожнечу.

Десять реальних шаблонів так і лишились у `data/inputs/` (gitignored, недоступні реєстру).

### Фікс

Перенести шаблони в `templates/` і додати маніфести за схемою
[specification.md §9.2](./specification.md):

```text
templates/story_pricing_pro/
  template.json
  template.html
```

Мінімум — один робочий шаблон, щоб приклади з README і n8n-workflow виконувались.
Інференс маніфесту вже реалізований, тож `template.json` можна додати не одразу —
але тоді `default_format` доведеться передавати в кожному запиті.

### ✅ Підтверджено у 2.0.1

```text
templates list → 2
  - promo             | kind video | fmt story | vars 4 | inferred false
  - story_pricing_pro | kind image | fmt story | vars 2 | inferred false
```

Обидва з повноцінними маніфестами (`inferred: false`), тож `default_format` не треба
передавати в кожному запиті. Приклад із README відпрацьовує: `2160x3840, 339514 bytes`.
Регресійний тест у `test/core/template_registry.test.js` звіряє реєстр з іменами,
які згадує документація.

---

<a id="a4"></a>
## A4 🟠 Немає авто-деградації base64

*(знайдено читанням коду)*

### Симптом

`output.type: "base64"` + async + великий файл = тіло вебхука на десятки МБ.
Дефолтний ліміт n8n — близько 16 МБ, base64 додає ще +33%. Запит просто відкидається.

Це **та сама проблема**, проти якої писався розділ Р4 в [decisions.md](./decisions.md),
і [specification.md §7.2](./specification.md) вимагала тихої деградації:

> при `base64` у webhook, якщо `bytes < CALLBACK_INLINE_MAX_BYTES`, інакше авто-деградація
> до посилання + `"downgraded_from":"base64"`

### Корінь

- `CALLBACK_INLINE_MAX_BYTES` — **0 згадок** у `src/`;
- [`render_service.js:331`](../src/core/render_service.js#L331) кладе base64 у результат безумовно:
  ```js
  const data = request.output.type === 'base64' ? (await readFile(stored.local_path)).toString('base64') : null;
  ```
- [`webhook_notifier.js:177`](../src/core/webhook_notifier.js#L177) відправляє `job.result` цілком.

### Фікс

1. Додати `CALLBACK_INLINE_MAX_BYTES` (дефолт `262144`) в `config/app_config.js`.
2. У `_build_result` не кодувати base64, якщо `stored.bytes > CALLBACK_INLINE_MAX_BYTES` —
   натомість лишити `data: null` і виставити `downgraded_from: 'base64'`.
3. Для sync-режиму деградацію **не** застосовувати (там ліміту немає — клієнт сам попросив).
   Тобто рішення залежить від `request.mode`.

### ✅ Підтверджено у 2.0.1

Перевірено обидва напрямки з `CALLBACK_INLINE_MAX_BYTES=100`:

```text
ASYNC (579 bytes) : data = null (degraded), downgraded_from = "base64", url = present
SYNC  (той самий) : data = 772 chars inline, downgraded_from = null
```

Логіка враховує `request.mode`, тож sync-клієнт, який попросив base64 явно й читає
відповідь напряму, ніколи не деградує. Обидва напрямки покриті тестами
в `test/core/render_service_jobs.test.js`.

---

<a id="a5"></a>
## A5 🟡 `doctor` рапортує OK для неіснуючих директорій

### Симптом

```text
◉ [OK] OK    BUILTIN_TEMPLATES_DIR — S:\Daedalus\Aureum\EAVexa\templates
```

Директорії не існує (див. [A3](#a3)). Health-check, який не перевіряє, гірший за відсутній —
він дає хибну впевненість саме там, де користувач шукає причину «шаблон не знайдено».

### Корінь

[`doctor.js:57-58`](../src/cli/commands/doctor.js#L57) — статуси захардкоджені:

```js
{ name: 'BUILTIN_TEMPLATES_DIR', ok: true, detail: BUILTIN_TEMPLATES_DIR },
{ name: 'TEMPLATES_DIR (user)',  ok: true, detail: TEMPLATES_DIR },
```

### Фікс

Перевіряти існування і читабельність. Нюанс: відсутність **користувацької**
`TEMPLATES_DIR` — нормальна ситуація (її може не бути взагалі), тож для неї доречний
статус `WARN`/`skip`, а не `FAIL`. Відсутність `BUILTIN_TEMPLATES_DIR` — це `FAIL`.

Варто також додати рядок «шаблонів знайдено: N» через `registry.list()` — саме це
користувач і хоче знати.

### ✅ Підтверджено у 2.0.1

```text
OK    BUILTIN_TEMPLATES_DIR — S:\Daedalus\Aureum\EAVexa\templates
OK    TEMPLATES_DIR (user) — not set — ...\data\templates does not exist (optional)
OK    Templates in registry — 2 found: promo, story_pricing_pro
```

З підміненим `BUILTIN_TEMPLATES_DIR` на неіснуючий шлях — `FAIL ... not found`
і **exit code 4**; на здоровому оточенні — `0`. Відсутність користувацької директорії
коректно трактується як `optional`, а не як провал.

---

<a id="a6"></a>
## A6 🟡 Старт читає всі джоби — лінійна деградація назавжди

*(знайдено читанням коду)*

### Симптом

`RenderService.start()` викликає `orphaned_running()` і `pending_callbacks()`, і **кожен**
із них проходить [`_all_jobs()`](../src/core/job_store.js#L178) — повне читання всіх файлів
джобів.

За рішенням Р3 ([decisions.md](./decisions.md)) записи **не видаляються ніколи**.
Через рік роботи це десятки тисяч `readFile` на кожен старт процесу — а LRU-кеш на 500
записів тут не допомагає, лише витісняє сам себе.

Для CLI це гірше, ніж для сервера: кожен `eavexa render --callback-url …` — це новий процес,
тобто повний скан на кожен виклик.

### Фікс

Варіанти, від дешевого до правильного:

1. **Обмежити скан вікном:** `_all_jobs({ since_days: 7 })` — джоб, що «висів» довше тижня,
   відновлювати немає сенсу. Найдешевше, знімає 95% проблеми.
2. **Легкий індекс активних:** `data/jobs/_active.json` зі списком id у статусах
   `queued`/`running`/`pending`-callback. Оновлюється при зміні статусу, читається на старті.
3. Виконувати відновлення тільки для `serve`, а не для одноразового CLI (з окремою
   командою `eavexa jobs recover`).

### ✅ Підтверджено у 2.0.1

Обрано варіант 1 — вікно `JOB_RECOVERY_WINDOW_DAYS` (дефолт 7):
`orphaned_running()` і `pending_callbacks()` приймають `{ since_days }`, а `_all_jobs()`
припиняє обхід, щойно директорія дати випадає з вікна.

**Компроміс, який варто пам'ятати:** джоб, старший за вікно, не відновлюється взагалі.
Якщо доставка вебхука може лишатись незавершеною довше семи днів — значення треба підняти.
Задокументовано в `.env.example` і [specification.md §10](./specification.md).

---

<a id="a7"></a>
## A7 🟡 Таймаут не зупиняє рендер

*(знайдено читанням коду)*

### Симптом

[`render_queue.js:96`](../src/core/render_queue.js#L96) робить `Promise.race` між задачею,
таймаутом і abort-сигналом. Коли виграє таймаут, виклик відхиляється — але **сама задача
продовжує виконуватись**, а `finally` одразу звільняє слот смуги:

```js
} finally {
  if (timer) clearTimeout(timer);
  this.running[lane] -= 1;
  this._drain(lane);
}
```

Наслідки:
- серія таймаутів → фактична кількість одночасних рендерів перевищує
  `RENDER_CONCURRENCY`/`VIDEO_CONCURRENCY`;
- покинутий рендер доводить справу до кінця і пише «нічийний» артефакт у `outputs`,
  на який не вказує жоден джоб;
- для відео покинута задача ще й тримає контекст Chromium.

### Фікс

Прокинути скасування до самого рендеру, а не лише до виклику:

1. Створювати `AbortController` на задачу і передавати `signal` у `_execute` → рендерер.
2. У рендерерах на `abort` закривати контекст сторінки (`context.close()`), а для відео —
   переривати цикл кадрів між ітераціями та вбивати FFmpeg-процес.
3. Звільняти слот смуги лише після того, як задача **фактично** завершилась.

Мінімальний варіант, якщо повне скасування зараз дороге: лишити race, але тримати слот
зайнятим до реального завершення задачі (`await Promise.allSettled([task])` у фоні перед
`_drain`), щоб хоча б не порушувався ліміт конкурентності.

### ✅ Підтверджено у 2.0.1 — частково, свідомо

Реалізовано **мінімальний варіант**: `task_promise` створюється до гонки, а звільнення слоту
винесене у відкладений `.finally()`, тож смуга тримається до фактичного завершення задачі.
Ліміт конкурентності більше не обходиться.

**Що лишається за дизайном:** покинутий рендер усе одно догравє до кінця й дописує
«нічийний» артефакт у `outputs`. Повне скасування вимагало б, щоб кожен рендерер реагував
на `AbortSignal` (закриття контексту сторінки, переривання циклу кадрів, вбивство
FFmpeg-процесу) — це окрема робота, і вона свідомо не робилась зараз. Обмеження виписане
в коментарі в `render_queue.js` з посиланням на цей розділ.

Побічний ефект, який варто знати: `SHUTDOWN_GRACE_MS` тепер справді чекає завислу задачу,
а не «звільнений» слот. Поведінка після вичерпання grace вже покрита тестом
(`close() gives up after grace_ms`).

---

<a id="a8"></a>
## A8 🟡 Артефакт лягає в директорію `render_id`, а не `job_id`

### Симптом

[specification.md §3](./specification.md) описує розкладку
`outputs/<YYYY-MM-DD>/<job_id>/<filename>`. Фактично:

```text
outputs/2026-07-26/r_01KYF2X04TH5ZS4MBFBVR7/r_01KYF2X04TH5ZS4MBFBVR7.png
                   ^^^^^^^^^^^^^^^^^^^^^^^ render_id, хоча джоб — j_01KYF2X04TH5ZS4MBFBVR8
```

Зіставити директорію на диску з джобом неможливо, не відкривши запис джоба. Для сценарію
«n8n читає файл із диску» (основний за [decisions.md Р4.2](./decisions.md)) це псує
діагностику: по шляху не видно, який джоб його породив.

### Корінь

Той самий, що [A1](#a1) — [`render_service.js:273`](../src/core/render_service.js#L273)
і [`:304`](../src/core/render_service.js#L304) передають `job_id: request.render_id`.

### Фікс

Разом із A1: передавати `link_id` (справжній `job_id` для async, `render_id` для sync).

### ✅ Підтверджено у 2.0.1

```text
outputs/2026-07-26/j_01KYFE0VZQTASA47KQ4BWP/r_01KYFE0VZQTASA47KQ4BWN.png
                   ^^^^^^^^^^^^^^^^^^^^^^^ = job_id, збігається з записом джоба
```

Директорія тепер зіставляється з джобом без відкриття запису; ім'я файлу лишається
за `render_id`, що зручно для трасування конкретного рендеру.

---

<a id="a9"></a>
## A9 🟢 Подвійна нормалізація запиту

[`render.js:26`](../src/server/routes/render.js#L26) нормалізує запит, щоб вирішити
sync/async, а потім `submit()` / `render()` нормалізують його **вдруге**:

```js
const normalized = await normalize_request(raw_request, { registry: ctx.service.registry });

if (normalized.mode === 'async') {
  const { job } = await ctx.service.submit(raw_request);   // ← нормалізація #2
```

Наслідки: подвійний резолв шаблону й читання маніфесту на кожен HTTP-запит, і два різні
`render_id` (перший просто викидається).

**Фікс:** дозволити `submit()`/`render()` приймати вже нормалізований запит
(наприклад, `submit(request, { normalized: true })`), або винести рішення про режим
в окрему дешеву функцію.

**✅ Підтверджено у 2.0.1** — `render()` і `submit()` приймають
`{ normalized: true }`; HTTP-шар нормалізує один раз і передає результат далі.
CLI та legacy-батч продовжують передавати сирий запит.

---

<a id="a10"></a>
## A10 🟢 Мертвий код у рендерерах

`render_file()` і `render_batch()` в обох рендерерах **не викликаються нізвідки** за межами
самих файлів рендерерів:

```bash
grep -rn "render_file\|render_batch" src/ | grep -v "^src/modules/renderer/"
# (порожньо)
```

Legacy-шлях тепер іде через `RenderService` — [`render_orchestrator.js`](../src/modules/orchestrator/render_orchestrator.js)
став тонким адаптером і кличе `render_service.render()`.

**Фікс:** видалити `render_file()` / `render_batch()` з обох рендерерів. Це заодно прибирає
більшість викликів `print()` з [A2](#a2) і знімає плутанину «чому логи є, але їх не видно».

**✅ Підтверджено у 2.0.1** — обидва методи видалені, grep за межами рендерерів порожній.
Разом із ними пішли тести, що покривали лише мертвий шлях (`test/image_renderer.test.js`, −30 рядків).

---

<a id="a11"></a>
## A11 ⚪ Свідомі пропуски проти специфікації

Це **не баги** — фіксую, щоб не загубилось.

| Пропущено | Наслідок | Оцінка |
| --- | --- | --- |
| `RETENTION_MODE` / `RETENTION_TTL_MS`, `core/retention.js` | дефолт `keep` = «нічого не робити», тож поведінка збігається зі специфікацією; `eavexa jobs prune`/`stats` є | прийнятно |
| `PERSIST_SYNC_RENDERS` | sync-рендери **завжди** пишуться на диск, вимкнути не можна | прийнятно, але варто додати при високочастотній генерації |
| `assets` / `fonts_ready` у результаті ([spec §6.5](./specification.md), [Р1](./decisions.md)) | немає діагностики провалених ассетів — «чому шрифт не той» доведеться дебажити наосліп | варто додати |
| `offline` / `strict_assets` | приймаються, але не застосовуються — чесно позначено коментарем у [`render_request.js:245`](../src/core/render_request.js#L245) | ок, поведінка задокументована |
| `SETTLE_MS` як env | значення захардкоджені в рендерерах | дрібниця |
| `s3` / `push` драйвери | коректно відхиляються з `INVALID_REQUEST` і зрозумілим текстом | правильне рішення |
| `/metrics`, rate limit | відсутні | свідомо, за `docs/index.md` |

---

## Що зроблено добре

Щоб не створювати враження, ніби все погано — фіксую перевірене:

- **B1–B11 із [specification.md §12](./specification.md) закриті й підтверджені.**
  Зокрема `deviceScaleFactor`: реальний PNG справді `400×400` при `@2` — перевірено
  читанням IHDR, а не довірою до звіту.
- **Екранування** в [`html_template.js`](../src/shared/html_template.js) з правильним
  порядком: спершу `{{{RAW}}}`, потім `{{ESC}}` — інакше сира вставка теж екранувалась би.
- **`FileJobStore`** — атомарний запис через `.tmp` → `rename`, шардування по датах,
  курсорна пагінація без глобального індексу. Акуратно.
- **`BrowserPool._ensure_connected`** коректно дедуплікує паралельні `connect()` —
  неочевидна гонка (кожен слот смуги запускав би свій Chromium), і вона врахована
  з поясненням у коментарі.
- **`GET /result`** — стрімінг, `Range`/`206`, `ETag`/`304`, `416` на некоректний діапазон.
  Зроблено як слід, без буферизації файлу в пам'ять.
- **Відхилення від спеки задокументовані в коді** — наприклад, пул рендерерів замість пулу
  сторінок у [`browser_pool.js`](../src/core/browser_pool.js) з поясненням чому.

---

## Чекліст

```text
[x] A2  print() → log() у рендерерах; тест на чистоту stdout для ВІДЕО
[x] A1  прокинути job_id у _build_result_url; наскрізний async-тест із переходом по result.url
[x] A8  той самий job_id у storage.put/finalize          (один коміт із A1)
[x] A3  перенести шаблони в templates/ + маніфести; тест «приклади з docs існують»
[x] A4  CALLBACK_INLINE_MAX_BYTES + downgraded_from; тест на деградацію
[x] A5  doctor: реальна перевірка директорій + лічильник шаблонів
[x] A10 видалити render_file/render_batch                (спрощує A2)
[x] A6  обмежити скан джобів вікном або індексом активних
[~] A7  утримання слоту до фактичного завершення (повне скасування — свідомо відкладене)
[x] A9  прибрати подвійну нормалізацію
[ ] A11 за бажанням: assets-діагностика, PERSIST_SYNC_RENDERS
```

Версію піднято до `2.0.1`; `CHANGELOG.md` містить явне попередження, що async `result.url`
до 2.0.1 був неробочим — це поведінка, на яку могли зав'язатись обхідними шляхами
(через `envelope.result_url`).

---

## Що лишається відкритим

Єдиний пункт — [A11](#a11), і це свідомий обсяг робіт, а не борг за помилки:

| Пункт | Коли стане потрібним |
| --- | --- |
| `assets` / `fonts_ready` у результаті | коли зʼявиться «шрифт не той» і треба буде діагностувати, а не гадати |
| `PERSIST_SYNC_RENDERS` | при високочастотній генерації картинок, де файли на диску не потрібні |
| `RETENTION_MODE` / `retention.js` | коли `keep` перестане влаштовувати і знадобиться авто-прибирання |
| `offline` / `strict_assets` (реальне застосування) | для детермінованих рендерів у закритому контурі |
| `s3` / `push`, `/metrics`, rate limit | при виході за межі однієї машини з n8n поруч |
