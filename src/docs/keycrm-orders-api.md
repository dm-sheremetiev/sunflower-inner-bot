# Отримання замовлень з KeyCRM API

## Клієнт та авторизація

```ts
// src/api/keycrmApiClient.ts
export const keycrmApiClient = axios.create({
  baseURL: process.env.KEYCRM_API_URL,   // https://openapi.keycrm.app/v1
  headers: {
    Authorization: `Bearer ${process.env.KEYCRM_API_KEY}`,
    Accept: "application/json",
  },
});

// Admin-клієнт (окремий URL, логін/пароль або токен):
export const keycrmAdminApiClient = axios.create({
  baseURL: process.env.KEYCRM_ADMIN_API_URL,
});
// Автоматично вставляє Bearer-токен та оновлює його при 401 через interceptor.
// Логін: POST /auth/login  { username, password } → { access_token }
```

---

## Типи (`src/types/keycrm.ts`)

```ts
export interface Order {
  id: number;
  parent_id: number;
  source_uuid: string;
  source_id: number;
  status_id: number;
  status_group_id: number;
  grand_total: number;
  promocode: string;
  total_discount: number;
  discount_amount?: number;
  discount_percent?: number;
  expenses_sum: number;
  shipping_price: number;
  wrap_price: number;
  taxes: number;
  manager_comment: string | null;
  buyer_comment: string;
  gift_message: string;
  is_gift: boolean;
  payment_status: string;
  last_synced_at: string;
  created_at: string;
  ordered_at: string;
  updated_at: string;
  closed_at: string;
  // include-залежні поля:
  buyer: Buyer;
  products: Product[];
  manager: Manager;
  tags: Tag[];
  status: Status;
  marketing: Marketing;
  payments: Payment[];
  shipping: Shipping;
  expenses: Expense[];
  custom_fields: CustomField[];
  assigned?: Assigned[];
}

export interface Buyer {
  id: number;
  full_name: string;
  email: string;
  phone: string;
  company_id: number;
  manager_id: number;
}

export interface Product {               // рядок замовлення
  name: string;
  sku: string;
  price: number;
  price_sold: number;
  purchased_price: number;
  discount_percent: number;
  discount_amount: number;
  total_discount: number;
  quantity: number;
  unit_type: string;
  upsale: boolean;
  comment: string;
  product_status_id: number;
  picture: string;
  properties: Property[];
  shipment_type: string;
  warehouse: Warehouse;
  offer: Offer;
}

export interface Offer {
  id: number;
  product_id: number;
  sku: string;
  barcode: string;
  price: number;
  purchased_price: number;
  quantity: number;
  weight: number;
  length: number;
  width: number;
  height: number;
  properties: Property[];
}

export interface Property   { name: string; value: string; }
export interface Warehouse  { id: number; name: string; description: string; is_active: boolean; }

export interface CustomField {
  id: number;
  uuid: string;    // наприклад "OR_1018", "CT_1008"
  name: string;
  type: string;
  value: string;
}

export interface Tag {
  id: number;
  name: string;
  alias: string;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface Shipping {
  delivery_service_id: number;
  tracking_code: string;
  shipping_status: string;
  shipping_address_city: string;
  shipping_address_country: string;
  shipping_address_country_code: string;
  shipping_address_region: string;
  shipping_address_zip: string;
  shipping_secondary_line: string;
  shipping_receive_point: string;
  recipient_full_name: string;
  recipient_phone: string;
  shipping_date_actual: string;   // ISO-рядок; використовується для delivery_time у Poster
}

export interface Manager {
  id: number;
  first_name: string;
  last_name: string;
  full_name: string;
  username: string;
  email: string;
  phone: string;
  role_id: number;
  status: string;
  created_at: string;
  updated_at: string;
  last_logged_at: string;
}

export interface Assigned {
  id: number;
  full_name: string;
  username: string;
  email: string;
  phone: string;
  role_id?: number;
  role?: Role;
  status: string;
  created_at: string;
  updated_at: string;
  last_logged_at: string;
}

export interface Role { id: number; name: string; alias: string; }

export interface Payment {
  id: number;
  destination_id: number;
  payment_method_id: number;
  amount: number;
  actual_currency: string;
  transaction_uuid: string;
  description: string;
  status: string;
  fiscal_result: string;
  payment_date: string;
  created_at: string;
  updated_at: string;
}

export interface GetOrdersResponse {
  current_page: number;
  data: Order[];
  total: number;
}

// Webhook-події:
export type KeyCrmEvent =
  | "order.change_order_status"
  | "order.change_payment_status"
  | "lead.change_lead_status";

export interface ChangeOrderEvent {
  event: KeyCrmEvent;
  context: ChangeOrderContext;   // поля замовлення на момент події
}
```

---

## Отримання одного замовлення

```ts
// GET /order/{order_id}?include=...
const res = await keycrmApiClient.get<Order>(
  `order/${orderId}?include=assigned,custom_fields,shipping.deliveryService,buyer,manager,products,products.offer,tags,payments`,
);
const order: Order = res.data;
```

### include-параметри

