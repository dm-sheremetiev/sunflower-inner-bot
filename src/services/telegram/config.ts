import { fileHelper } from "../../helpers/fileHelper.js";
import type { TelegramUserDatabase } from "../../types/telegram.js";

/** Env та константи для Telegram-бота */
export const sunflowerUsername = process?.env?.SUNFLOWER_USERNAME || "";
export const managerChanelChatId = process?.env?.MANAGER_CHANNELS_CHAT_ID || "";
export const botToken = process?.env.TELEGRAM_BOT_TOKEN || "";
export const forwardChatId = process?.env?.VIDEO_CHAT_ID || "";
export const isHoliday =
  (process?.env?.IS_HOLIDAY || "").toLowerCase() === "true";
export const productDeliveredStatus =
  process?.env?.PRODUCT_DELIVERED_STATUS || "23";
export const zReportChatId = process?.env?.Z_REPORT_CHAT_ID || "";
export const xReportChatId = process?.env?.X_REPORT_CHAT_ID || "";
export const xReportReminderChatId =
  process?.env?.X_REPORT_REMINDER_CHAT_ID || "";

export const deliveryRegex = /^[Дд]оставка \d+$/;

/** KeyCRM role_id — користувачі з цими ролями вважаються флористами для фільтра /my_orders. */
export const FLORIST_ROLE_IDS: readonly number[] = [11, 13, 4];

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
  if (!username?.trim()) {
    return false;
  }

  const needle = username.toLowerCase().trim();
  const users = fileHelper.loadUsers() as TelegramUserDatabase;

  for (const data of Object.values(users)) {
    const u = data.username?.toLowerCase().trim();
    if (u === needle && data.isCourier === true) return true;
  }
  return false;
}

export function isFloristRole(roleId: number | undefined): boolean {
  if (roleId == null) return false;
  return FLORIST_ROLE_IDS.includes(roleId);
}
