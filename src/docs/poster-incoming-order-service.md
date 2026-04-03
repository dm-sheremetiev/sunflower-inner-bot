# `poster.service.ts`: формирование incoming order в Poster

Документ описывает текущую логику файла `src/services/poster.service.ts` для сценария создания онлайн-заказа в Poster и записи номера чека обратно в KeyCRM.

## 1) Точка входа и сигнатура

Экспортируемая функция:

- `createPosterOrdersAndStoreReceipts(order: Order, reply: FastifyReply, branchTags: string[]): Promise<string | null>`

Возвращает:

- `string` — строка с номером(ами) чека Poster (для одного филиала только номер, для нескольких формат `Филиал: номер` через запятую),
- `null` — если синхронизация не выполнена или неуспешна.

## 2) Типы и ключевые константы

### 2.1 UUID полей KeyCRM

- `OR_1018` (`POSTER_RECEIPT_FIELD_UUID`) — поле заказа для сохранения номера чека Poster.
- `OR_1006` (`DELIVERY_TIME_FIELD_UUID`) — поле интервала времени доставки.
- `CT_1008` / `CT_1014` — соответствия Poster и состав для **других** потоков (остатки, синхронизация каталога). В **incomingOrders.createIncomingOrder** не участвуют.
- `CT_1022` (`POSTER_INCOMING_PARENT_PRODUCT_FIELD_UUID`) — основной `product_id` для incoming order.
- `CT_1025` (`POSTER_INCOMING_MODIFICATOR_FIELD_UUID`) — основной `modificator_id` для incoming order.
- `CT_1026` (`POSTER_INCOMING_DISH_MODIFICATION_FIELD_UUID`) — основной `dish_modification_id` для incoming order (`m` в `modification`).

### 2.2 Основные типы

- `PosterSpot` — точка Poster: `spot_id`, `name`, `spot_delete`.
- `PosterIncomingOrderProduct` — элемент `products` в payload Poster:
  - `product_id: number`
  - `count: number`
  - `modificator_id?: number`
  - `modification?: string` (JSON-строка `[{ m - dish_modification_id, a - quantity }]`)
  - `comment?: string`
- `KeycrmProductDetails` — ответ `GET products/{id}?include=custom_fields` (минимально: `id`, `parent_id`, `custom_fields`).
- `OrderProductWithMeta` — узкое расширение `Order["products"][number]` для фактических полей из include:
  - `id?`, `custom_fields?`, `modificator_id?`,
  - `offer.product?.custom_fields?`.

## 3) Верхнеуровневый пайплайн

В `createPosterOrdersAndStoreReceipts` шаги идут строго в таком порядке:

1. Определение филиалов из тегов заказа: `extractOrderBranches(order, branchTags)`.
2. Если филиалов нет -> `info` лог и `return null`.
3. Загрузка точек Poster: `fetchPosterSpots()` -> `GET /spots.getSpots`.
4. Матчинг филиалов на online-shop точки: `getPosterOnlineShopSpotsByBranches(...)`.
5. Если подходящих точек нет -> `error` лог и `return null`.
6. Нормализация контактов:
   - телефон: `normalizePosterPhone(order.buyer?.phone)` (телефон отримувача з доставки не використовується),
   - время: `getPosterDeliveryTime(order)`.
   - `address` в текущем payload не отправляется (опционален для API Poster).
7. Маппинг товаров: `mapOrderProductsToPosterProducts(order, reply)`.
8. Если товаров нет -> `error` лог и `return null`.
9. Для каждой matched точки:
   - сбор `payload`,
   - `POST /incomingOrders.createIncomingOrder`,
   - чтение `response.transaction_id`,
   - если `transaction_id` невалиден -> `error`, переход к следующей точке.
10. Если чеков нет -> `return null`.
11. Формирование строки чеков `formatPosterReceiptsText(receipts)`.
12. Запись строки чеков в KeyCRM: `updatePosterReceiptInCrm(...)`.

## 4) Фильтрация и матчинг точек (spots)

### 4.1 Нормализация

`normalizeSpotName`:

- lowercase,
- `—/–/-` -> `-`,
- схлопывание множественных пробелов,
- trim.

### 4.2 Отбор online-shop точки

`isOnlineShopSpotName(name)` возвращает `true`, если имя содержит любую из подстрок:

- `інтернет-магазин`
- `інтернет магазин`
- `интернет-магазин`
- `интернет магазин`

### 4.3 Матчинг филиала к точке

`getPosterOnlineShopSpotsByBranches(spots, branches)`:

- берет только `spot_delete === 0`,
- имя точки должно содержать нормализованное имя филиала,
- имя точки должно пройти `isOnlineShopSpotName`.

Результат: массив `{ branchName, spot }`.

## 5) Нормализация телефона и времени доставки

### 5.1 Телефон

`normalizePosterPhone`:

