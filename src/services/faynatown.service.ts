import QRCode from "qrcode";
import dayjs from "dayjs";
import sharp from "sharp";
import { faynatownApiClient } from "../api/faynatownApiClient.js";
import type {
  AddCarPassBody,
  AddVisitorPassBody,
  HikVisionStatus,
  PassHistoryItem,
  PassHistoryQueryBody,
} from "../types/faynatown.js";

import "dotenv/config";

/** Нормалізує рядок з .env: прибирає BOM і розекрановані лапки \\" -> " */
const normalizeEnvJson = (raw: string): string => {
  let s = raw.trim().replace(/^\uFEFF/, "");
  if (s.includes('\\"')) {
    s = s.replace(/\\"/g, '"');
  }
  return s;
};

const defaultHikVisionStatuses = (): HikVisionStatus[] => {
  let raw = process.env.FAYNATOWN_HIKVISION_STATUSES;
  if (raw == null) return [];
  raw = normalizeEnvJson(raw);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as HikVisionStatus[];
  } catch {
    return [];
  }
};

/**
 * Повертає текст помилки налаштування FAYNATOWN_HIKVISION_STATUSES або null, якщо все ок.
 * Для виводу користувачу в Telegram.
 */
export const getFaynatownConfigError = (): string | null => {
  let raw = process.env.FAYNATOWN_HIKVISION_STATUSES;
  if (raw == null) {
    return "Змінна FAYNATOWN_HIKVISION_STATUSES відсутня або пуста в .env. Додайте JSON-масив комплексів.";
  }
  raw = normalizeEnvJson(raw);
  if (!raw) {
    return "Змінна FAYNATOWN_HIKVISION_STATUSES пуста після обробки.";
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return "FAYNATOWN_HIKVISION_STATUSES має бути JSON-масивом (наприклад [{ \"ComplexId\": 1, \"ComplexName\": \"Файна Таун\", \"HikvisionId\": \"160853\" }]).";
    }
    return null;
  } catch (e) {
    return `Помилка парсингу JSON у FAYNATOWN_HIKVISION_STATUSES: ${(e as Error).message}. Перевірте лапки та коми в .env.`;
  }
};

/** Чи налаштовано FAYNATOWN_HIKVISION_STATUSES у .env */
export const isFaynatownPassConfigured = (): boolean => {
  return defaultHikVisionStatuses().length > 0;
};

/**
 * Додати посетителя (проходку).
 */
export const addVisitorPass = async (
  body: AddVisitorPassBody
): Promise<unknown> => {
  const { data } = await faynatownApiClient.post("/api/acs/addVisitorPass", body);
  return data;
};

/**
 * Додати авто-перепустку. Повертає true/false з API.
 */
export const addCarPass = async (body: AddCarPassBody): Promise<boolean> => {
  const { data } = await faynatownApiClient.post<boolean>("/api/acs/addCarPass", body);
  return data === true;
};

/**
 * Отримати історію проходок (query).
 * Підтримує відповідь у вигляді масиву або { data: [...] }.
 */
export const getPassHistory = async (
  query: PassHistoryQueryBody
): Promise<PassHistoryItem[]> => {
  const res = await faynatownApiClient.post<PassHistoryItem[] | { data: PassHistoryItem[] }>(
    "/api/acs/passHistory/query",
    query
  );
  const data = res.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && "data" in data && Array.isArray((data as { data: PassHistoryItem[] }).data)) {
    return (data as { data: PassHistoryItem[] }).data;
  }
  return [];
};

/**
 * Остання створена проходка (сортування за created_at або startTime desc).
 * complexId: 1 = Файна Таун, 2 = Республіка; якщо не передано — з усіх комплексів.
 */
export const getLatestPass = async (
  complexId?: number
): Promise<PassHistoryItem | null> => {
  const HikVisionStatuses = defaultHikVisionStatuses();
  if (HikVisionStatuses.length === 0) return null;

  const list = await getPassHistory({
    HikVisionStatuses,
    PassType: 2,
    Offset: 0,
    Limit: 100,
    Filter: null,
  });

  let filtered = list;
  if (complexId != null) {
    filtered = list.filter((p) => p.complexId === complexId);
  }
  if (filtered.length === 0) return null;

  const sorted = [...filtered].sort((a, b) => {
    const createdA = a.created_at ? new Date(a.created_at).getTime() : NaN;
    const createdB = b.created_at ? new Date(b.created_at).getTime() : NaN;
    if (!Number.isNaN(createdA) && !Number.isNaN(createdB)) {
      return createdB - createdA;
    }
    const tA = new Date(a.startTime).getTime();
    const tB = new Date(b.startTime).getTime();
    return tB - tA;
  });
  return sorted[0] ?? null;
};

const MAX_PASSES = 5;

/** Екранування тексту для SVG */
const escapeSvgText = (text: string): string => {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
};

