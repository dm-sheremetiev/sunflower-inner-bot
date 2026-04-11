# `poster.service.ts` — формування incoming order у Poster

Документ описує `src/services/poster.service.ts`: створення онлайн-замовлення у Poster та запис номера чеку назад у KeyCRM.

---

## 1. Точка входу

```ts
export const createPosterOrdersAndStoreReceipts = async (
  order: Order,            // src/types/keycrm.ts
  reply: FastifyReply,     // fastify
  branchTags: string[],    // ["Файна", "Севен", "Француз", "Республіка"] — передається з keycrm.service.ts
): Promise<string | null>
// Повертає: рядок чеків ("12345" або "Філія1: 12345, Філія2: 67890") або null.
```

Виклик з `keycrm.service.ts`:

```ts
import { createPosterOrdersAndStoreReceipts } from "./poster.service.js";

const BRANCH_TAGS = ["Файна", "Севен", "Француз", "Республіка"];

await createPosterOrdersAndStoreReceipts(order, reply, BRANCH_TAGS);
```

---

## 2. Константи та UUID

```ts
// src/services/poster.service.ts

// UUID кастомних полів замовлення KeyCRM:
const POSTER_RECEIPT_FIELD_UUID = "OR_1018"; // куди записується номер чеку Poster
const DELIVERY_TIME_FIELD_UUID  = "OR_1006"; // часовий проміжок доставки

// UUID кастомних полів товарів каталогу KeyCRM (для маппінгу рядків у Poster):
const POSTER_INCOMING_PARENT_PRODUCT_FIELD_UUID    = "CT_1022"; // product_id у Poster
const POSTER_INCOMING_MODIFICATOR_FIELD_UUID       = "CT_1025"; // modificator_id у Poster
const POSTER_INCOMING_DISH_MODIFICATION_FIELD_UUID = "CT_1026"; // dish_modification_id (техкарта)

// Телефон-заглушка, якщо у покупця немає валідного номеру:
const DEFAULT_POSTER_PHONE = "+380989000000";

// Тимчасовий виняток: для філіала "Француз" — брати звичайний spot замість інтернет-магазину.
// Щоб прибрати — видалити константу і блок у getPosterOnlineShopSpotsByBranches.
const TEMP_BRANCHES_FORCE_REGULAR_SPOT = ["француз"];
```

---

## 3. Типи

```ts
// Локальні типи в poster.service.ts:

type PosterSpot = {
  spot_id: number;
  name: string;
  spot_delete: number; // 0 = активна, !0 = видалена
};

type PosterIncomingOrderProduct = {
  product_id: number;       // тільки з CT_1022
  count: number;
  modificator_id?: number;  // з CT_1025, якщо CT_1025 !== product_id
  modification?: string;    // JSON-рядок [{"m": dish_modification_id, "a": qty}] — з CT_1026
  comment?: string;
};

type KeycrmProductDetails = {
  id: number;
  parent_id?: number | null;
  custom_fields?: KeycrmCustomField[];
};

type KeycrmCustomField = {
  id?: number;
  uuid?: string;
  name?: string;
  value?: unknown;
};

type PosterCreateIncomingOrderResponse = {
  response?: {
    transaction_id?: number;
  };
};

type PosterReceiptRecord = {
  branchName: string;
  transactionId: number;
};

// OrderProductWithMeta — розширення Order["products"][number] для полів, що додаються через include:
type OrderProductWithMeta = OrderProduct & {
  id?: number;
  custom_fields?: KeycrmCustomField[];
  modificator_id?: number | string;
  offer: OrderProduct["offer"] & {
    product?: { custom_fields?: KeycrmCustomField[] };
  };
};
```

---

## 4. API-клієнти

```ts
// src/api/posterApiClient.ts
export const posterApiClient = axios.create({
  baseURL: process.env.POSTER_API_URL || "https://joinposter.com/api",
  params: { token: process.env.POSTER_API_TOKEN }, // токен у кожному запиті як query-param
});

// src/api/keycrmApiClient.ts
export const keycrmApiClient = axios.create({
  baseURL: process.env.KEYCRM_API_URL,            // https://openapi.keycrm.app/v1
  headers: { Authorization: `Bearer ${process.env.KEYCRM_API_KEY}` },
});
```

---

## 5. Верхньорівневий пайплайн

