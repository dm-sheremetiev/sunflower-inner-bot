import { Context, NextFunction } from "grammy";
import {
  isUserAuthenticated,
  processAuthentication,
  verifyUserAccess,
} from "../services/telegram/auth.service.js";

export const authMiddleware = async (
  ctx: Context,
  next: NextFunction,
) => {
  const chatId = ctx.from?.id;
  if (!chatId) return next();

  // Allow /start command to pass through
  if (ctx.message?.text?.startsWith("/start")) {
    return next();
  }

  const { isAuth, user } = isUserAuthenticated(chatId);

  // Try authenticating if not authenticated
  if (!isAuth) {
    const contact = ctx.message?.contact;
    const text = ctx.message?.text;
    const username = ctx.from?.username;

    // Only attempt auth if they sent text/contact OR have username in context
    if (!text && !contact && !username) {
      const isFirstInteraction = !user;
      if (isFirstInteraction) {
        await ctx.reply(
          "Привіт! Якщо у вас є username в Telegram — ми спробуємо авторизувати вас автоматично. Інакше поділіться контактом або введіть ваш логін (username) чи номер телефону текстом.",
          {
            reply_markup: {
              keyboard: [[{ text: "Поділитися контактом", request_contact: true }]],
              resize_keyboard: true,
              one_time_keyboard: true,
            },
          },
        );
      } else {
        await ctx.reply(
          "Доступ не надано. Введіть логін (username) або відправте контакт.",
          { reply_markup: { remove_keyboard: true } },
        );
      }
      return;
    }

    const loadingMsg = await ctx.reply("Перевірка доступу...");
    
    const result = await processAuthentication(chatId, username, text, contact);

    try {
      const chatToDelete = ctx.chat?.id ?? chatId;
      await ctx.api.deleteMessage(chatToDelete, loadingMsg.message_id);
    } catch {
      // ignore
    }

    if (result.success) {
      await ctx.reply(result.message, {
        reply_markup: { remove_keyboard: true },
      });
      // Don't next() if they just typed their login, as it's not a real command
      return;
    } else {
      await ctx.reply(result.message, { reply_markup: { remove_keyboard: true } });
      return;
    }
  }

  // Check expiration (every 3 days)
  const verification = await verifyUserAccess(chatId);
  if (!verification.isValid) {
      await ctx.reply("Термін перевірки минув або доступ відхилено.", { reply_markup: { remove_keyboard: true } });
      return;
  }

  return next();
};
