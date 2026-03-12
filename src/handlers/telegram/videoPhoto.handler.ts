/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Context } from "grammy";
import { Bot, Api, RawApi } from "grammy";
import { keycrmApiClient } from "../../api/keycrmApiClient.js";
import { Order } from "../../types/keycrm.js";
import { fileHelper } from "../../helpers/fileHelper.js";
import { TelegramUserDatabase } from "../../types/telegram.js";
import { changeOrderStatus } from "../../services/keycrm.service.js";
import {
  isCourier,
  forwardChatId,
  isHoliday,
  productDeliveredStatus,
  deliveryRegex,
} from "./config.js";
import {
  cleanupExpiredReportSessions,
  getReportSteps,
  reportSessions,
  startReportSession,
  sendNextReportStep,
  type ReportType,
} from "./reportWizard.handler.js";
import {
  sendTelegramMessage,
  sendTelegramMessageToMainAccount,
} from "./telegramApi.js";

const albumBuffer = new Map<
  string,
  { messages: Context["message"][]; timeout: NodeJS.Timeout }
>();

export async function forwardReport(
  bot: Bot,
  chatToForward: string,
  fromChatId: string | number,
  messageId: number,
): Promise<void> {
  try {
    await bot.api.forwardMessage(chatToForward, fromChatId, messageId || 0);
  } catch (error) {
    console.error(error);
  }
}

export async function handleVideoMessage(
  ctx: Context,
  bot: Bot<Context, Api<RawApi>>,
): Promise<void> {
  const caption = ctx?.message?.caption || "";

  if (!ctx?.from?.username) {
    await ctx.reply(
      "Наш бот не бачить твій nickname (ім'я користувача після @). Зміни будь ласка налаштування безпеки та спробуй наново (наново введи команду /start).",
    );
    return;
  }

  if (caption && deliveryRegex.test(caption.trim())) {
    try {
      const orderId = caption.trim().split(" ")[1].trim();

      const res = await keycrmApiClient.get<Order>(
        `order/${+orderId}?include=manager,assigned`,
      );

      if (!res.data) {
        await ctx.reply(
          "Такого замовлення не існує, перевірте будь ласка номер замовлення та спробуйте ще раз.",
        );
        return;
      }

      const { data: order } = res;

      if (!isHoliday && !isCourier(ctx.from.username)) {
        await ctx.reply("Вибачте, цей функціонал доступний тільки кур'єрам.");
        return;
      }

      if (!isHoliday && !res.data?.assigned?.length) {
        await ctx.reply(
          "На це замовлення спершу треба призначити відповідальних.",
        );
        return;
      }

      const promises = [
        forwardReport(
          bot,
          forwardChatId,
          ctx?.chat?.id || "",
          ctx?.message?.message_id || 0,
        ),
        changeOrderStatus(orderId, productDeliveredStatus),
      ];
      const results = await Promise.allSettled(promises);

      const managerUsername = order.manager.username;
      const users = fileHelper.loadUsers();
      const userEntry = Object.entries(users).find(
        ([, user]) =>
          (user as TelegramUserDatabase)?.username === managerUsername,
      )?.[0];

      let messageForCourier = "";
      let messageForManager = "";

      const forwardResultError = results[0].status === "rejected";
      const statusResultError = results[1].status === "rejected";

      if (forwardResultError) {
        messageForCourier =
          "Сталася якась помилка при пересилці відео у групу. Спробуйте це зробити власноруч.";
      } else {
        messageForCourier =
          "Дякуємо за вашу роботу. Повідомлення було відправлено у групу.";
      }

      if (statusResultError) {
        messageForManager = `Кур'єр доставив замовлення №${orderId}, однак воно не було переведено по статусу далі. Перевірте будь ласка у CRM.`;
        messageForCourier +=
          " Статус замовлення не був змінений у системі. Напишіть менеджеру.";
      } else {
        messageForManager = `Замовлення №${orderId} було доставлено. Статус замовлення було змінено.`;
      }

      await ctx.reply(messageForCourier);

      const managerChatId = userEntry;
      if (managerChatId) {
        await sendTelegramMessage(managerChatId, messageForManager);
      } else {
        await sendTelegramMessageToMainAccount(messageForManager);
      }
    } catch (error: any) {
      if (error?.status && error?.status === 404) {
        await ctx.reply(
          "Такого замовлення не існує, перевірте будь ласка номер замовлення та спробуйте ще раз.",
        );
        return;
      }
      console.log(error);
      await ctx.reply(
        "Сталася якась помилка при пересилці відео у групу. Спробуйте це зробити власноруч.",
      );
    }
  } else {
    await ctx.reply(
      "Суворий формат тексту: `Доставка 0000` , де 0000 це номер замовлення",
      { parse_mode: "Markdown" },
    );
  }
}