```ts
// createPosterOrdersAndStoreReceipts — строгий порядок кроків:

// 1. Визначити філіали з тегів замовлення:
const branches = extractOrderBranches(order, branchTags);
// order.tags[].name.toLowerCase().includes(branch.toLowerCase())
if (!branches.length) return null;

// 2. Завантажити точки Poster:
const spots = await fetchPosterSpots();
// GET /spots.getSpots → { response: PosterSpot[] }

// 3. Зіставити філіали з online-shop spots:
const branchSpots = getPosterOnlineShopSpotsByBranches(spots, branches);
if (!branchSpots.length) { reply.log.error(...); return null; }

// 4. Нормалізувати контакти:
const phone = normalizePosterPhone(order.buyer?.phone);
const deliveryTime = getPosterDeliveryTime(order); // "YYYY-MM-DD HH:mm:ss" Kyiv

// 5. Змапити товари:
const products = await mapOrderProductsToPosterProducts(order, reply);
if (!products.length) { reply.log.error(...); return null; }

// 6. Для кожного matched spot → POST /incomingOrders.createIncomingOrder:
for (const { branchName, spot } of branchSpots) {
  const payload = { spot_id: spot.spot_id, first_name, phone, comment, delivery_time, skip_phone_validation: true, products };
  const { data } = await posterApiClient.post<PosterCreateIncomingOrderResponse>(
    "/incomingOrders.createIncomingOrder", payload,
  );
  const transactionId = extractPosterTransactionId(data); // data.response.transaction_id
  if (transactionId) receipts.push({ branchName, transactionId });
}

// 7. Записати чек у KeyCRM (OR_1018):
await updatePosterReceiptInCrm(orderId, formatPosterReceiptsText(receipts));
// GET order/{id}?include=custom_fields → знайти OR_1018 → PUT order/{id} { custom_fields: [...] }
```

---

## 6. Фільтрація та матчинг точок

```ts
function normalizeSpotName(value: string): string {
  return value.toLowerCase().replace(/[—–-]/g, "-").replace(/\s+/g, " ").trim();
}

function isOnlineShopSpotName(name: string): boolean {
  const n = normalizeSpotName(name);
  return (
    n.includes("інтернет-магазин") || n.includes("інтернет магазин") ||
    n.includes("интернет-магазин") || n.includes("интернет магазин")
  );
}

// Умови відбору spot:
//   spot.spot_delete === 0
//   && normalizeSpotName(spot.name).includes(normalizeSpotName(branchName))
//   && isOnlineShopSpotName(spot.name)

// Виняток: TEMP_BRANCHES_FORCE_REGULAR_SPOT = ["француз"]
// Для "Француз" обирається звичайний spot (НЕ інтернет-магазин):
//   spot.spot_delete === 0 && name.includes("француз") && !isOnlineShopSpotName(name)

// Fallback: якщо online-shop spot повертає помилку → getPosterRegularSpotByBranch:
const fallbackSpot = getPosterRegularSpotByBranch(spots, branchName, spot.spot_id);
// spot.spot_delete === 0 && spot_id !== excludeSpotId && name.includes(branch) && !isOnlineShopSpotName
```

---

## 7. Нормалізація телефону та часу

```ts
function normalizePosterPhone(value: string | null | undefined): string {
  if (!value) return DEFAULT_POSTER_PHONE; // "+380989000000"
  const cleaned = value.replace(/[^\d+]/g, "").trim();
  if (!cleaned) return DEFAULT_POSTER_PHONE;
  if (cleaned.startsWith("+"))   return cleaned;
  if (cleaned.startsWith("380")) return `+${cleaned}`;
  if (cleaned.startsWith("0"))   return `+38${cleaned}`;
  return `+${cleaned}`;
}

function getDeliveryTimeRangeStart(order: Order): string | null {
  // Шукає поле OR_1006 або поле, де name.includes("часовий проміжок")
  // Парсить початок діапазону: /^(\d{1,2}:\d{2})\s*-/
  // Повертає "HH:mm:00" або null
}

function getPosterDeliveryTime(order: Order): string {
  // date = order.shipping.shipping_date_actual (tz Kyiv) або dayjs().tz("Europe/Kyiv")
  // time = getDeliveryTimeRangeStart(order) ?? поточний час
  // → "YYYY-MM-DD HH:mm:ss"
}
```

---

## 8. Маппінг товарів — `mapOrderProductsToPosterProducts`

### 8.1. Завантаження каталожних деталей

```ts
// Для кожного рядка замовлення:
const catalogId = offer.product_id ?? product.id; // offer.product_id — пріоритет
// GET products/{catalogId}?include=custom_fields

// Додатково — один рівень батька:
// для завантажених карток з parent_id → GET products/{parent_id}?include=custom_fields
```

### 8.2. Джерела ID — пошук у такому порядку для кожного UUID

