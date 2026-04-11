# Відеофіксація доставки та Зміна водія

Документ описує реалізацію двох функцій Telegram-бота для кур'єрів: відеофіксація доставки та керування змінами через SunWays.

---

## Константи та змінні середовища

```ts
// src/services/telegram/config.ts

export const deliveryRegex = /^[Дд]оставка \d+$/;
// Формат підпису: "Доставка 12345" або "доставка 12345"

export const forwardChatId        = process.env.VIDEO_CHAT_ID || "";
export const productDeliveredStatus = process.env.PRODUCT_DELIVERED_STATUS || "23"; // status_id у KeyCRM
export const zReportChatId        = process.env.Z_REPORT_CHAT_ID || "";
export const xReportChatId        = process.env.X_REPORT_CHAT_ID || "";
export const xReportReminderChatId = process.env.X_REPORT_REMINDER_CHAT_ID || "";
export const botToken             = process.env.TELEGRAM_BOT_TOKEN || "";
export const isHoliday            = (process.env.IS_HOLIDAY || "").toLowerCase() === "true";

/** role_id флористів у KeyCRM (для фільтра /my_orders) */
export const FLORIST_ROLE_IDS: readonly number[] = [11, 13, 4];

/** Студії для статусів навантаження */
export const STUDIOS = ["файна", "француз", "севен"];
export const STATUSES = ["зелений", "жовтий", "червоний"];
export const COLOR_MAP: Record<string, string> = {
  зелений: "green",
  жовтий:  "yellow",
  червоний: "red",
};
export const BRANCH_MAP: Record<string, string> = {
  файна:    "faina",
  француз:  "francuz",
  севен:    "seven",
};
```

### Перевірка ролі кур'єра

```ts
// src/services/telegram/config.ts
export function isCourier(username: string): boolean {
  const needle = username.toLowerCase().trim();
  const users = fileHelper.loadUsers() as TelegramUserDatabase;
  for (const data of Object.values(users)) {
    const u = data.username?.toLowerCase().trim();
    if (u === needle && data.isCourier === true) return true;
  }
  return false;
}
// Читає users.json. Кур'єр — запис з полем isCourier: true.
// Env COURIERS не використовується напряму в коді — налаштовується через users.json.
```

---

## 1. Відеофіксація доставки

### Типи

```ts
// src/services/telegram/videoPhoto.service.ts

export type DeliveryValidationResult =
  | { success: true;  order: Order; orderId: string; managerUsername: string }
  | { success: false; userMessage: string };
```

### Точка входу

```ts
// src/handlers/telegram/videoPhoto.handler.ts
bot.on("message:video", async (ctx) => handleVideoMessage(ctx, bot));

export async function handleVideoMessage(
  ctx: Context,
  bot: Bot<Context, Api<RawApi>>,
): Promise<void>
```

### Алгоритм

```ts
// 1. Перевірка підпису відео:
const caption = ctx?.message?.caption || "";
if (caption && deliveryRegex.test(caption.trim())) {
  const orderId = caption.trim().split(" ")[1].trim(); // "Доставка 12345" → "12345"
  // ...
}

// 2. Валідація замовлення та прав:
const validation = await validateDeliveryVideo(orderId, ctx.from.username);
// validateDeliveryVideo:
//   GET order/{orderId}?include=manager,assigned
//   Перевірки:
//   - замовлення існує (404 → success: false)
//   - !isHoliday && !isCourier(username) → success: false
//   - !isHoliday && order.assigned.length === 0 → success: false

// 3. Паралельно: переслати відео та змінити статус:
const [forwardResult, statusResult] = await Promise.allSettled([
  bot.api.forwardMessage(forwardChatId, ctx.chat.id, ctx.message.message_id),
  changeOrderStatus(orderId, productDeliveredStatus),
  // changeOrderStatus → PUT order/{id}  { status_id: Number(productDeliveredStatus) }
]);

// 4. Повідомлення кур'єру та менеджеру (buildDeliveryMessages):
const { messageForCourier, messageForManager } = buildDeliveryMessages(orderId, forwardOk, statusOk);
await ctx.reply(messageForCourier);
await sendTelegramMessage(managerChatId, messageForManager);
// якщо managerChatId не знайдено → sendTelegramMessageToMainAccount(messageForManager)
```

### Функції з `videoPhoto.service.ts`

```ts
export async function validateDeliveryVideo(
  orderId: string,
  username: string,
): Promise<DeliveryValidationResult>
// GET keycrmApiClient `order/${+orderId}?include=manager,assigned`

export function buildDeliveryMessages(
  orderId: string,
  forwardOk: boolean,
  statusOk: boolean,
): { messageForCourier: string; messageForManager: string }
// forwardOk=false → "Сталася якась помилка при пересилці відео у групу. Спробуйте це зробити власноруч."
// statusOk=false  → "Кур'єр доставив замовлення №N, однак воно не було переведено по статусу далі."
```

### Повідомлення про помилки

