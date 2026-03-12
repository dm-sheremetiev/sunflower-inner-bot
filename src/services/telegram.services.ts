/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Context } from "grammy";
import { Bot, Api, GrammyError, HttpError, RawApi } from "grammy";
import { isCourier } from "./telegram/config.js";
import {
  sendTelegramMessage,
  sendTelegramMessageToMainAccount,
  sendTelegramMessageToNotificationsChanel,
} from "./telegram/telegramApi.js";
import {
  handleVideoMessage,
  handlePhotoMessage,
  forwardReport,
} from "./telegram/videoPhoto.handler.js";
import { registerReportWizard } from "./telegram/reportWizard.handler.js";
import { registerVideoPhotoHandlers } from "./telegram/videoPhoto.handler.js";
import { registerOrderHandlers } from "./telegram/orders.handler.js";
import { registerFaynatownHandlers } from "./telegram/faynatown.handler.js";
import { registerStudioHandler } from "./telegram/studio.handler.js";

export { isCourier };
export { sendTelegramMessage };
export { sendTelegramMessageToMainAccount };
export { sendTelegramMessageToNotificationsChanel };
export { handleVideoMessage };
export { handlePhotoMessage };
export { forwardReport };

export function initializeBot(): Bot<Context, Api<RawApi>> {
  const bot = new Bot(process?.env.TELEGRAM_BOT_TOKEN || "");

  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}`);
    const e = err.error;

    if (e instanceof GrammyError) {
      console.error("Error in request: ", e.description);
      ctx.reply(`Error in request: ${e.description}`).catch(() => {
        console.error("Ошибка отправки сообщения в чат");
      });
    } else if (e instanceof HttpError) {
      console.error("Could not contact Telegram: ", e);
      ctx.reply(`Could not contact Telegram ${e}`).catch(() => {
        console.error("Ошибка отправки сообщения в чат");
      });
    } else {
      console.error("Unknown error: ", e);
      ctx.reply(`Unknown error: ${e}`).catch(() => {
        console.error("Ошибка отправки сообщения в чат");
      });
    }
  });

  bot.api.setMyCommands([
    { command: "start", description: "Запуск бота" },
    { command: "my_orders", description: "Номери моїх замовлення" },
    { command: "report", description: "Відправити звіт (X або Z)" },
  ]);

  registerReportWizard(bot);
  registerVideoPhotoHandlers(bot);
  registerOrderHandlers(bot);
  registerFaynatownHandlers(bot);
  registerStudioHandler(bot);

  return bot;
}