```ts
function getIncomingFieldRawValue(product, catalogDetails, uuid): unknown {
  return (
    getCustomFieldValueByUuid(product.custom_fields, uuid) ??         // 1. поля рядка замовлення
    getCustomFieldValueByUuid(product.offer?.product?.custom_fields, uuid) ?? // 2. поля офера
    getCustomFieldValueByUuid(catalogDetails?.custom_fields, uuid)    // 3. поля каталожної картки
  );
}

// Три ID для кожного рядка:
const incomingParentProductId  = parseFieldIds(getIncomingFieldRawValue(..., "CT_1022"))[0];
const incomingModificatorId    = parseFieldIds(getIncomingFieldRawValue(..., "CT_1025"))[0];
const incomingDishModificationIds = parseFieldIds(getIncomingFieldRawValue(..., "CT_1026"));
// parseFieldIds: String(value).split(/[,;|\s]+/) → number[]
```

### 8.3. Побудова payload-рядка

```ts
const productId = incomingParentProductId; // обов'язково; без нього рядок відкидається

// Взаємовиключно:
if (incomingModificatorId && incomingModificatorId !== productId) {
  // → modificator_id (CT_1025)
} else if (incomingDishModificationIds.length) {
  // → modification: JSON.stringify( sorted [{m: id, a: qty}] )
  //   id сортуються за зростанням; qty = max(1, trunc(count))
} else {
  // → простий товар: тільки product_id + count
}
// Захист: якщо modificator_id === product_id → modificator_id = undefined
```

### 8.4. Фільтрація невалідних рядків

```
- count нечисловий або <= 0  → null
- немає product_id (CT_1022) → null
- після маппінгу масив порожній → error-лог з productsPreview
```

---

## 9. Payload до Poster API

```ts
// POST /incomingOrders.createIncomingOrder
{
  spot_id: number,
  first_name: string,          // buyer.full_name || order_id-fallback
  email?: string,              // buyer.email, якщо є
  phone: string,               // нормалізований
  comment: string,             // "СРМ №{orderId}" (manager/client коментарі вимкнені)
  delivery_time: string,       // "YYYY-MM-DD HH:mm:ss"
  skip_phone_validation: true,
  products: PosterIncomingOrderProduct[],
  // address — НЕ відправляється (закоментовано)
}
// Відповідь: { response: { transaction_id: number } }
```

---

## 10. Запис чеку у KeyCRM

```ts
async function updatePosterReceiptInCrm(orderId: number, receiptValue: string): Promise<void>
// 1. GET order/{orderId}?include=custom_fields
// 2. Знайти поле OR_1018 → взяти його id (якщо є)
// 3. PUT order/{orderId} { custom_fields: [{ id: field.id, value }] або [{ uuid: "OR_1018", value }] }
// Завжди повне перезаписування (без злиття з попереднім значенням)

function formatPosterReceiptsText(receipts: PosterReceiptRecord[]): string {
  if (receipts.length === 1) return String(receipts[0].transactionId); // "12345"
  return receipts.map((r) => `${r.branchName}: ${r.transactionId}`).join(", ");
  // "Файна: 12345, Севен: 67890"
}
```

---

## 11. Fallback при помилці Poster

```ts
try {
  // POST /incomingOrders.createIncomingOrder (online-shop spot)
} catch (error) {
  // Якщо в тілі помилки є transaction_id — використовуємо його (warn-лог)
  // Інакше → спробувати fallback-spot (звичайний spot того ж філіалу):
  const fallbackSpot = getPosterRegularSpotByBranch(spots, branchName, spot.spot_id);
  // POST /incomingOrders.createIncomingOrder (fallback spot)
  // Якщо і fallback повернув помилку з transaction_id → warn-лог і використати
}
```

---

## 12. Логування

| Подія                                     | Рівень  | Повідомлення                                                   |
| ----------------------------------------- | ------- | -------------------------------------------------------------- |
| Нема matched online-shop spots            | error   | `Poster sync failed: no matching online shop spots`            |
| Нема змапованих товарів                   | error   | `Poster sync failed: no products mapped for Poster payload`    |
| Невалідний transaction_id у відповіді     | error   | `Poster sync failed: invalid transaction_id`                   |
| HTTP-помилка у POST до Poster             | error   | `Poster sync failed while creating incoming order`             |
| transaction_id знайдено в тілі помилки    | warn    | `Poster returned error but transaction_id was extracted...`    |
| Fallback spot спрацював                   | warn    | `Poster fallback succeeded: order sent to regular branch spot` |
| Помилка при записі чеку в KeyCRM          | error   | `Poster sync failed while saving receipt to CRM`               |

`summarizeAxiosErrorForLog(error)` витягує з Axios-помилки: `status`, `statusText`, `responseData`, `responseHeaders`, `url`, `method`, `baseURL`, `requestData`.