| Ситуація                        | Текст відповіді бота                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| Невірний формат підпису         | `Суворий формат тексту: Доставка 0000, де 0000 це номер замовлення`                   |
| Замовлення не знайдено (404)    | `Такого замовлення не існує, перевірте будь ласка номер замовлення та спробуйте ще раз.` |
| Не кур'єр (`isCourier` = false) | `Вибачте, цей функціонал доступний тільки кур'єрам.`                                 |
| Нема відповідальних             | `На це замовлення спершу треба призначити відповідальних.`                            |
| Помилка пересилки               | `Сталася якась помилка при пересилці відео у групу. Спробуйте це зробити власноруч.` |

**Примітка:** якщо `IS_HOLIDAY=true` — перевірки кур'єра та відповідальних пропускаються (`isHoliday = true`).

---

## 2. Зміна водія (SunWays)

### Типи

```ts
// src/services/sunways.service.ts

type SunwaysVehicle = {
  id: string;    // UUID авто
  label: string; // "KA6370PX (Fiat Doblo)" — plate + brand + model
};

type ShiftFlowType = "start" | "finish";

type ShiftSession = {
  type: ShiftFlowType;
  vehicleId?: string;
  vehicleLabel?: string;
  odometerStart?: number;
  odometerEnd?: number;
  lat?: number;
  lng?: number;
  createdAt: number;       // Date.now() — для перевірки TTL
};

type SunwaysApiSuccess = {
  success: boolean;
  data?: {
    shiftId?: string;
    courierId?: string;
    courierName?: string;
    telegramUsername?: string;
    endedAt?: string;       // ISO-рядок, наприклад "2026-03-24T18:00:00.000Z"
  };
  message?: string;
};

type SunwaysAutoCloseResponse = {
  success: boolean;
  processedDateKyiv: string;
  autoClosed: number;
  skippedAlreadyClosed: number;
};
```

### Константи

```ts
// src/handlers/telegram/sunwaysShift.handler.ts
const SHIFT_SESSION_TTL_MS = 10 * 60 * 1000; // 10 хвилин

// callback_data для inline-кнопок:
const SHIFT_PREFIX_START          = "shift:start";
const SHIFT_PREFIX_FINISH         = "shift:finish";
const SHIFT_PREFIX_VEHICLE        = "shift:vehicle:";   // + vehicleId
const SHIFT_PREFIX_CONFIRM_START  = "shift:confirm:start";
const SHIFT_PREFIX_CONFIRM_FINISH = "shift:confirm:finish";
const SHIFT_PREFIX_CANCEL_TODAY   = "shift:cancel-today";
const SHIFT_PREFIX_CANCEL         = "shift:cancel";

// Стан сесій (in-memory):
const shiftSessions = new Map<number, ShiftSession>(); // ключ — Telegram userId
```

### Env SunWays

```ts
// src/services/sunways.service.ts
const SUNWAYS_API_BASE_URL =
  process.env.SUNWAYS_API_BASE_URL ||
  "https://sun-ways.vercel.app/api/public/shifts/by-telegram";
const SUNWAYS_VEHICLES_API_URL =
  process.env.SUNWAYS_VEHICLES_API_URL ||
  "https://sun-ways.vercel.app/api/public/vehicles";
const SUNWAYS_API_KEY = process.env.PUBLIC_SHIFT_API_KEY || "";
const SUNWAYS_AUTO_CLOSE_SHIFTS_URL =
  process.env.SUNWAYS_AUTO_CLOSE_SHIFTS_URL ||
  "https://sun-ways.vercel.app/api/cron/auto-close-shifts";
const SUNWAYS_CRON_SECRET = process.env.SUNWAYS_CRON_SECRET || SUNWAYS_API_KEY;
// Усі запити: header "x-api-key": SUNWAYS_API_KEY, timeout: 30000
```

### Функції сервісу

```ts
// Нормалізація username: "@AndriyAsh" → "@andriyash"
function normalizeTelegramUsername(username: string): string {
  return `@${username.trim().replace(/^@+/, "").toLowerCase()}`;
}

export async function getSunwaysVehicles(): Promise<
  { ok: true; data: SunwaysVehicle[] } | { ok: false; message: string }
>
// GET SUNWAYS_VEHICLES_API_URL?activeOnly=1
// label = "${plate_number} (${brand} ${model})" або fallback

export async function startSunwaysShift(payload: {
  telegramUsername: string;
  vehicleId: string;
  odometerStart: number;
  lat: number;
  lng: number;
}): Promise<{ ok: true; endedAt?: string } | { ok: false; message: string }>
// POST SUNWAYS_API_BASE_URL — тіло: { telegramUsername (нормалізований), vehicleId, odometerStart, lat, lng }
// endedAt — з data.data.endedAt відповіді

export async function finishSunwaysShift(
  telegramUsername: string,
  odometerEnd: number,
): Promise<{ ok: true; endedAt?: string } | { ok: false; message: string }>
// PATCH SUNWAYS_API_BASE_URL — тіло: { telegramUsername, endTime (ISO Kyiv), odometerEnd }
// endTime = dayjs().tz("Europe/Kyiv").format("YYYY-MM-DDTHH:mm:ssZ")

