# Зв'язок позицій Poster з CRM (сайт + KeyCRM) - leftovers

Документ описує, **як ідентифікатори з Poster** відображаються на **товари на сайті** (PostgreSQL / Prisma) і на **KeyCRM**, і як вони використовуються в **рекалькуляції цін** та **синхронізації Poster → KeyCRM**.

Код знаходиться в репо сайту (`sunflower-site` або аналог), не в цьому боті.

---

## 0. Константи

### Кастомні поля KeyCRM (товари каталогу)

```ts
// src/lib/cron/sync-poster-keycrm.ts
const CUSTOM_FIELD_UUID            = "CT_1008"; // Poster external ID (product_id / modificator_id / dish_modification_id)
const INGREDIENT_ID_CUSTOM_FIELD_UUID = "CT_1014"; // ingredient_id з Poster (один або кілька через кому)
```

### Базовий URL для фото Poster

```ts
const POSTER_BASE_URL = "https://sunflower.joinposter.com";
// відносні шляхи з photo / photo_origin / photo_large / photo_orig доповнюються цим префіксом
```

### Поле замовлення KeyCRM (у боті — тільки для довідки)

```ts
// src/services/poster.service.ts (цей бот)
const POSTER_RECEIPT_FIELD_UUID = "OR_1018"; // номер чеку Poster у замовленні KeyCRM
const DELIVERY_TIME_FIELD_UUID  = "OR_1006"; // часовий проміжок доставки

// поля каталогу для incoming orders (цей бот, НЕ для recalculate / sync):
const POSTER_INCOMING_PARENT_PRODUCT_FIELD_UUID    = "CT_1022"; // product_id батька
const POSTER_INCOMING_MODIFICATOR_FIELD_UUID       = "CT_1025"; // modificator_id
const POSTER_INCOMING_DISH_MODIFICATION_FIELD_UUID = "CT_1026"; // dish_modification_id
```

---

## 1. Три системи та їх роль

| Система            | Роль                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| **Poster**         | Джерело меню та цін (`menu.getProducts`): товари, модифікатори, техкарти (`group_modifications`).             |
| **Сайт (наша БД)** | Каталог для вітрини: `Product`, `ProductVariant`, склад варіанта — `ProductVariantComponent` з полями Poster. |
| **KeyCRM**         | Облік номенклатури для продажів/закупівель; зв'язок з Poster через кастомні поля товару (`CT_1008`).          |

Категорії для KeyCRM підтягуються з Poster за `category_name` і зіставляються з категоріями KeyCRM за **нормалізованою назвою** (`trim` + `toLowerCase()`).

---

## 2. Ідентифікатори Poster у нашій БД

У моделі `ProductVariantComponent` (і аналогічно `ShowcaseItemComponent`) зберігаються:

| Поле                     | Що це в Poster                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `external_id`            | Зазвичай `product_id` батьківського товару в Poster (для модифікаторів теж дублюється `product_id` товару, з якого знято модифікацію).     |
| `modificator_id`         | ID **звичайної модифікації** (`modifications[]` у відповіді API).                                                                          |
| `dish_modification_id`   | ID позиції з **техкарти** (`group_modifications[].modifications[]`, поле `dish_modification_id`).                                          |

Один варіант товару на сайті — це **композиція** кількох компонентів; ціна на вітрині в рекалькуляції збирається як **сума цін компонентів** з Poster (з урахуванням `quantity`).

Поле `ScheduledPriceChange` у схемі також тримає трійку `product_id` / `modificator_id` / `dish_modification_id` для запланованих змін цін у Poster.

---

## 3. Як Poster віддає дані — `menu.getProducts`

### 3.0. Виклик API

```ts
// GET https://joinposter.com/api/menu.getProducts?token=TOKEN&type=products
// Відповідь: { response: PosterProduct[] }
const { data } = await posterApiClient.get("/menu.getProducts", {
  params: { type: "products" },
});
const products: PosterProduct[] = data.response ?? [];
```

### 3.1. Товар **без** `modifications` і **без** `group_modifications` — звичайний товар

