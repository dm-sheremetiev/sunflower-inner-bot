# Public API: shifts and vehicles

## Endpoints

- Shift path: `https://sun-ways.vercel.app/api/public/shifts/by-telegram`
- Vehicles path: `https://sun-ways.vercel.app/api/public/vehicles`
- Auth: header `x-api-key: <PUBLIC_SHIFT_API_KEY>`
- Content type: `application/json`

## Environment variable

Set on server:

`PUBLIC_SHIFT_API_KEY=<your_secret_key>`

If header key is missing or invalid, API returns:

- `401 Unauthorized`

---

## 1) Start shift

### Request

- Method: `POST`
- URL: `https://sun-ways.vercel.app/api/public/shifts/by-telegram`

Body:

```json
{
  "telegramUsername": "@andriyashh",
  "vehicleId": "f9f43c4e-8a61-4b0f-b5d0-9d5f2f0c9c93",
  "odometerStart": 125430,
  "lat": 50.4501,
  "lng": 30.5234,
  "endTime": "21:00"
}
```

### Fields

- `telegramUsername` (string, required)  
  Telegram username courier. `@` is optional, username is normalized to lowercase.
- `endTime` (string, optional, format `HH:mm`)  
  Planned shift end time in Kyiv timezone. Default: `21:00`.
- `vehicleId` (string, optional)
- `odometerStart` (number, optional)
- `lat` (number, optional)
- `lng` (number, optional)

### Behavior

- Finds active courier by `telegram_username`.
- If courier already has active shift -> error `409 Shift already started`.
- If no active shift -> creates new active shift.
- On creation, `ended_at` is set immediately using provided `endTime` (or `21:00` by default).

### Success response (`200`)

```json
{
  "success": true,
  "data": {
    "shiftId": "uuid",
    "courierId": "uuid",
    "courierName": "Courier Name",
    "telegramUsername": "andriyashh",
    "endedAt": "2026-03-24T18:00:00.000Z"
  }
}
```

### Common errors

- `400` -> `telegramUsername is required`
- `404` -> `Courier not found by telegram username`
- `409` -> `Shift already started`

---

## 2) Move shift end time

Use when courier finishes later and you need to move end time again.

### Request

- Method: `PATCH`
- URL: `https://sun-ways.vercel.app/api/public/shifts/by-telegram`

Body:

```json
{
  "telegramUsername": "@andriyashh",
  "endTime": "22:30"
}
```

### Fields

- `telegramUsername` (string, required)
- `endTime` (string, required, format `HH:mm`)

### Behavior

- Finds active shift for courier by `telegramUsername`.
- Updates `ended_at` for active shift.
- Can be called multiple times.

### Success response (`200`)

```json
{
  "success": true,
  "data": {
    "shiftId": "uuid",
    "courierId": "uuid",
    "courierName": "Courier Name",
    "telegramUsername": "andriyashh",
    "endedAt": "2026-03-24T19:30:00.000Z"
  }
}
```

### Common errors

- `400` -> `telegramUsername is required`
- `400` -> `endTime is required (HH:mm)`
- `404` -> `Courier not found by telegram username`
- `404` -> `Active shift not found`

---

## 3) Get vehicles list

### Request

- Method: `GET`
- URL: `https://sun-ways.vercel.app/api/public/vehicles`
- Query (optional): `activeOnly=1` or `activeOnly=true`

No body.

### Behavior

- Returns vehicles sorted by active first (`is_active desc`), then latest created.
- If `activeOnly` is set (`1` or `true`) -> returns only active vehicles.

### Success response (`200`)

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "plate_number": "AA1234BC",
      "brand": "Renault",
      "model": "Master",
      "type": "own",
      "is_active": true,
      "rent_until": null
    }
  ]
}
```

### Common errors

- `401` -> `Unauthorized`

---

## cURL examples

### Start shift

```bash
curl -X POST "https://sun-ways.vercel.app/api/public/shifts/by-telegram" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <SECRET>" \
  -d '{
    "telegramUsername": "@andriyashh",
    "vehicleId": "f9f43c4e-8a61-4b0f-b5d0-9d5f2f0c9c93",
    "odometerStart": 125430,
    "lat": 50.4501,
    "lng": 30.5234,
    "endTime": "21:00"
  }'
```

### Move shift end time

```bash
curl -X PATCH "https://sun-ways.vercel.app/api/public/shifts/by-telegram" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <SECRET>" \
  -d '{
    "telegramUsername": "@andriyashh",
    "endTime": "22:30"
  }'
```

### Get all vehicles

```bash
curl -X GET "https://sun-ways.vercel.app/api/public/vehicles" \
  -H "x-api-key: <SECRET>"
```

### Get only active vehicles

```bash
curl -X GET "https://sun-ways.vercel.app/api/public/vehicles?activeOnly=1" \
  -H "x-api-key: <SECRET>"
```