export async function cancelSunwaysShift(
  telegramUsername: string,
): Promise<{ ok: true } | { ok: false; message: string }>
// DELETE SUNWAYS_API_BASE_URL — тіло: { telegramUsername }

export async function triggerSunwaysAutoCloseShifts(): Promise<SunwaysAutoCloseResponse>
// POST SUNWAYS_AUTO_CLOSE_SHIFTS_URL  Authorization: Bearer SUNWAYS_CRON_SECRET
// Викликається щодня о 02:00 Kyiv через cron-контролер
```

### Обробка помилок SunWays (`mapSunwaysError`)

```ts
// status 404, message contains "active shift" → "Активну зміну не знайдено."
// status 404, інше                           → "Кур'єра не знайдено за telegram username."
// status 409, message contains "vehicle"+"busy" → "Авто зайняте іншою активною зміною."
// status 409, message contains "shift"+"already" → "Зміну вже розпочато."
// status 401                                 → "Помилка авторизації Sunways API."
// status 400                                 → data.message || "Некоректні дані для Sunways API."
```

### Тригер

```ts
// src/handlers/telegram/sunwaysShift.handler.ts
bot.hears(/^зміна\s+водія$/i, async (ctx) => { ... });
// Реєстрація: registerSunwaysShiftHandlers(bot)
```

### Крок-за-кроком: старт зміни

```
1. Текст "зміна водія" (regex /^зміна\s+водія$/i)
   → перевірка isCourier() + getSunwaysConfigError()
   → shiftSessions.set(userId, { type: "start", createdAt })
   → reply: inline-keyboard [Почати зміну | Завершити зміну | Скасувати сьогоднішню зміну]

2. callback "shift:start"
   → getSunwaysVehicles()
   → reply: inline-keyboard з кнопками авто (callback: "shift:vehicle:{uuid}")

3. callback "shift:vehicle:{uuid}"
   → session.vehicleId = uuid, session.vehicleLabel = label
   → reply: "Вкажіть стартовий пробіг (лише число, км)"

4. text (число)
   → session.odometerStart = value
   → reply: keyboard з кнопкою геолокації (request_location)

5. message:location
   → session.lat, session.lng
   → reply: зведення + inline "Почати зміну" / "Скасувати"

6. callback "shift:confirm:start"
   → startSunwaysShift({ telegramUsername, vehicleId, odometerStart, lat, lng })
   → reply: "Зміну розпочато успішно. Планове завершення: DD.MM.YYYY, HH:MM"
```

### Крок-за-кроком: завершення зміни

```
1. callback "shift:finish"
   → session.type = "finish"
   → reply: "Вкажіть фінальний пробіг (лише число, км)"

2. text (число)
   → session.odometerEnd = value
   → reply: inline "Завершити зміну" / "Скасувати"

3. callback "shift:confirm:finish"
   → finishSunwaysShift(username, odometerEnd)
   → reply: "Зміну завершено."
```

### Скасування

```
callback "shift:cancel-today"
  → cancelSunwaysShift(username)  → DELETE SUNWAYS_API_BASE_URL
  → reply: "Сьогоднішю зміну скасовано."
```

---

## 3. Нагадування про X-звіт

```ts
// src/controllers/xReportReminder.controller.ts
// Крон: 12:00, 16:00, 20:00 за Kyiv
// Надсилає у X_REPORT_REMINDER_CHAT_ID:
"Нагадування - час відправити X-звіт через бота."
```

---

## Змінні середовища (повний список)

| Змінна                         | Де використовується                | За замовчуванням                                             |
| ------------------------------ | ---------------------------------- | ------------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN`           | ініціалізація grammy Bot           | —                                                            |
| `VIDEO_CHAT_ID`                | `forwardChatId`                    | —                                                            |
| `PRODUCT_DELIVERED_STATUS`     | `productDeliveredStatus`           | `"23"`                                                       |
| `IS_HOLIDAY`                   | `isHoliday`                        | `"false"`                                                    |
| `Z_REPORT_CHAT_ID`             | `zReportChatId`                    | —                                                            |
| `X_REPORT_CHAT_ID`             | `xReportChatId`                    | —                                                            |
| `X_REPORT_REMINDER_CHAT_ID`    | `xReportReminderChatId`            | —                                                            |
| `PUBLIC_SHIFT_API_KEY`         | `SUNWAYS_API_KEY`                  | —                                                            |
| `SUNWAYS_API_BASE_URL`         | URL змін SunWays                   | `https://sun-ways.vercel.app/api/public/shifts/by-telegram`  |
| `SUNWAYS_VEHICLES_API_URL`     | URL авто SunWays                   | `https://sun-ways.vercel.app/api/public/vehicles`            |
| `SUNWAYS_AUTO_CLOSE_SHIFTS_URL`| URL крону автозакриття             | `https://sun-ways.vercel.app/api/cron/auto-close-shifts`     |
| `SUNWAYS_CRON_SECRET`          | Bearer для cron auto-close         | = `PUBLIC_SHIFT_API_KEY` якщо не задано                      |