```ts
// Ціна: максимум серед видимих spots (visible === "1"), ділення на 100 (копійки → гривні)
const price = Math.max(
  ...product.spots
    .filter((s) => s.visible === "1")
    .map((s) => Number(s.price) / 100)
);

// Ключ у мапу цін:
posterPrices.set(String(product.product_id), { currentPrice: price, oldPrice });

// Стара ціна для акції (якщо задана в штрих-коді товару):
const oldPrice = product.barcode ? Number(product.barcode) : null; // вже в гривнях
```

### 3.2. Товар з `modifications` — товар із модифікатором

```ts
for (const mod of product.modifications) {
  const price = Math.max(
    ...mod.spots
      .filter((s) => s.visible === "1")
      .map((s) => Number(s.price) / 100)
  );

  // Якщо всі видимі spot дають 0 — позиція прихована у Poster:
  if (price === 0) {
    hiddenInPoster.add(String(mod.modificator_id));
    continue;
  }

  const oldPrice = mod.modificator_barcode ? Number(mod.modificator_barcode) : null;

  // Ключ у мапу цін:
  posterPrices.set(String(mod.modificator_id), { currentPrice: price, oldPrice });
}
```

### 3.3. Товар з `group_modifications` — техкарти

```ts
for (const group of product.group_modifications) {
  for (const mod of group.modifications) {
    // price уже в гривнях (НЕ ділиться на 100):
    const price = Number(mod.price);

    // Ключ у мапу цін:
    posterPrices.set(String(mod.dish_modification_id), {
      currentPrice: price,
      oldPrice: null, // barcode для техкарт не використовується
    });
  }
}
```

### 3.4. Повністю прихований товар (`hidden === "1"`)

```ts
if (product.hidden === "1") {
  // Не потрапляє в posterPrices як валідна ціна.
  // Всі дочірні ключі реєструються окремо для діагностики прихованих компонентів:
  hiddenProductKeys.add(String(product.product_id));
  for (const mod of product.modifications ?? []) {
    hiddenProductKeys.add(String(mod.modificator_id));
  }
  continue;
}
```

---

## 4. Рекалькуляція цін на сайті — `recalculatePrices`

Файл: `src/modules/product/product.service.ts`

### 4.1. Побудова мапи цін

```ts
// Тип: Map<string, { currentPrice: number; oldPrice: number | null }>
const posterPrices = new Map<string, { currentPrice: number; oldPrice: number | null }>();

// Заповнюється трьома циклами вище (розд. 3.1 – 3.3)
```

### 4.2. Алгоритм пошуку ціни для кожного компонента

```ts
for (const component of variant.ProductVariantComponent) {
  let priceEntry =
    posterPrices.get(component.external_id) ??                           // 1. product_id
    (component.modificator_id
      ? posterPrices.get(component.modificator_id)                       // 2. modificator_id
      : undefined) ??
    (component.dish_modification_id
      ? posterPrices.get(String(component.dish_modification_id))         // 3. dish_modification_id
      : undefined);

  if (!priceEntry) {
    // Компонент зник або прихований у Poster:
    // - variant.is_active = false (деактивація варіанта)
    // - якщо component.external_id є в hiddenProductKeys → Telegram-сповіщення
    continue;
  }

  currentSum += priceEntry.currentPrice * (component.quantity ?? 1);
  if (priceEntry.oldPrice !== null) {
    oldSum += priceEntry.oldPrice * (component.quantity ?? 1);
  }
}
```

### 4.3. Виставлення ціни варіанта

```ts
// Підсумкова ціна — округлена сума:
const finalPrice = Math.round(currentSum);

// Логіка price / discount_price:
// Якщо oldSum > currentSum — виставляємо акційну ціну (старша ціна через barcode):
if (oldSum > currentSum) {
  variant.price          = Math.round(oldSum);    // закреслена "стара" ціна
  variant.discount_price = Math.round(currentSum); // актуальна ціна
} else {
  variant.price          = finalPrice;
  variant.discount_price = null;
}
```

**Висновок:** зв'язок сайту з Poster у рекалькуляції — **не по slug товару**, а **строго по трійці полів компонента**, узгодженій з тим, як ключі заповнюються з `menu.getProducts`.

