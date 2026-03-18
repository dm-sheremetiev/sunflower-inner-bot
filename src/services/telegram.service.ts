import type { Context } from "grammy";
import { Bot, Api, GrammyError, HttpError, RawApi } from "grammy";
import { isCourier } from "./telegram/config.js";
import {
  sendTelegramMessage,
  sendTelegramMessageToMainAccount,
  sendTelegramMessageToNotificationsChanel,
} from "./telegram/telegramApi.js";
import { registerReportWizard } from "../handlers/telegram/reportWizard.handler.js";
import { registerVideoPhotoHandlers } from "../handlers/telegram/videoPhoto.handler.js";
import { registerOrderHandlers } from "../handlers/telegram/orders.handler.js";
import { registerFaynatownHandlers } from "../handlers/telegram/faynatown.handler.js";
import { registerStudioHandler } from "../handlers/telegram/studio.handler.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

export { isCourier };
export { sendTelegramMessage };
export { sendTelegramMessageToMainAccount };
export { sendTelegramMessageToNotificationsChanel };

export function initializeBot(): Bot<Context, Api<RawApi>> {
  const bot = new Bot(process?.env.TELEGRAM_BOT_TOKEN || "");

  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}`);
    const e = err.error;

    if (e instanceof GrammyError) {
      console.error("Error in request: ", e.description);
      console.error("Payload that failed:", e.method, JSON.stringify(e.payload, null, 2));
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
    { command: "my_orders", description: "Номери моїх замовлення" },
    { command: "report", description: "Відправити звіт (X або Z)" },
  ]);

  bot.use(authMiddleware);

  registerReportWizard(bot);
  registerVideoPhotoHandlers(bot);
  registerOrderHandlers(bot);
  registerFaynatownHandlers(bot);
  registerStudioHandler(bot);

  return bot;
}
