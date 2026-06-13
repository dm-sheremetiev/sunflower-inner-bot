# Sunflower AI — функциональная спецификация

> Документ для реализации в Claude Code. Описывает, **как всё должно работать**:
> backend, frontend, данные, LLM, аутентификация, деплой и порядок сборки.
> Самодостаточен — можно читать без других файлов.

---

## 0. Суть

`sunflower-ai` — инфраструктура для AI-узлов экосистемы Sunflower (цветочный
магазин). **Первый и единственный сейчас узел** — анализ диалогов с клиентами из
KeyCRM **локальными моделями** (Ollama на GPU-сервере) вместо внешнего API,
с сохранением результатов в БД и просмотром в веб-дашборде.

Репозиторий держит **только backend (`apps/api`) и frontend (`apps/web`)**.
Новые узлы (сайт, остатки на заказы, банковские выписки) добавляются позже как
отдельные модули/приложения внутрь.

Поток в одном предложении: **KeyCRM → нормализация диалогов → нарезка на чанки →
локальная LLM (анализ в JSON) → Postgres (+ опционально Google Sheets) →
дашборд**.

---

## 1. Компоненты

| Сервис   | Технология              | Порт  | Назначение                                  |
| -------- | ----------------------- | ----- | ------------------------------------------- |
| `api`    | Fastify + TypeScript    | 4000  | Пайплайн анализа, REST, auth, cron          |
| `web`    | Next.js 16 (App Router) | 3000  | Дашборд: состояние, прогоны, анализы        |
| `db`     | PostgreSQL 16           | 5432  | Пользователи, прогоны, результаты анализа   |
| `ollama` | Ollama (OpenAI-совмест.)| 11434 | Локальные LLM на GPU                         |

Провайдер LLM **сменяемый** через переменную `LLM_PROVIDER`: `ollama` (по
умолчанию, локально) | `claude` | `openai`. Код анализа от провайдера не зависит.

```
KeyCRM Admin API ──► api (Fastify) ──► Ollama (/v1/chat/completions, GPU)
                        │
                        ├──► Postgres (Prisma)
                        ├──► Google Sheets (опционально)
                        └──► REST (JWT) ──► web (Next.js dashboard) ──► браузер
```

---

## 2. Текущее состояние репозитория (скелет уже есть)

Уже заложено и **типизированно проверено** (кроме генерации Prisma-клиента,
которая делается командой на машине):

- Монорепо: `apps/api`, `apps/web`, общий `docker-compose.yml` + dev-compose. У
  каждого приложения **свой** `node_modules` (без npm workspaces).
- `apps/api`: каркас `config/env.ts` (zod), `db/prisma.ts`, `services/llm/*`
  (фабрика провайдеров), `services/analysis/persistence.service.ts`,
  `plugins/auth.ts` (JWT), роуты `auth/runs/analyses/status`, `app.ts`+`server.ts`,
  `prisma/schema.prisma` + `prisma.config.ts` + `seed.ts`, `Dockerfile`.
- Существующий пайплайн (`daily-report`, `keycrm`, `compression`, `sheets`,
  `claude`, `openai`) сохранён и переведён на фабрику провайдеров + запись в БД.
- `apps/web`: страницы `login`, обзор, `runs`, `runs/[id]`, api-клиент, Dockerfile.

**Что нужно довести при реализации** (см. раздел 7): прогнать миграции и сид,
подобрать модель Ollama и системный промпт под JSON-схему (раздел 3.2), проверить
сборку Docker и `next build`, дозаполнить состояния UI.

---

## 3. Backend (`apps/api`)

### 3.1 Пайплайн анализа (ядро)

Оркестратор: `services/daily-report.service.ts → generateDailyReport(options)`.

Шаги:

1. **Выбор провайдера** через `getLlmProvider()` (по `LLM_PROVIDER`).
2. **Тянем диалоги за сегодня** из KeyCRM Admin API: список conversations
   (`filters[channels]`, пагинация — см. `docs/KEYCRM-PAGINATION.md`) и для каждого
   — сообщения за текущий день (таймзона `TIMEZONE`, по умолчанию `Europe/Kiev`).
