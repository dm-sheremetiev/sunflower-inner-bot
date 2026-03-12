/** Env та константи для Telegram-бота */
export const sunflowerUsername = process?.env?.SUNFLOWER_USERNAME || "";
export const managerChanelChatId =
  process?.env?.MANAGER_CHANNELS_CHAT_ID || "";
export const couriers = process?.env?.COURIERS || "";
export const botToken = process?.env.TELEGRAM_BOT_TOKEN || "";
export const forwardChatId = process?.env?.VIDEO_CHAT_ID || "";
export const isHoliday =
  (process?.env?.IS_HOLIDAY || "").toLowerCase() === "true";
export const productDeliveredStatus =
  process?.env?.PRODUCT_DELIVERED_STATUS || "23";
export const zReportChatId = process?.env?.Z_REPORT_CHAT_ID || "";
export const xReportChatId = process?.env?.X_REPORT_CHAT_ID || "";

export const deliveryRegex = /^[Дд]оставка \d+$/;
export const couriersList = couriers
  .split(",")
  .map((c) => c.toLowerCase().trim())
  .filter(Boolean);

export const STUDIOS = ["файна", "француз", "севен"];
export const STATUSES = ["зелений", "жовтий", "червоний"];

export const COLOR_MAP: Record<string, string> = {
  зелений: "green",
  жовтий: "yellow",
  червоний: "red",
};

export const BRANCH_MAP: Record<string, string> = {
  файна: "faina",
  француз: "francuz",
  севен: "seven",
};

export const tz = "Europe/Kyiv";

export function isCourier(username: string): boolean {
  return couriersList.includes(username.toLowerCase());
}