| Значення                   | Що додається до Order                               |
| -------------------------- | --------------------------------------------------- |
| `buyer`                    | `order.buyer` (Buyer)                               |
| `manager`                  | `order.manager` (Manager)                           |
| `assigned`                 | `order.assigned` (Assigned[])                       |
| `tags`                     | `order.tags` (Tag[])                                |
| `products`                 | `order.products` (Product[])                        |
| `products.offer`           | `order.products[].offer` (Offer)                    |
| `custom_fields`            | `order.custom_fields` (CustomField[])               |
| `shipping`                 | `order.shipping` (Shipping)                         |
| `shipping.deliveryService` | `order.shipping.deliveryService` (об'єкт служби)    |
| `payments`                 | `order.payments` (Payment[])                        |
| `expenses`                 | `order.expenses` (Expense[])                        |

---

## Отримання кастомного поля за UUID

```ts
// CustomField.uuid — рядок-константа типу "OR_1018"
function getCustomFieldValue(
  customFields: CustomField[] | undefined,
  uuid: string,
): string | undefined {
  return customFields?.find((f) => f.uuid === uuid)?.value;
}

// Приклад:
const receiptNumber = getCustomFieldValue(order.custom_fields, "OR_1018");
const deliveryWindow = getCustomFieldValue(order.custom_fields, "OR_1006");
```

### Кастомні поля замовлень, які використовує бот

| UUID       | Назва поля           | Призначення                                      |
| ---------- | -------------------- | ------------------------------------------------ |
| `OR_1018`  | Номер замовлення у Poster | Номер чека Poster, записується після синку    |
| `OR_1006`  | Часовий проміжок     | Діапазон часу доставки, наприклад `"14:00 - 16:00"` |

---

## Оновлення замовлення

```ts
// PUT /order/{order_id}
await keycrmApiClient.put<Order>(`order/${orderId}`, {
  status_id: 23,
});

// Оновлення кастомного поля (по id поля або по uuid):
await keycrmApiClient.put<Order>(`order/${orderId}`, {
  custom_fields: [
    { id: receiptField.id, value: "12345" },
    // або якщо id невідомий:
    { uuid: "OR_1018", value: "12345" },
  ],
});
```

### `changeOrderStatus` (src/services/keycrm.service.ts)

```ts
export const changeOrderStatus = async (
  orderId: number | string,
  status_id: string,
): Promise<Order> => {
  const res = await keycrmApiClient.put<Order>(`order/${+orderId}`, {
    status_id: +status_id,
  });
  return res.data;
};

// Виклик:
await changeOrderStatus(orderId, productDeliveredStatus); // productDeliveredStatus = env PRODUCT_DELIVERED_STATUS || "23"
```

---

## Отримання деталей каталожного товару

```ts
// GET /products/{id}?include=custom_fields
const { data } = await keycrmApiClient.get<KeycrmProductDetails>(
  `products/${productId}?include=custom_fields`,
);
// data.custom_fields — масив з uuid/value, де шукаємо CT_1022 / CT_1025 / CT_1026

// Тип відповіді (локальний у poster.service.ts):
type KeycrmProductDetails = {
  id: number;
  parent_id?: number | null;
  custom_fields?: Array<{
    id?: number;
    uuid?: string;
    name?: string;
    value?: unknown;
  }>;
};
```

### Кастомні поля товарів каталогу, які використовує бот

| UUID       | Призначення                                                        |
| ---------- | ------------------------------------------------------------------ |
| `CT_1022`  | `product_id` батьківського товару Poster (для incoming orders)     |
| `CT_1025`  | `modificator_id` (для incoming orders)                             |
| `CT_1026`  | `dish_modification_id` (для incoming orders, кілька через `,`)     |
| `CT_1008`  | Poster external ID для синхронізації каталогу (sync-poster-keycrm) |
| `CT_1014`  | `ingredient_id` з Poster (для синхронізації каталогу)              |

---

## Отримання списку замовлень

```ts
// GET /order?include=...&limit=50&page=1
const res = await keycrmApiClient.get<GetOrdersResponse>(
  "order?include=buyer,products&limit=50",
);
const { data: orders, total, current_page } = res.data;

// GetOrdersResponse:
export interface GetOrdersResponse {
  current_page: number;
  data: Order[];
  total: number;
}
```

### Параметри фільтрації

| Параметр                   | Тип    | Опис                                   |
| -------------------------- | ------ | -------------------------------------- |
| `include`                  | string | Пов'язані дані через кому              |
| `limit`                    | number | Кількість на сторінку (max 50)         |
| `page`                     | number | Номер сторінки                         |
| `filter[status_id]`        | number | Фільтр по статусу                      |
| `filter[created_at_from]`  | string | Дата створення від (YYYY-MM-DD)        |
| `filter[created_at_to]`    | string | Дата створення до (YYYY-MM-DD)         |
| `filter[updated_at_from]`  | string | Дата оновлення від                     |
| `filter[updated_at_to]`    | string | Дата оновлення до                      |

---

## Робота з тегами

```ts
// Додати тег до замовлення:
await keycrmApiClient.post(`order/${orderId}/tag/${tagId}`, {});

// Видалити тег:
await keycrmApiClient.delete(`order/${orderId}/tag/${tagId}`);

// Tag:
export interface Tag {
  id: number;
  name: string;
  alias: string;
  color: string;
  created_at: string;
  updated_at: string;
}
```

---

## Завантаження файлу в KeyCRM Storage

```ts
// POST /storage/upload (multipart/form-data)
// Відповідь:
export interface StorageUploadResponse {
  id: number;
  url: string;         // публічне посилання на файл
  thumbnail: string;
  original_file_name: string;
  extension: string;
  mime_type: string;
  size: number;
  hash: string;
  disk: string;
  directory: string;
  file_name: string;
  updated_at: string;
  created_at: string;
}
```

---

## Помилки та rate limit

| HTTP-код | Причина                                |
| -------- | -------------------------------------- |
| 401      | Невірний або прострочений API-ключ     |
| 404      | Замовлення / ресурс не знайдено        |
| 422      | Помилка валідації тіла запиту          |
| 429      | Rate limit: 60 запитів/хвилину         |
| 500      | Внутрішня помилка сервера KeyCRM       |

Admin-клієнт автоматично оновлює токен при `401` через interceptor у `keycrmApiClient.ts`.
