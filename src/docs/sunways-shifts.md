# SunWays Public API — shifts and vehicles

Документ описує зовнішній API SunWays та внутрішній сервіс `src/services/sunways.service.ts`.

---

## Типи (`src/services/sunways.service.ts`)

```ts
type SunwaysVehicle = {
  id: string;    // UUID авто
  label: string; // "KA6370PX (Fiat Doblo)" — формується з plate_number + brand + model
};

type SunwaysVehicleApiItem = {
  id: string;
  plate_number?: string | null;
  brand?: string | null;
  model?: string | null;
  is_active?: boolean;
};

type SunwaysApiSuccess = {
  success: boolean;
  data?: {
    shiftId?: string;
    courierId?: string;
    courierName?: string;
    telegramUsername?: string;
    endedAt?: string;   // ISO UTC, наприклад "2026-03-24T18:00:00.000Z"
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

---

## Env та базові URL

```ts
const SUNWAYS_API_BASE_URL =
  process.env.SUNWAYS_API_BASE_URL ||
  "https://sun-ways.vercel.app/api/public/shifts/by-telegram";

const SUNWAYS_VEHICLES_API_URL =
  process.env.SUNWAYS_VEHICLES_API_URL ||
  "https://sun-ways.vercel.app/api/public/vehicles";

const SUNWAYS_AUTO_CLOSE_SHIFTS_URL =
  process.env.SUNWAYS_AUTO_CLOSE_SHIFTS_URL ||
  "https://sun-ways.vercel.app/api/cron/auto-close-shifts";

const SUNWAYS_API_KEY    = process.env.PUBLIC_SHIFT_API_KEY || "";
const SUNWAYS_CRON_SECRET = process.env.SUNWAYS_CRON_SECRET || SUNWAYS_API_KEY;
// Усі запити: header "x-api-key": SUNWAYS_API_KEY, timeout: 30000 мс
```

Перевірка наявності конфігурації:

```ts
export function getSunwaysConfigError(): string | null {
  if (!SUNWAYS_API_KEY)          return "Не налаштовано інтеграцію Sunways: відсутній PUBLIC_SHIFT_API_KEY.";
  if (!SUNWAYS_API_BASE_URL)     return "Не налаштовано інтеграцію Sunways: відсутній SUNWAYS_API_BASE_URL.";
  if (!SUNWAYS_VEHICLES_API_URL) return "Не налаштовано інтеграцію Sunways: відсутній SUNWAYS_VEHICLES_API_URL.";
  return null;
}
// Викликається до показу меню зміни водія.
```

---

## Нормалізація username

```ts
function normalizeTelegramUsername(username: string): string {
  return `@${username.trim().replace(/^@+/, "").toLowerCase()}`;
}
// "@AndriyAsh" → "@andriyash"
// "andriyash"  → "@andriyash"
```

---

## 1. Отримання списку авто

```ts
export async function getSunwaysVehicles(): Promise<
  { ok: true; data: SunwaysVehicle[] } | { ok: false; message: string }
