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
  // React only in direct chats with the bot.
  if (ctx.chat && ctx.chat.type !== "private") return;

  const chatId = ctx.from?.id;
  if (!chatId) return next();

  const safeAnswerCallback = async (text: string) => {
    if (!ctx.callbackQuery) return;
    try {
      await ctx.answerCallbackQuery({ text });
    } catch {
      // ignore
    }
  };

  const { isAuth, user } = isUserAuthenticated(chatId);
  const isStartCommand = !!ctx.message?.text?.startsWith("/start");

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
      await safeAnswerCallback("Потрібна авторизація");
      return;
    }

    const loadingMsg = await ctx.reply("Перевірка доступу...");
    
    // Для /start не використовуємо text="/start" як логін — пробуємо по username.
    const authText = isStartCommand ? undefined : text;
    const result = await processAuthentication(chatId, username, authText, contact);

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
      await safeAnswerCallback("Готово");
      // Якщо це /start — дати пройти хендлеру, щоб він показав наступні дії.
      if (isStartCommand) return next();
      // Якщо це ввід логіну/телефону — не проганяємо далі як команду.
      return;
    } else {
      await ctx.reply(result.message, { reply_markup: { remove_keyboard: true } });
      await safeAnswerCallback("Доступ не надано");
      return;
    }
  }

  // Check expiration (every 3 days)
  const verification = await verifyUserAccess(chatId);
  if (!verification.isValid) {
      await ctx.reply("Термін перевірки минув або доступ відхилено.", { reply_markup: { remove_keyboard: true } });
      await safeAnswerCallback("Доступ відхилено");
      return;
  }

  return next();
};