---

## 5. Синхронізація Poster → KeyCRM — `syncPosterToKeyCRM`

Файл: `src/lib/cron/sync-poster-keycrm.ts`

KeyCRM не використовує наші внутрішні `cuid` з сайту. Зв'язок тільки через кастомні поля товару в KeyCRM.

### 5.1. Побудова словника товарів KeyCRM

```ts
// GET https://openapi.keycrm.app/v1/products?include=custom_fields&limit=50&page=N
const keycrmProducts = await fetchAllKeycrmProducts(); // пагінація до next_page_url === null

// Словник: значення CT_1008 → товар KeyCRM
const keycrmProductsMap = new Map<string, KeycrmProduct>();
for (const product of keycrmProducts) {
  const ct1008 = product.custom_fields?.find(
    (f) => f.uuid === CUSTOM_FIELD_UUID  // "CT_1008"
  )?.value;
  if (ct1008) keycrmProductsMap.set(String(ct1008), product);
}
```

### 5.2. Звичайний товар Poster (без модифікацій у цій гілці)

```ts
const posterKey = String(product.product_id); // CT_1008

const payload = {
  name: product.product_name.replace(/\s+/g, " ").trim(),
  price: Number(product.price) / 100,           // копійки → гривні
  purchased_price: Number(product.cost) / 100,
  category_id: await resolveKeycrmCategoryId(product.category_name),
  pictures: buildPhotoUrls([product.photo, product.photo_origin]),
  custom_fields: [
    { uuid: CUSTOM_FIELD_UUID, value: posterKey },            // CT_1008 = product_id
    { uuid: INGREDIENT_ID_CUSTOM_FIELD_UUID, value:           // CT_1014
        [product.ingredient_id, ...(product.ingredients ?? []).map(i => i.ingredient_id)]
          .filter(id => id && id !== "0")
          .join(",")
    },
  ],
};

// Якщо є в словнику → PUT, інакше → POST:
if (keycrmProductsMap.has(posterKey)) {
  await keycrmApiClient.put(`products/${keycrmProductsMap.get(posterKey)!.id}`, payload);
} else {
  await keycrmApiClient.post(`products`, payload);
}
```

### 5.3. Модифікатор з `modifications[]`

```ts
for (const mod of product.modifications) {
  const posterKey = String(mod.modificator_id); // CT_1008

  // Ціна: перший видимий spot модифікатора / 100:
  const price = Number(mod.spots?.[0]?.price ?? 0) / 100;

  const payload = {
    name: mod.modificator_name.replace(/\s+/g, " ").trim(),
    price,
    purchased_price: Number(mod.modificator_selfprice ?? 0) / 100,
    sku: mod.modificator_product_code || undefined,
    barcode: mod.modificator_barcode || undefined,
    category_id: await resolveKeycrmCategoryId(product.category_name),
    pictures: buildPhotoUrls([product.photo, product.photo_origin]),
    custom_fields: [
      { uuid: CUSTOM_FIELD_UUID, value: posterKey },          // CT_1008 = modificator_id
      { uuid: INGREDIENT_ID_CUSTOM_FIELD_UUID, value:         // CT_1014
          mod.ingredient_id || ""
      },
    ],
  };

  if (keycrmProductsMap.has(posterKey)) {
    await keycrmApiClient.put(`products/${keycrmProductsMap.get(posterKey)!.id}`, payload);
  } else {
    await keycrmApiClient.post(`products`, payload);
  }
}
```

### 5.4. Позиція техкарти з `group_modifications[].modifications[]`

