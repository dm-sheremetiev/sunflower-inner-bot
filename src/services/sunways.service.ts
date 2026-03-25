import axios from "axios";

type SunwaysVehicle = {
  id: string;
  label: string;
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
    endedAt?: string;
  };
  message?: string;
};

const SUNWAYS_API_BASE_URL =
  process?.env?.SUNWAYS_API_BASE_URL ||
  "https://sun-ways.vercel.app/api/public/shifts/by-telegram";
const SUNWAYS_VEHICLES_API_URL =
  process?.env?.SUNWAYS_VEHICLES_API_URL ||
  "https://sun-ways.vercel.app/api/public/vehicles";
const SUNWAYS_API_KEY = process?.env?.PUBLIC_SHIFT_API_KEY || "";
const SUNWAYS_SHIFT_END_TIME =
  process?.env?.SUNWAYS_SHIFT_END_TIME || "21:00";
const SUNWAYS_AUTO_CLOSE_SHIFTS_URL =
  process?.env?.SUNWAYS_AUTO_CLOSE_SHIFTS_URL ||
  "https://sun-ways.vercel.app/api/cron/auto-close-shifts";
// For cron endpoint we use the same secret as for other SunWays public requests
// unless you explicitly override it.
const SUNWAYS_CRON_SECRET =
  process?.env?.SUNWAYS_CRON_SECRET || SUNWAYS_API_KEY;

export function getSunwaysConfigError(): string | null {
  if (!SUNWAYS_API_KEY) {
    return "Не налаштовано інтеграцію Sunways: відсутній PUBLIC_SHIFT_API_KEY.";
  }
  if (!SUNWAYS_API_BASE_URL) {
    return "Не налаштовано інтеграцію Sunways: відсутній SUNWAYS_API_BASE_URL.";
  }
  if (!SUNWAYS_VEHICLES_API_URL) {
    return "Не налаштовано інтеграцію Sunways: відсутній SUNWAYS_VEHICLES_API_URL.";
  }
  return null;
}

function normalizeTelegramUsername(username: string): string {
  const clean = username.trim().replace(/^@+/, "");
  return `@${clean.toLowerCase()}`;
}

function mapSunwaysError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = error.response?.data as { message?: string } | undefined;
    const apiMessage = (data?.message || "").toLowerCase();

    if (status === 404) {
      if (apiMessage.includes("active shift")) {
        return "Активну зміну не знайдено.";
      }
      return "Кур'єра не знайдено за telegram username.";
    }
    if (status === 409) {
      if (apiMessage.includes("vehicle") && (apiMessage.includes("busy") || apiMessage.includes("занят"))) {
        return "Авто зайняте іншою активною зміною.";
      }
      if (
        apiMessage.includes("shift") &&
        (apiMessage.includes("already") ||
          apiMessage.includes("started") ||
          apiMessage.includes("розпочато"))
      ) {
        return "Зміну вже розпочато.";
      }
      return "Неможливо виконати операцію (конфлікт стану зміни).";
    }
    if (status === 401) {
      return "Помилка авторизації Sunways API.";
    }
    if (status === 400) {
      return data?.message || "Некоректні дані для Sunways API.";
    }
  }

  return error instanceof Error ? error.message : String(error);
}

function toVehicleLabel(vehicle: SunwaysVehicleApiItem): string {
  const plate = (vehicle.plate_number ?? "").trim();
  const brand = (vehicle.brand ?? "").trim();
  const model = (vehicle.model ?? "").trim();
  const body = [brand, model].filter(Boolean).join(" ");
  if (plate && body) return `${plate} (${body})`;
  if (plate) return plate;
  if (body) return body;
  return "Авто";
}

export async function getSunwaysVehicles(): Promise<
  { ok: true; data: SunwaysVehicle[] } | { ok: false; message: string }
> {
  try {
    const res = await axios.get<{ success: boolean; data?: SunwaysVehicleApiItem[] }>(
      SUNWAYS_VEHICLES_API_URL,
      {
        params: { activeOnly: 1 },
        headers: {
          "x-api-key": SUNWAYS_API_KEY,
          Accept: "application/json",
        },
        timeout: 30000,
      },
    );

    const list = (res.data?.data ?? [])
      .filter((v) => typeof v?.id === "string" && v.id.trim().length > 0)
      .map((v) => ({
        id: v.id.trim(),
        label: toVehicleLabel(v),
      }));

    return { ok: true, data: list };
  } catch (error) {
    return { ok: false, message: mapSunwaysError(error) };
  }
}

export async function startSunwaysShift(payload: {
  telegramUsername: string;
  vehicleId: string;
  odometerStart: number;
  lat: number;
  lng: number;
}): Promise<{ ok: true; endedAt?: string } | { ok: false; message: string }> {
  try {
    const res = await axios.post<SunwaysApiSuccess>(
      SUNWAYS_API_BASE_URL,
      {
        telegramUsername: normalizeTelegramUsername(payload.telegramUsername),
        vehicleId: payload.vehicleId,
        odometerStart: payload.odometerStart,
        lat: payload.lat,
        lng: payload.lng,
      },
      {
        headers: {
          "x-api-key": SUNWAYS_API_KEY,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      },
    );

    return { ok: true, endedAt: res.data?.data?.endedAt };
  } catch (error) {
    return { ok: false, message: mapSunwaysError(error) };
  }
}

export async function finishSunwaysShift(
  telegramUsername: string,
  odometerEnd: number,
): Promise<
  { ok: true; endedAt?: string } | { ok: false; message: string }
> {
  try {
    const res = await axios.patch<SunwaysApiSuccess>(
      SUNWAYS_API_BASE_URL,
      {
        telegramUsername: normalizeTelegramUsername(telegramUsername),
        endTime: SUNWAYS_SHIFT_END_TIME,
        odometerEnd,
      },
      {
        headers: {
          "x-api-key": SUNWAYS_API_KEY,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      },
    );

    return { ok: true, endedAt: res.data?.data?.endedAt };
  } catch (error) {
    return { ok: false, message: mapSunwaysError(error) };
  }
}

export async function cancelSunwaysShift(telegramUsername: string): Promise<
  { ok: true } | { ok: false; message: string }
> {
  try {
    await axios.delete(SUNWAYS_API_BASE_URL, {
      data: {
        telegramUsername: normalizeTelegramUsername(telegramUsername),
      },
      headers: {
        "x-api-key": SUNWAYS_API_KEY,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });

    return { ok: true };
  } catch (error) {
    return { ok: false, message: mapSunwaysError(error) };
  }
}

type SunwaysAutoCloseResponse = {
  success: boolean;
  processedDateKyiv: string;
  autoClosed: number;
  skippedAlreadyClosed: number;
};

export async function triggerSunwaysAutoCloseShifts(): Promise<SunwaysAutoCloseResponse> {
  if (!SUNWAYS_CRON_SECRET) {
    throw new Error("CRON_SECRET is not configured");
  }

  const { data } = await axios.post<SunwaysAutoCloseResponse>(
    SUNWAYS_AUTO_CLOSE_SHIFTS_URL,
    {},
    {
      headers: {
        Authorization: `Bearer ${SUNWAYS_CRON_SECRET}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    },
  );

  return data;
}