async function processAlbumMessages(
  ctx: Context,
  messages: Context["message"][],
  bot: Bot<Context>,
  zReportChatId: string,
  xReportChatId: string,
): Promise<void> {
  const firstMessage = messages[0];
  const caption = firstMessage?.caption || "";

  if (!firstMessage?.from?.username) {
    await ctx.reply(
      "Наш бот не бачить твій nickname (ім'я користувача після @). Змініть налаштування безпеки та спробуйте ще раз (/start).",
    );
    return;
  }

  if (!caption.trim().length) return;

  const reportType = caption.trim().split(" ")[0].toLowerCase();
  const media = messages
    .map((msg, index) => {
      const photoSizes = msg?.photo;
      if (!photoSizes || photoSizes.length === 0) return null;
      const fileId = photoSizes[photoSizes.length - 1].file_id;
      const photoCaption =
        index === 0
          ? `Звіт від @${msg?.from?.username}\n${caption}`
          : undefined;
      return { type: "photo" as const, media: fileId, caption: photoCaption };
    })
    .filter((item) => item !== null) as {
    type: "photo";
    media: string;
    caption?: string;
  }[];

  if (media.length === 0) return;
  try {
    if (reportType.includes("z")) {
      await bot.api.sendMediaGroup(zReportChatId, media);
      for (const msg of messages) {
        if (msg) await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
      }
      await ctx.reply("Ваш Z-звіт було успішно відправлено.");
      return;
    }
    if (reportType.includes("x") || reportType.includes("х")) {
      await bot.api.sendMediaGroup(xReportChatId, media);
      for (const msg of messages) {
        if (msg) await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
      }
      await ctx.reply("Ваш Х-звіт було успішно відправлено.");
    }
  } catch (error: any) {
    await ctx.reply(
      "Сталася якась помилка. Напишіть керуючому. " + JSON.stringify(error),
    );
  }
}

async function processSinglePhoto(
  ctx: Context,
  bot: Bot<Context>,
  zReportChatId: string,
  xReportChatId: string,
): Promise<void> {
  const caption = ctx.message?.caption || "";

  if (!ctx.from?.username) {
    await ctx.reply(
      "Наш бот не бачить твій nickname (ім'я користувача після @). Змініть налаштування безпеки та спробуйте ще раз (/start).",
    );
    return;
  }

  if (!caption.trim().length) return;

  const reportType = caption.trim().split(" ")[0].toLowerCase();
  const photoSizes = ctx.message?.photo;
  if (!photoSizes || photoSizes.length === 0) return;
  const fileId = photoSizes[photoSizes.length - 1].file_id;
  const newCaption = `Звіт від @${ctx.from.username}\n${caption}`;

  try {
    if (reportType.includes("z")) {
      await bot.api.sendPhoto(zReportChatId, fileId, { caption: newCaption });
      await ctx.deleteMessage();
      await ctx.reply("Ваш Z-звіт було успішно відправлено.");
      return;
    }
    if (reportType.includes("x") || reportType.includes("х")) {
      await bot.api.sendPhoto(xReportChatId, fileId, { caption: newCaption });
      await ctx.deleteMessage();
      await ctx.reply("Ваш Х-звіт було успішно відправлено.");
    }
  } catch (error: any) {
    await ctx.reply(
      "Сталася якась помилка. Напишіть керуючому. " + JSON.stringify(error),
    );
  }
}

