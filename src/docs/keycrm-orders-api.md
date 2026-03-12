# Отримання замовлень з KeyCRM API

## Базова інформація

**Base URL:** `https://openapi.keycrm.app/v1`

**Авторизація:** Bearer токен
```
Authorization: Bearer YOUR_API_KEY
```

## Отримання одного замовлення

### Endpoint

```
GET /order/{order_id}
```

### Параметри

| Параметр | Тип | Опис |
|----------|-----|------|
| `order_id` | string | ID замовлення в KeyCRM |
| `include` | string | Пов'язані дані через кому |

### Include параметри

| Значення | Опис |
|----------|------|
| `buyer` | Дані покупця (клієнта) |
| `manager` | Дані менеджера |
| `expenses` | Витрати по замовленню |
| `tags` | Теги замовлення |
| `products` | Товари в замовленні |
| `payments` | Оплати |
| `shipping` | Дані доставки |

### Приклад запиту

```bash
curl -X GET "https://openapi.keycrm.app/v1/order/12345?include=buyer,manager,expenses,tags,products" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Accept: application/json"
```

### Типи відповіді

```typescript
interface KeyCrmOrderResponse {
  id: number;
  source_id: number;
  source_uuid?: string;
  status_id: number;
  status_group_id: number;
  grand_total: number;
  promocode?: string;
  promocode_percent?: number;
  discount_percent?: number;
  discount_amount?: number;
  shipping_price?: number;
  wrap_price?: number;
  taxes?: number;
  manager_id?: number;
  manager_comment?: string;
  buyer_comment?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  is_gift?: boolean;
  gift_message?: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  
  // Include: buyer
  buyer?: {
    id: number;
    full_name: string;
    email?: string;
    phone?: string;
    shipping_addresses?: Array<{
      address: string;
      city?: string;
    }>;
  };
  
  // Include: manager
  manager?: {
    id: number;
    name: string;
    email?: string;
  };
  
  // Include: tags
  tags?: Array<{
    id: number;
    name: string;
    color?: string;
  }>;
  
  // Include: products
  products?: KeyCrmOrderProduct[];
  
  // Include: expenses
  expenses?: Array<{
    id: number;
    name: string;
    amount: number;
  }>;
  
  // Include: payments
  payments?: Array<{
    id: number;
    payment_method_id: number;
    amount: number;
    status: string;
    created_at: string;
  }>;
  
  // Include: shipping
  shipping?: {
    shipping_service_id?: number;
    tracking_code?: string;
    shipping_address?: string;
    recipient_full_name?: string;
    recipient_phone?: string;
  };
}

interface KeyCrmOrderProduct {
  id: number;
  offer_id: number;
  product_id: number;
  name: string;
  sku?: string;
  quantity: number;
  price: number;
  purchased_price?: number;
  discount_percent?: number;
  discount_amount?: number;
  comment?: string;
  picture?: {
    thumbnail?: string;
  };
  properties?: Array<{
    name: string;
    value: string;
  }>;
  offer?: {
    id: number;
    sku?: string;
    barcode?: string;
    price: number;
    product?: {
      id: number;
      name: string;
      custom_fields?: Array<{
        uuid: string;
        value: string;
      }>;
    };
  };
}
```

## Отримання списку замовлень

### Endpoint

```
GET /order
```

### Параметри фільтрації

| Параметр | Тип | Опис |
|----------|-----|------|
| `include` | string | Пов'язані дані |
| `limit` | number | Кількість записів на сторінку (max 50) |
| `page` | number | Номер сторінки |
| `filter[status_id]` | number | Фільтр по статусу |
| `filter[source_id]` | number | Фільтр по джерелу |
| `filter[manager_id]` | number | Фільтр по менеджеру |
| `filter[created_at_from]` | string | Дата створення від (YYYY-MM-DD) |
| `filter[created_at_to]` | string | Дата створення до (YYYY-MM-DD) |
| `filter[updated_at_from]` | string | Дата оновлення від |
| `filter[updated_at_to]` | string | Дата оновлення до |

### Приклад запиту

```bash
curl -X GET "https://openapi.keycrm.app/v1/order?include=buyer,products&limit=50&filter[created_at_from]=2024-01-01" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Accept: application/json"
```

### Відповідь з пагінацією

```typescript
interface KeyCrmOrdersListResponse {
  total: number;
  current_page: number;
  limit: number;
  data: KeyCrmOrderResponse[];
  first_page_url: string;
  last_page_url: string;
  next_page_url: string | null;
  prev_page_url: string | null;
}
```

## Приклади використання

### Отримання замовлення з усіма даними