>
```

```ts
// GET SUNWAYS_VEHICLES_API_URL?activeOnly=1
const res = await axios.get<{ success: boolean; data?: SunwaysVehicleApiItem[] }>(
  SUNWAYS_VEHICLES_API_URL,
  {
    params: { activeOnly: 1 },
    headers: { "x-api-key": SUNWAYS_API_KEY, Accept: "application/json" },
    timeout: 30000,
  },
);
// Фільтр: тільки записи з непорожнім id (string).
// label = toVehicleLabel(item):
//   "${plate_number} (${brand} ${model})" | "${plate_number}" | "${brand} ${model}" | "Авто"
```

**Тіло відповіді API:**

```json
{
  "success": true,
  "data": [
    {
      "id": "f9f43c4e-8a61-4b0f-b5d0-9d5f2f0c9c93",
      "plate_number": "KA6370PX",
      "brand": "Fiat",
      "model": "Doblo",
      "type": "own",
      "is_active": true,
      "rent_until": null
    }
  ]
}
```

---

## 2. Старт зміни

```ts
export async function startSunwaysShift(payload: {
  telegramUsername: string;
  vehicleId: string;
  odometerStart: number;
  lat: number;
  lng: number;
}): Promise<{ ok: true; endedAt?: string } | { ok: false; message: string }>
```

```ts
// POST SUNWAYS_API_BASE_URL
await axios.post<SunwaysApiSuccess>(
  SUNWAYS_API_BASE_URL,
  {
    telegramUsername: normalizeTelegramUsername(payload.telegramUsername),
    vehicleId: payload.vehicleId,
    odometerStart: payload.odometerStart,
    lat: payload.lat,
    lng: payload.lng,
  },
  {
    headers: { "x-api-key": SUNWAYS_API_KEY, "Content-Type": "application/json" },
    timeout: 30000,
  },
);
// endedAt береться з res.data.data.endedAt
// endTime НЕ передається — сервер виставляє 21:00 за замовчуванням
```

**Тіло запиту:**

```json
{
  "telegramUsername": "@andriyash",
  "vehicleId": "f9f43c4e-8a61-4b0f-b5d0-9d5f2f0c9c93",
  "odometerStart": 125430,
  "lat": 50.4501,
  "lng": 30.5234
}
```

**Успішна відповідь (`200`):**

```json
{
  "success": true,
  "data": {
    "shiftId": "uuid",
    "courierId": "uuid",
    "courierName": "Courier Name",
    "telegramUsername": "andriyash",
    "endedAt": "2026-03-24T18:00:00.000Z"
  }
}
```

---

## 3. Завершення зміни

```ts
export async function finishSunwaysShift(
  telegramUsername: string,
  odometerEnd: number,
): Promise<{ ok: true; endedAt?: string } | { ok: false; message: string }>
```

```ts
// PATCH SUNWAYS_API_BASE_URL
await axios.patch<SunwaysApiSuccess>(
  SUNWAYS_API_BASE_URL,
  {
    telegramUsername: normalizeTelegramUsername(telegramUsername),
    endTime: getCurrentKyivIsoString(), // dayjs().tz("Europe/Kyiv").format("YYYY-MM-DDTHH:mm:ssZ")
    odometerEnd,
  },
  {
    headers: { "x-api-key": SUNWAYS_API_KEY, "Content-Type": "application/json" },
    timeout: 30000,
  },
);
```

**Тіло запиту:**

```json
{
  "telegramUsername": "@andriyash",
  "endTime": "2026-03-24T20:30:00+02:00",
  "odometerEnd": 125480
}
```

---

## 4. Скасування зміни

```ts
export async function cancelSunwaysShift(
  telegramUsername: string,
): Promise<{ ok: true } | { ok: false; message: string }>
```

```ts
// DELETE SUNWAYS_API_BASE_URL
await axios.delete(SUNWAYS_API_BASE_URL, {
  data: { telegramUsername: normalizeTelegramUsername(telegramUsername) },
  headers: { "x-api-key": SUNWAYS_API_KEY, "Content-Type": "application/json" },
  timeout: 30000,
});
```

---

## 5. Автозакриття змін (cron)

```ts
export async function triggerSunwaysAutoCloseShifts(): Promise<SunwaysAutoCloseResponse>
```

```ts
// POST SUNWAYS_AUTO_CLOSE_SHIFTS_URL
await axios.post<SunwaysAutoCloseResponse>(
  SUNWAYS_AUTO_CLOSE_SHIFTS_URL,
  {},
  {
    headers: {
      Authorization: `Bearer ${SUNWAYS_CRON_SECRET}`, // Bearer, не x-api-key
      "Content-Type": "application/json",
    },
    timeout: 30000,
  },
);
// Повертає: { success, processedDateKyiv, autoClosed, skippedAlreadyClosed }
// Викликається щодня о 02:00 Kyiv
```

---

## Обробка помилок — `mapSunwaysError`

```ts
// HTTP 404, message.includes("active shift") → "Активну зміну не знайдено."
// HTTP 404, інше                             → "Кур'єра не знайдено за telegram username."
// HTTP 409, message includes "vehicle"+"busy" → "Авто зайняте іншою активною зміною."
// HTTP 409, message includes "shift"+"already"/"started" → "Зміну вже розпочато."
// HTTP 401                                   → "Помилка авторизації Sunways API."
// HTTP 400                                   → data.message || "Некоректні дані для Sunways API."
// Інша помилка                               → error.message || String(error)
```

---

## cURL-приклади

### Старт зміни

```bash
curl -X POST "https://sun-ways.vercel.app/api/public/shifts/by-telegram" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <SECRET>" \
  -d '{
    "telegramUsername": "@andriyash",
    "vehicleId": "f9f43c4e-8a61-4b0f-b5d0-9d5f2f0c9c93",
    "odometerStart": 125430,
    "lat": 50.4501,
    "lng": 30.5234
  }'
```

### Завершення зміни

```bash
curl -X PATCH "https://sun-ways.vercel.app/api/public/shifts/by-telegram" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <SECRET>" \
  -d '{
    "telegramUsername": "@andriyash",
    "endTime": "2026-03-24T20:30:00+02:00",
    "odometerEnd": 125480
  }'
```

### Скасування зміни

```bash
curl -X DELETE "https://sun-ways.vercel.app/api/public/shifts/by-telegram" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <SECRET>" \
  -d '{ "telegramUsername": "@andriyash" }'
```

### Список активних авто

```bash
curl -X GET "https://sun-ways.vercel.app/api/public/vehicles?activeOnly=1" \
  -H "x-api-key: <SECRET>"
```

### Автозакриття змін (cron)

```bash
curl -X POST "https://sun-ways.vercel.app/api/cron/auto-close-shifts" \
  -H "Authorization: Bearer <CRON_SECRET>" \
  -H "Content-Type: application/json"
```
