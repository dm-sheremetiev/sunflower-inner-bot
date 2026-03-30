import cron from "node-cron";
import { sendTelegramMessage } from "../services/telegram/telegramApi.js";
import { xReportReminderChatId } from "../services/telegram/config.js";

const REMINDER_TEXT =
  "Нагадування - час відправити X-звіт через бота.\nПоставте реакцію на це повідомлення, якщо побачили.";

export const scheduleXReportReminderCronJobs = () => {
  if (!xReportReminderChatId) {
    console.log(
      "[CRON] X-report reminder disabled: X_REPORT_REMINDER_CHAT_ID is not set",
    );
    return;
  }

  cron.schedule(
    "0 12,16,20 * * *",
    async () => {
      try {
        await sendTelegramMessage(xReportReminderChatId, REMINDER_TEXT);
        console.log("[CRON] X-report reminder sent");
      } catch (error) {
        console.error("[CRON] X-report reminder error:", error);
      }
    },
    { timezone: "Europe/Kyiv" },
  );

  console.log(
    "[CRON] X-report reminders scheduled at 12:00, 16:00, 20:00 Kyiv",
  );
};