```typescript
import axios from "axios";

const apiKey = process.env.KEYCRM_API_KEY;
const apiUrl = "https://openapi.keycrm.app/v1";

async function getOrderWithAllIncludes(orderId: string) {
  const response = await axios.get(
    `${apiUrl}/order/${orderId}?include=buyer,manager,expenses,tags,products,payments,shipping`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }
  );

  return response.data;
}
```

### Отримання всіх замовлень з пагінацією

```typescript
async function getAllOrders(): Promise<KeyCrmOrderResponse[]> {
  const allOrders: KeyCrmOrderResponse[] = [];
  let nextPageUrl: string | null = "/order?include=buyer,products&limit=50";

  while (nextPageUrl) {
    const url = nextPageUrl.startsWith("http")
      ? nextPageUrl
      : `${apiUrl}${nextPageUrl}`;

    const response = await axios.get<KeyCrmOrdersListResponse>(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });

    allOrders.push(...response.data.data);
    nextPageUrl = response.data.next_page_url;
  }

  return allOrders;
}
```

### Отримання замовлень за період

```typescript
async function getOrdersByDateRange(from: string, to: string) {
  const response = await axios.get(
    `${apiUrl}/order?include=buyer,products&filter[created_at_from]=${from}&filter[created_at_to]=${to}&limit=50`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }
  );

  return response.data;
}

// Використання
const orders = await getOrdersByDateRange("2024-01-01", "2024-01-31");
```

## Робота з товарами в замовленні

### Отримання Poster ID товару

Кожен товар у замовленні може мати кастомне поле `CT_1008` з Poster ID:

```typescript
function getPosterIdFromOrderProduct(product: KeyCrmOrderProduct): string | null {
  const customField = product.offer?.product?.custom_fields?.find(
    field => field.uuid === "CT_1008"
  );

  return customField?.value || null;
}
```

### Отримання ingredient_id товару

```typescript
function getIngredientIdFromOrderProduct(product: KeyCrmOrderProduct): string | null {
  const customField = product.offer?.product?.custom_fields?.find(
    field => field.uuid === "CT_1014"
  );

  return customField?.value || null;
}
```

## Оновлення замовлення

### Endpoint

```
PUT /order/{order_id}
```

### Приклад: Оновлення коментаря менеджера

```typescript
async function updateManagerComment(orderId: string, comment: string) {
  const response = await axios.put(
    `${apiUrl}/order/${orderId}`,
    { manager_comment: comment },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    }
  );

  return response.data;
}
```

## Робота з тегами

### Додати тег до замовлення

```
POST /order/{order_id}/tag/{tag_id}
```

### Видалити тег із замовлення

```
DELETE /order/{order_id}/tag/{tag_id}
```

### Приклад

```typescript
async function addTagToOrder(orderId: string, tagId: number) {
  await axios.post(
    `${apiUrl}/order/${orderId}/tag/${tagId}`,
    {},
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }
  );
}

async function removeTagFromOrder(orderId: string, tagId: number) {
  await axios.delete(
    `${apiUrl}/order/${orderId}/tag/${tagId}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }
  );
}
```

## Додавання товарів до замовлення

### Endpoint

```
POST /orders/{order_id}/products
```

### Тіло запиту

```typescript
interface AddProductsRequest {
  products: Array<{
    offer_id: number;      // ID офера в KeyCRM
    quantity: number;      // Кількість
    price: number;         // Ціна за одиницю
    comment?: string;      // Коментар до товару
    discount_percent?: number;  // Знижка в %
  }>;
}
```

### Приклад

```typescript
async function addProductsToOrder(orderId: string, products: AddProductsRequest["products"]) {
  const response = await axios.post(
    `${apiUrl}/orders/${orderId}/products`,
    { products },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    }
  );

  return response.data;
}
```

## Статуси замовлень

Статуси залежать від налаштувань CRM. Приклад стандартних статусів:

| status_id | Назва |
|-----------|-------|
| 1 | Новий |
| 2 | В обробці |
| 3 | Виконано |
| 4 | Скасовано |

**Важливо:** ID статусів можуть відрізнятися в різних акаунтах KeyCRM.

## Помилки

### Стандартні HTTP коди

| Код | Опис |
|-----|------|
| 200 | Успішно |
| 400 | Невірний запит |
| 401 | Не авторизовано |
| 404 | Замовлення не знайдено |
| 422 | Помилка валідації |
| 429 | Занадто багато запитів (rate limit) |
| 500 | Внутрішня помилка сервера |

### Rate Limiting

KeyCRM обмежує кількість запитів: **60 запитів на хвилину**.

При перевищенні ліміту API повертає код `429`. Рекомендується додавати затримку між запитами:

```typescript
await new Promise(resolve => setTimeout(resolve, 1000)); // 1 секунда між запитами
```

## Корисні посилання

- [KeyCRM API Documentation](https://docs.keycrm.app/)
- [OpenAPI Specification](https://openapi.keycrm.app/)