export async function handlePhotoMessage(
  ctx: Context,
  bot: Bot<Context, Api<RawApi>>,
): Promise<void> {
  try {
    if (!ctx?.from?.username) {
      await ctx.reply(
        "Наш бот не бачить твій nickname (ім'я користувача після @). Зміни будь ласка налаштування безпеки та спробуй наново (наново введи команду /start).",
      );
      return;
    }

    const chatId = String(ctx.chat?.id ?? "");
    cleanupExpiredReportSessions();
    const session = reportSessions.get(chatId);
    const caption = (ctx.message?.caption ?? "").trim();
    const firstWord = caption.split(/\s+/)[0]?.toLowerCase();
    const isReportStartCaption =
      firstWord === "z" || firstWord === "x" || firstWord === "х";

    if (session) {
      const steps = getReportSteps(session.reportType);
      const step = steps[session.stepIndex];
      if (step?.input === "photo") {
        if (!ctx.message?.media_group_id) {
          const photoSizes = ctx.message?.photo;
          if (photoSizes?.length) {
            const fileId = photoSizes[photoSizes.length - 1].file_id;
            session.photoFileIds.push(fileId);
            const msgId = ctx.message?.message_id;
            if (msgId != null) session.messageIdsToDelete.push(msgId);
            await sendNextReportStep(ctx, bot, session);
          }
        }
        return;
      }
    }

    const mediaGroupId = ctx.message?.media_group_id;
    const zReportChatId = process?.env?.Z_REPORT_CHAT_ID || "";
    const xReportChatId = process?.env?.X_REPORT_CHAT_ID || "";

    if (mediaGroupId) {
      if (albumBuffer.has(mediaGroupId)) {
        albumBuffer.get(mediaGroupId)!.messages.push(ctx.message);
      } else {
        const timeout = setTimeout(async () => {
          const albumData = albumBuffer.get(mediaGroupId);
          if (albumData) {
            const messages = albumData.messages;
            const firstMsg = messages[0];
            const cap = (firstMsg?.caption ?? "").trim();
            const word = cap.split(/\s+/)[0]?.toLowerCase();
            if (word === "z" || word === "x" || word === "х") {
              const fileIds: string[] = [];
              const msgIds: number[] = [];
              for (const msg of messages) {
                const sizes = msg?.photo;
                if (sizes?.length) {
                  fileIds.push(sizes[sizes.length - 1].file_id);
                  if (msg?.message_id) msgIds.push(msg.message_id);
                }
              }
              const reportType: ReportType = word === "z" ? "z" : "x";
              await startReportSession(ctx, bot, reportType, fileIds, msgIds);
            } else {
              await processAlbumMessages(
                ctx,
                messages,
                bot,
                zReportChatId,
                xReportChatId,
              );
            }
            albumBuffer.delete(mediaGroupId);
          }
        }, 500);
        albumBuffer.set(mediaGroupId, { messages: [ctx.message], timeout });
      }
      return;
    }

    if (!session && isReportStartCaption) {
      const photoSizes = ctx.message?.photo;
      if (photoSizes?.length) {
        const fileId = photoSizes[photoSizes.length - 1].file_id;
        const msgId = ctx.message?.message_id ?? 0;
        const reportType: ReportType = firstWord === "z" ? "z" : "x";
        await startReportSession(ctx, bot, reportType, [fileId], [msgId]);
      }
      return;
    }

    if (caption.length > 0 && !isReportStartCaption) {
      await processSinglePhoto(ctx, bot, zReportChatId, xReportChatId);
    }
  } catch (error: any) {
    await ctx.reply(
      "Сталася якась помилка. Напишіть керуючому." + JSON.stringify(error),
    );
  }
}

export function registerVideoPhotoHandlers(
  bot: Bot<Context, Api<RawApi>>,
): void {
  bot.on("message:video", async (ctx) => handleVideoMessage(ctx, bot));
  bot.on("message:photo", async (ctx) => handlePhotoMessage(ctx, bot));
}