- если пусто -> `+380989000000`,
- удаляет все, кроме цифр и `+`,
- `+...` сохраняется,
- `380...` -> `+380...`,
- `0...` -> `+38...`,
- иначе добавляет `+` в начало.

### 5.2 Время

`getDeliveryTimeRangeStart`:

- ищет поле `OR_1006` или поле, где имя содержит `часовий проміжок`,
- парсит только начало диапазона формата `HH:mm - ...`,
- возвращает `HH:mm:00` или `null`.

`getPosterDeliveryTime`:

- дата: `shipping.shipping_date_actual` (таймзона `Europe/Kyiv`) или текущая дата,
- время: из диапазона выше или текущее время,
- итоговый формат: `YYYY-MM-DD HH:mm:ss`.

## 6) Как формируется `products` для Poster

Функция: `mapOrderProductsToPosterProducts(order, reply)`.

### 6.1 Подготовка каталожных данных

Сначала собирается `productsDetailsMap`:

- для каждой строки заказа берется `catalogId = offer.product_id ?? product.id`,
- загружается `GET products/{catalogId}?include=custom_fields`,
- дополнительно догружается один уровень родителя (`parent_id`) для уже загруженных карточек.

### 6.2 Источники ID из custom fields

Для каждой строки заказа (поиск значения в том же порядке: `product.custom_fields` → `offer.product.custom_fields` → карточка каталога):

1. `incomingParentProductId` <- `CT_1022`.
2. `incomingModificatorId` <- `CT_1025`.
3. `incomingDishModificationIds` <- `CT_1026` (несколько id через разделители).

`product_id` в payload Poster **только** из `CT_1022`. Если в строке нет валидного `CT_1022`, строка отбрасывается.

### 6.3 Выбор между `modificator_id` и `modification`

Взаимоисключающе:

1. Если есть `CT_1025` и `CT_1025 !== product_id` -> `modificator_id`.
2. Иначе если в `CT_1026` есть id -> `modification`:
   - id сортируются по возрастанию,
   - JSON-строка `[{ "m": id, "a": qty }, ...]`,
   - `qty = max(1, trunc(count))`.
3. Иначе позиция уходит **как простой товар** (`product_id` + `count`, без `modificator_id` и без `modification`).

Никаких fallback из `CT_1008`, `CT_1014`, полей строки заказа и `properties`.

Дополнительная защита:

- если `modificator_id === product_id`, `modificator_id` удаляется (на практике в вашей схеме `CT_1022 != CT_1025`).

### 6.4 Фильтрация невалидных строк

Строка товара отбрасывается, если:

- `count` нечисловой или `<= 0`,
- не удалось получить `product_id`.

Если после маппинга массив пустой — логируется расширенный `productsPreview`.

## 7) Что уходит в Poster API

На каждый филиал (spot) отправляется:

- `spot_id`
- `first_name` (`recipient_full_name` или phone)
- `phone`
- `comment` (склейка manager/client комментариев)
- `delivery_time`
- `skip_phone_validation: true`
- `products` (как описано выше)

`address` — опциональное поле API Poster, в текущей реализации не отправляется.

Endpoint:

- `POST /incomingOrders.createIncomingOrder`

Документация Poster:

- https://dev.joinposter.com/ua/docs/v3/web/incomingOrders/createIncomingOrder

## 8) Запись номера чека в KeyCRM

После успешных ответов Poster:

- берется `transaction_id` из каждой точки,
- формируется строка:
  - один чек -> `"12345"`,
  - несколько -> `"Філія1: 12345, Філія2: 67890"`,
- перед записью выполняется `GET /order/{orderId}?include=custom_fields`, чтобы взять актуальный `id` поля OR_1018;
- сохраняется в заказ KeyCRM через `PUT /order/{orderId}` с **полной заменой** значения OR_1018 на сформированную строку (без слияния со старым текстом в CRM):
  - по `id` поля OR_1018, если оно есть в ответе,
  - иначе по `uuid: OR_1018`.

## 9) Логирование и ошибки

### 9.1 Основные ранние выходы

- нет branch tags -> `Poster sync skipped: no branch tags`
- нет matched online-shop spots -> `Poster sync failed: no matching online shop spots`
- нет mapped products -> `Poster sync failed: no products mapped for Poster payload`

### 9.2 Ошибки запроса в Poster

При исключении в `incomingOrders.createIncomingOrder` логируется:

- `orderId`, `branchName`, `spotId`,
- `posterRequest` из `summarizeAxiosErrorForLog`:
  - `status`, `statusText`, `responseData`, `responseHeaders`,
  - `url`, `method`, `baseURL`,
  - `requestData` (распарсенное тело запроса, если возможно).

### 9.3 Некорректный ответ Poster

Если `transaction_id` отсутствует/невалиден:

- лог `Poster sync failed: invalid transaction_id`
- обработка продолжается по следующим точкам.