```ts
for (const group of product.group_modifications) {
  for (const mod of group.modifications) {
    const posterKey = String(mod.dish_modification_id); // CT_1008 — НЕ product_id батька

    const payload = {
      // Назва: "{product_name} - {group.name} - {mod.name}"
      name: `${product.product_name} - ${group.name} - ${mod.name}`.replace(/\s+/g, " ").trim(),
      price: Number(mod.price),          // уже в гривнях (не ділиться на 100)
      purchased_price: 1,                // заглушка — реальна собівартість недоступна
      category_id: await resolveKeycrmCategoryId(product.category_name),
      pictures: buildPhotoUrls([mod.photo_large, mod.photo_orig]),
      custom_fields: [
        { uuid: CUSTOM_FIELD_UUID, value: posterKey },          // CT_1008 = dish_modification_id
        { uuid: INGREDIENT_ID_CUSTOM_FIELD_UUID, value:         // CT_1014
            mod.ingredient_id || ""
        },
      ],
    };

    if (keycrmProductsMap.has(posterKey)) {
      await keycrmApiClient.put(`products/${keycrmProductsMap.get(posterKey)!.id}`, payload);
    } else {
      await keycrmApiClient.post(`products`, payload);
    }
  }
}
```

### 5.5. Прихований товар (`hidden`)

```ts
if (product.hidden === "1") {
  // Пропускається: не створюється і не оновлюється в KeyCRM.
  continue;
}
```

### 5.6. Нормалізація категорії

```ts
// Пошук існуючої категорії KeyCRM за нормалізованою назвою:
async function resolveKeycrmCategoryId(categoryName: string): Promise<number> {
  const normalized = categoryName.trim().toLowerCase();
  const existing = keycrmCategories.find(
    (c) => c.name.trim().toLowerCase() === normalized
  );
  if (existing) return existing.id;
  // Якщо не знайдено — створення нової категорії:
  const { data } = await keycrmApiClient.post("products/categories", { name: categoryName });
  return data.id;
}
```

### 5.7. Побудова URL фото

```ts
function buildPhotoUrls(paths: (string | undefined | null)[]): string[] {
  return paths
    .filter((p): p is string => !!p)
    .map((p) => (p.startsWith("http") ? p : `${POSTER_BASE_URL}${p}`));
}
```

---

## 6. Відповідність CT_1008 по типу товару

| Що прийшло з Poster                         | Значення `CT_1008`              | Один рядок KeyCRM =                                   |
| ------------------------------------------- | ------------------------------- | ----------------------------------------------------- |
| Простий товар (без модифікацій)             | `String(product_id)`            | Весь продукт меню                                     |
| Елемент `modifications[]`                   | `String(modificator_id)`        | Один модифікатор                                      |
| Елемент `group_modifications[].modifications[]` | `String(dish_modification_id)` | Одна позиція техкарти (**не** `product_id` батька)  |

Якщо в KeyCRM у двох товарів **однаковий** `CT_1008` — в словнику перемагає перший запис (дубль треба виправляти вручну).

---

## 7. Узгодження адмінки сайту з Poster

Щоб рекалькуляція і фільтри (квіткові компоненти тощо) працювали передбачувано:

- Для **компонента без модифікатора і техкарти** у `external_id` має бути `product_id` Poster.
- Для **лінії з модифікатором** — заповнити `modificator_id` (і за потреби `external_id` = батьківський `product_id`).
- Для **лінії техкарти** — заповнити `dish_modification_id` і не плутати з `modificator_id`.

KeyCRM при цьому живе **паралельно**: той самий `modificator_id` / `dish_modification_id` / `product_id` має потрапляти в `CT_1008`, щоб синк знаходив пару «Poster ↔ KeyCRM».

---

## 8. Де це в коді (орієнтири)

| Файл (репо сайту)                                       | Що там                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `src/modules/product/product.service.ts`                | `recalculatePrices` — побудова мапи цін і оновлення варіантів |
| `src/modules/poster/poster.service.ts`                  | Розбір меню Poster для UI / списків компонентів             |
| `src/lib/cron/sync-poster-keycrm.ts`                    | `syncPosterToKeyCRM` — синхронізація в KeyCRM; константи `CUSTOM_FIELD_UUID` (`CT_1008`), `INGREDIENT_ID_CUSTOM_FIELD_UUID` (`CT_1014`) |
| `src/database/prisma/schema.prisma`                     | `ProductVariantComponent`, `ShowcaseItemComponent`, `ScheduledPriceChange` |

Документ відображає стан логіки на момент написання; при зміні полів Poster API або UUID кастомних полів KeyCRM потрібно оновити і цей файл, і відповідні константи в коді.