/** Формат дати DD.MM.YYYY HH:mm для підпису під QR */
const formatPassDateForCaption = (iso: string): string => {
  const d = new Date(iso);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${day}.${month}.${year} ${h}:${m}`;
};

/**
 * Додати під QR плашку як у додатку: ЖК, період дії перепустки, дати.
 * Рядок 1 — жирний темно-синій, решта — звичайний темно-сірий.
 */
const addCaptchaToQrImage = async (
  qrBuffer: Buffer,
  pass: { complexName: string; startTime: string; endTime: string }
): Promise<Buffer> => {
  const base = sharp(qrBuffer);
  const metadata = await base.metadata();
  const width = metadata.width ?? 300;
  const height = metadata.height ?? 300;

  const captionHeight = 110;
  const titleSize = 20;
  const textSize = 14;

  const name = `ЖК ${pass.complexName}`;
  const label = "Період дії перепустки";
  const from = formatPassDateForCaption(pass.startTime);
  const to = formatPassDateForCaption(pass.endTime);

  const y1 = 26;
  const y2 = 50;
  const y3 = 74;
  const y4 = 98;

  const svg = `
<svg width="${width}" height="${captionHeight}" xmlns="http://www.w3.org/2000/svg">
  <style>
    .title { fill: #1a237e; font-size: ${titleSize}px; font-weight: bold; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .text { fill: #37474f; font-size: ${textSize}px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  </style>
  <rect width="100%" height="100%" fill="#ffffff" />
  <text x="50%" y="${y1}" text-anchor="middle" class="title">${escapeSvgText(name)}</text>
  <text x="50%" y="${y2}" text-anchor="middle" class="text">${escapeSvgText(label)}</text>
  <text x="50%" y="${y3}" text-anchor="middle" class="text">${escapeSvgText(from)}</text>
  <text x="50%" y="${y4}" text-anchor="middle" class="text">${escapeSvgText(to)}</text>
</svg>`;

  const captionPng = await sharp(Buffer.from(svg)).png().toBuffer();

  const extended = await base
    .extend({
      top: 0,
      bottom: captionHeight,
      left: 0,
      right: 0,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .composite([{ input: captionPng, top: height, left: 0 }])
    .png()
    .toBuffer();

  return extended;
};

/**
 * Останні N проходок (1–5), сортування за created_at/startTime desc.
 */
export const getLatestPasses = async (
  complexId?: number,
  limit: number = 1
): Promise<PassHistoryItem[]> => {
  const HikVisionStatuses = defaultHikVisionStatuses();
  if (HikVisionStatuses.length === 0) return [];

  const list = await getPassHistory({
    HikVisionStatuses,
    PassType: 2,
    Offset: 0,
    Limit: 100,
    Filter: null,
  });

  let filtered = list;
  if (complexId != null) {
    filtered = list.filter((p) => p.complexId === complexId);
  }
  if (filtered.length === 0) return [];

  const sorted = [...filtered].sort((a, b) => {
    const createdA = a.created_at ? new Date(a.created_at).getTime() : NaN;
    const createdB = b.created_at ? new Date(b.created_at).getTime() : NaN;
    if (!Number.isNaN(createdA) && !Number.isNaN(createdB)) {
      return createdB - createdA;
    }
    const tA = new Date(a.startTime).getTime();
    const tB = new Date(b.startTime).getTime();
    return tB - tA;
  });
  const n = Math.min(Math.max(1, limit), MAX_PASSES);
  return sorted.slice(0, n);
};

/**
 * Останні N проходок (1–5) з QR для відправки в чат.
 */
export const getLatestPassesWithQr = async (
  complexId?: number,
  count: number = 1
): Promise<{ pass: PassHistoryItem; qrBuffer: Buffer }[]> => {
  const passes = await getLatestPasses(complexId, count);
  const out: { pass: PassHistoryItem; qrBuffer: Buffer }[] = [];
  for (const pass of passes) {
    if (!pass.barCode) continue;
    const qrBase = await generateQrFromBarCode(pass.barCode);
    const qrBuffer = await addCaptchaToQrImage(qrBase, pass);
    out.push({ pass, qrBuffer });
  }
  return out;
};

/** resident_id за complexId з FAYNATOWN_HIKVISION_STATUSES */
function getResidentIdByComplexId(complexId: number): string | null {
  const statuses = defaultHikVisionStatuses();
  const s = statuses.find((x) => x.ComplexId === complexId);
  return s?.HikvisionId ?? null;
}

/** PassType для авто-перепусток */
const CAR_PASS_TYPE = 1;

/**
 * Останні N авто-перепусток (1–30), PassType 1, сортування за startTime desc.
 */
export const getLatestCarPasses = async (
  complexId?: number,
  limit: number = 10
): Promise<PassHistoryItem[]> => {
  const HikVisionStatuses = defaultHikVisionStatuses();
  if (HikVisionStatuses.length === 0) return [];

  const list = await getPassHistory({
    HikVisionStatuses,
    PassType: CAR_PASS_TYPE,
    Offset: 0,
    Limit: 30,
    Filter: null,
  });

  let filtered = list;
  if (complexId != null) {
    filtered = list.filter((p) => p.complexId === complexId);
  }
  if (filtered.length === 0) return [];

  const sorted = [...filtered].sort((a, b) => {
    const createdA = a.created_at ? new Date(a.created_at).getTime() : NaN;
    const createdB = b.created_at ? new Date(b.created_at).getTime() : NaN;
    if (!Number.isNaN(createdA) && !Number.isNaN(createdB)) {
      return createdB - createdA;
    }
    const tA = new Date(a.startTime).getTime();
    const tB = new Date(b.startTime).getTime();
    return tB - tA;
  });
  const n = Math.min(Math.max(1, limit), 30);
  return sorted.slice(0, n);
};

/**
 * Зібрати тіло запиту для addCarPass: період з now до +24 год.
 */
export const buildAddCarPassBody = (
  plateNo: string,
  complexId: number,
  residentId: string,
  driverInfo: string = "Гість"
): AddCarPassBody => {
  const start = dayjs();
  const end = dayjs().add(24, "hour");
  return {
    plate_no: plateNo.trim().toUpperCase(),
    driver_info: driverInfo,
    resident_id: residentId,
    TimeYearStart: start.year(),
    TimeMonthStart: start.month() + 1,
    TimeDayStart: start.date(),
    TimeHourStart: start.hour(),
    TimeMinutesStart: start.minute(),
    TimeYearEnd: end.year(),
    TimeMonthEnd: end.month() + 1,
    TimeDayEnd: end.date(),
    TimeHourEnd: end.hour(),
    TimeMinutesEnd: end.minute(),
    TimeStart: start.toISOString(),
    TimeEnd: end.toISOString(),
    driver_phone: "",
    ComplexId: complexId,
  };
};

/**
 * Додати одну авто-перепустку для філії (період 24 год з поточного моменту).
 */
export const createCarPass = async (
  complexId: number,
  plateNo: string
): Promise<boolean> => {
  const residentId = getResidentIdByComplexId(complexId);
  if (!residentId) {
    throw new Error(`Немає resident_id для complexId ${complexId} у FAYNATOWN_HIKVISION_STATUSES`);
  }
  const body = buildAddCarPassBody(plateNo, complexId, residentId);
  return addCarPass(body);
};

/**
 * Створити N проходок (1–5) для філії. visitor_name = "Відвідувач" + випадкове 3-значне число.
 */
export const createVisitorPasses = async (
  complexId: number,
  count: number
): Promise<unknown[]> => {
  const residentId = getResidentIdByComplexId(complexId);
  if (!residentId) {
    throw new Error(`Немає resident_id для complexId ${complexId} у FAYNATOWN_HIKVISION_STATUSES`);
  }
  const n = Math.min(Math.max(1, count), MAX_PASSES);
  const timeVisit = dayjs().format("YYYY-MM-DD HH:mm:ss");
  const timeLeave = dayjs().add(24, "hour").format("YYYY-MM-DD HH:mm:ss");
  const results: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const visitorName = `Відвідувач ${100 + Math.floor(Math.random() * 900)}`;
    const body: AddVisitorPassBody = {
      visitor_name: visitorName,
      resident_id: residentId,
      complex_id: complexId,
      time_visit: timeVisit,
      time_leave: timeLeave,
      purpose: "no data",
      visitor_num: 1,
    };
    const data = await addVisitorPass(body);
    results.push(data);
  }
  return results;
};

/**
 * Згенерувати QR-зображення з баркоду (PNG buffer).
 */
export const generateQrFromBarCode = async (
  barCode: string
): Promise<Buffer> => {
  return await QRCode.toBuffer(barCode, {
    type: "png",
    margin: 2,
    width: 300,
  });
};

/**
 * Отримати останню проходку та буфер QR по barCode.
 * complexId: 1 = Файна Таун, 2 = Республіка; не передано — з усіх комплексів.
 */
export const getLatestPassWithQr = async (
  complexId?: number
): Promise<{
  pass: PassHistoryItem;
  qrBuffer: Buffer;
} | null> => {
  const pass = await getLatestPass(complexId);
  if (!pass?.barCode) return null;
  const qrBase = await generateQrFromBarCode(pass.barCode);
  const qrBuffer = await addCaptchaToQrImage(qrBase, pass);
  return { pass, qrBuffer };
};

/** complexId за назвою філії (республіка / файна) */
export const parseFaynatownBranch = (text: string): number | undefined => {
  const t = text.trim().toLowerCase();
  if (t.includes("республік") || t === "республіка" || t === "2") return 2;
  if (t.includes("файна") || t === "файна" || t === "1") return 1;
  return undefined;
};