3. **Нормализация/сжатие** (`compression.service.ts`), правила:
   - пропустить диалог, если в нём `< 3` сообщений;
   - пропустить сообщения-комментарии (`context.is_comment`), с вложениями,
     пустые и «автоматические» (маркеры «автоматичне повідомлення» и т.п.);
   - очистить текст: убрать эмодзи, схлопнуть пробелы;
   - транскрипт в компактном виде: `C[HH:mm]-текст` для входящих (клиент) и
     `E[HH:mm]-текст` для исходящих (сотрудник), всё в одну строку;
   - поля результата: `url` (`https://sunflower.keycrm.app/app/conversations/{id}`),
     `contact` (имя/username), `transcript`, `manager` (из assigned/исходящих).
4. **Нарезка на чанки** (`chunkConversations`, по умолчанию `LLM_CHUNK_COUNT=10`).
5. **Запись прогона** в БД: `AnalysisRun` со статусом `RUNNING`.
6. **Обработка чанков** (`processChunksWith`): параллелизм `LLM_CONCURRENCY`
   (по умолчанию 2), до 3 ретраев на чанк, `provider.complete(system, chunkJSON)`,
   `JSON.parse` ответа (битые ответы дампятся в `data/debug/`).
7. **Сборка** результатов (`combineResponses`): массив `chats[]` + агрегат
   `summary`.
8. **Сохранение**: `saveAnalyses(runId, chats)` → строки `ChatAnalysis`; затем
   `finalizeRun` со статусом `SUCCESS | PARTIAL | FAILED` и счётчиками.
9. **Google Sheets** (опционально, если `SHEETS_ENABLED=true`) — как вторичный
   приёмник, ошибки не валят прогон.

**Триггеры запуска**:
- `POST /api/runs/trigger` (JWT) — ручной запуск из дашборда, fire-and-forget (202).
- Cron — по `REPORT_CRON` (по умолчанию `15 23 * * *`), включается
  `REPORT_CRON_ENABLED=true` (по умолчанию выключен).
- stdin-команда `report` (только в TTY, для локального запуска).

### 3.2 LLM-провайдеры и контракт ответа

Интерфейс `services/llm/types.ts`:

```ts
interface LlmProvider {
  name: "ollama" | "claude" | "openai";
  model: string;
  complete(system: string, user: string): Promise<string>; // ВОЗВРАЩАЕТ JSON-текст
}
```

- **Ollama** — через OpenAI-совместимый эндпоинт `OLLAMA_BASE_URL` (`/v1`),
  `response_format: { type: "json_object" }`, модель `OLLAMA_MODEL`.
- **Claude / OpenAI** — обёртки над существующими сервисами (фолбэк/сравнение).
- Снятие ```` ```json ````-обёртки — утилитой `strip-json-fence`.

**Системный промпт** (`SYSTEM_PROMPT` / для Claude `CLAUDE_SYSTEM_PROMPT`) должен
требовать от модели на вход массив сжатых диалогов, а на выход — **строго JSON**:

```jsonc
{
  "date": "YYYY-MM-DD",
  "chats": [
    {
      "chat_url": "https://sunflower.keycrm.app/app/conversations/123",
      "contact": "Ім'я або username",
      "manager": "Менеджер(и)",
      "category": "тип обращения",          // напр. замовлення/скарга/інформація
      "severity": "low | medium | high",
      "channel": "instagram | telegram | ...",
      "interaction_type": "...",
      "lead_status": "...",
      "conversion_stage": "...",
      "client_tone": "...",
      "churn_risk": "low | medium | high",
      "real_complaint": true,
      "problem_resolved": true,
      "escalation": false,
      "delay_detected": false,
      "delay_minutes": 0,
      "first_response_sec": 120,
      "order_sum": 850,
      "summary": "коротке резюме діалогу",
      "recommended_action": "що зробити менеджеру",
      "issues": ["..."], "positives": ["..."],
      "red_flags": ["..."], "mentioned_products": ["..."],
      "quotes": { "client": "...", "emp": "..." }
    }
  ],
  "summary": { "total_conversations": 0, "total_messages": 0 }
}
```

Колонки в БД (раздел 5) маппятся из этих полей; полный объект кладётся в
`ChatAnalysis.data` (JSON) — ничего не теряем.

> Реальная задача реализации: подобрать модель Ollama (напр. `qwen2.5:7b-instruct`,
> `llama3.1:8b`, `mistral`) и отшлифовать промпт так, чтобы локальная модель
> стабильно отдавала валидный JSON по этой схеме.

### 3.3 База данных (Prisma → Postgres)

Модели (см. `prisma/schema.prisma`):

- **User** — `id, email (unique), passwordHash (bcrypt), name?, role (ADMIN|VIEWER),
  createdAt, updatedAt`. Пользователи дашборда.
- **AnalysisRun** — `id, reportDate (YYYY-MM-DD), status (PENDING|RUNNING|SUCCESS|
  PARTIAL|FAILED), trigger (CRON|MANUAL|API), provider, model?, totalConversations,
  compressedCount, filteredCount, chunkCount, successChunks, failedChunks,
  totalMessages, durationMs?, summary (Json?), error?, startedAt, finishedAt?`.
- **ChatAnalysis** — `id, runId (FK→AnalysisRun, onDelete: Cascade), chatUrl,
  contact?, manager?, category?, severity?, channel?, interactionType?, leadStatus?,
  conversionStage?, clientTone?, churnRisk?, realComplaint?, problemResolved?,
  escalation?, delayDetected?, delayMinutes?, firstResponseSec?, orderSum?, summary?,
  recommendedAction?, data (Json — полный ответ модели), createdAt`.
  Индексы: `runId, category, severity, churnRisk`.

Команды: `prisma migrate dev` (создать миграции), `prisma migrate deploy` (прод),
`prisma db seed` (админ из `ADMIN_EMAIL`/`ADMIN_PASSWORD`).

### 3.4 Аутентификация

- `@fastify/jwt`, плагин `plugins/auth.ts` декорирует `app.authenticate`.
- `POST /api/auth/login` — bcrypt-сверка → JWT (`JWT_EXPIRES_IN`, по умолч. 7d).
- `GET /api/auth/me` — текущий пользователь.
- Группы `runs/analyses/status` закрыты хуком `authenticate`.
- Админ создаётся идемпотентным сидом (на старте контейнера и/или `npm run db:seed`).

### 3.5 REST API

| Метод | Путь                          | Доступ | Назначение                                          |
| ----- | ----------------------------- | ------ | --------------------------------------------------- |
| GET   | `/health`                     | public | Liveness `{status:"ok"}`.                           |
| POST  | `/api/auth/login`             | public | `{email,password}` → `{token, user}`.               |
| GET   | `/api/auth/me`                | JWT    | Текущий пользователь.                               |
| GET   | `/api/status`                 | JWT    | БД, LLM (провайдер/модель/доступность Ollama), cron, последний прогон. |
| GET   | `/api/runs?limit=`            | JWT    | Список прогонов + счётчик анализов.                 |
| GET   | `/api/runs/:id`               | JWT    | Прогон + его анализы.                               |
| POST  | `/api/runs/trigger`           | JWT    | Запустить анализ (202, фоновый).                    |
| GET   | `/api/analyses?runId=&category=&severity=&churnRisk=&limit=` | JWT | Выборка анализов. |

(Legacy-роуты `/api/conversations/*` — ручной прогон и дебаг пайплайна — сохранены.)

### 3.6 Конфигурация (env)

Валидируется в `config/env.ts` (zod). Ключевые: `PORT`, `DATABASE_URL`,
`JWT_SECRET`, `JWT_EXPIRES_IN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `LLM_PROVIDER`,
`LLM_CONCURRENCY`, `LLM_CHUNK_COUNT`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`,
`OLLAMA_MAX_TOKENS`, `ANTHROPIC_*`, `OPENAI_*`, `SYSTEM_PROMPT`,
`CLAUDE_SYSTEM_PROMPT`, `KEYCRM_*`, `GOOGLE_*`, `SHEETS_ENABLED`, `TIMEZONE`,
`REPORT_CRON`, `REPORT_CRON_ENABLED`. Шаблоны: `apps/api/.env.example`, корневой
`.env.example` (для docker-compose).

---

## 4. Frontend (`apps/web`)

Next.js 16 (App Router), клиентский SPA-стиль, JWT в `localStorage`, базовый URL
API из `NEXT_PUBLIC_API_URL`. Клиент: `src/lib/api.ts` (`apiFetch` добавляет
`Authorization`, на 401 — редирект на `/login`).

Экраны:

- **`/login`** — форма email+пароль → `POST /api/auth/login`, сохранить токен,
  перейти на обзор. Показывать ошибку входа.
- **`/` (Обзор)** — guard (нет токена → `/login`). Тянет `GET /api/status` и
  `GET /api/runs?limit=5`. Карточки: БД (вкл/недоступна), LLM (провайдер/модель/
  доступность), Google Sheets, Cron. Кнопка **«Запустити аналіз»** →
  `POST /api/runs/trigger`, через ~1.5с перезагрузить данные. Таблица последних
  прогонов.
- **`/runs`** — список всех прогонов (статус, провайдер/модель, кол-во розмов/
  анализов, ok/err частин, тривалість, початок).
- **`/runs/[id]`** — детали прогона: метрики + таблица анализов (контакт,
  категория, серйозність, ризик відтоку, резюме, ссылка на чат KeyCRM).

Состояния, которые нужно дозакрыть: загрузка (скелетоны/спиннер), ошибки сети,
пустые списки, статус `RUNNING` (можно поллить `/api/runs` пока идёт прогон).

---

## 5. Модель данных (резюме)

`User 1—* (нет связи)` · `AnalysisRun 1—* ChatAnalysis`.
Часто-фильтруемые поля анализа — отдельные колонки (для дашборда и выборок),
полный сырой ответ модели — в `ChatAnalysis.data (Json)`. Прогон агрегирует
счётчики и `summary`. Подробные поля — раздел 3.3.

---

## 6. Деплой

**Прод (всё в Docker):**

```bash
cp .env.example .env                     # POSTGRES_*, порты, NEXT_PUBLIC_API_URL
cp apps/api/.env.example apps/api/.env   # секреты KeyCRM/Google/LLM/JWT/ADMIN
docker compose up -d --build
docker compose exec ollama ollama pull qwen2.5:7b-instruct   # один раз, в volume
```

- API на старте сам делает `prisma migrate deploy` → сид админа → запуск.
- GPU: у сервиса `ollama` блок `deploy.resources.reservations.devices` (nvidia).
  Нужен NVIDIA Container Toolkit на хосте. Для CPU-only — убрать блок, взять
  модель поменьше.

**Локально (инфраструктура в Docker, код на хосте):**

```bash
npm run install:all      # ставит зависимости apps/api и apps/web по отдельности
npm run infra:up         # postgres + ollama в docker
npm run db:migrate
npm run db:seed
npm run dev:api          # :4000
npm run dev:web          # :3000
```

---

## 7. План реализации для Claude Code (по шагам)

Скелет уже в репозитории; задача — довести до рабочего состояния. Рекомендуемый
порядок:

1. **Окружение**: заполнить `apps/api/.env` (KeyCRM, JWT, ADMIN, LLM) и корневой
   `.env`. Поднять `npm run infra:up`.
2. **БД**: `npm run db:migrate` (создать первую миграцию `init`) → `npm run db:seed`
   (админ). Проверить `prisma studio`.
3. **Ollama**: `ollama pull <модель>`; проверить `GET /api/status` (db=true,
   llm.reachable=true).
4. **Промпт + провайдер**: отшлифовать `SYSTEM_PROMPT` под JSON-схему (раздел 3.2),
   прогнать `POST /api/runs/trigger`, убедиться, что чанки парсятся и пишутся в БД.
5. **Auth + дашборд**: войти на `/login`, проверить обзор/прогоны/детали, кнопку
   запуска.
6. **Cron** (по желанию): `REPORT_CRON_ENABLED=true`.
7. **Docker**: `docker compose up --build`, проверить миграции на старте и связь
   web↔api↔db↔ollama.
8. **Полировка UI**: состояния загрузки/ошибок/пустых, поллинг RUNNING.

Чек-лист «готово»: вход работает → кнопка запускает прогон → прогон появляется в
списке (RUNNING→SUCCESS) → в деталях видны анализы чатов → данные в Postgres.

---

## 8. Будущие узлы

Под ту же оболочку (один репо, общий compose, общий дашборд) добавляются новые
приложения: **сайт**, **планирование остатков на заказы**, **банковские выписки**.
Каждый — отдельный модуль/сервис; общие типы при необходимости вынести в
`packages/shared`. Дашборд расширяется новыми разделами поверх того же API-слоя и
аутентификации.

---

## 9. Принятые решения (контекст)

- **Локальные модели** (Ollama+GPU) вместо внешнего API — без оплаты за токены и
  без утечки клиентских диалогов наружу; провайдер сменяемый.
- **Prisma 7** + генератор `prisma-client-js` (стабильный импорт `@prisma/client`).
- **Раздельные `node_modules`** у `apps/api` и `apps/web` (без workspaces) — полная
  изоляция, совпадает со сборкой Docker.
- **Совместимость**: старый пайплайн (KeyCRM→сжатие→Sheets) не сломан, стал
  провайдеро-независимым и пишет в БД дополнительно к Sheets.
- Репозиторий и проект переименованы `sunflower-ai-assistant` → **`sunflower-ai`**.
