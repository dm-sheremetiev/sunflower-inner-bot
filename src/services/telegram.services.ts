/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs/promises";
import path from "path";
import axios from "axios";
import dayjs from "dayjs";
import type { Context } from "grammy";
import { Bot, Api, GrammyError, HttpError, RawApi, InputFile, InlineKeyboard } from "grammy";
import { keycrmApiClient } from "../api/keycrmApiClient.js";
import { Order } from "../types/keycrm.js";
import { fileHelper } from "../helpers/fileHelper.js";
import { TelegramUserDatabase } from "../types/telegram.js";
import { changeOrderStatus, addTagToOrder } from "./keycrm.services.js";
import { fetchAllOrders } from "../helpers/keycrmHelper.js";
import { messageHelper } from "../helpers/messageHelper.js";
import { StudioStatus } from "./workload.service.js";
import { getFaynatownConfigError, parseFaynatownBranch, getLatestPassesWithQr, createVisitorPasses, getLatestCarPasses, createCarPass } from "./faynatown.service.js";

import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const sunflowerUsername = process?.env?.SUNFLOWER_USERNAME || "";
const managerChanelChatId = process?.env?.MANAGER_CHANNELS_CHAT_ID || "";

const couriers = process?.env?.COURIERS || "";
const botToken = process?.env.TELEGRAM_BOT_TOKEN || "";
const forwardChatId = process?.env?.VIDEO_CHAT_ID || "";
const isHoliday =
  (process?.env?.IS_HOLIDAY || "").toLowerCase() === "true";
const productDeliveredStatus = process?.env?.PRODUCT_DELIVERED_STATUS || "23";
const zReportChatId = process?.env?.Z_REPORT_CHAT_ID || "";
const xReportChatId = process?.env?.X_REPORT_CHAT_ID || "";
const deliveryRegex = /^[Дд]оставка \d+$/;
const couriersList = couriers
  .split(",")
  .map((courier) => courier.toLowerCase());

const STUDIOS = ["файна", "француз", "севен"];
const STATUSES = ["зелений", "жовтий", "червоний"];

const COLOR_MAP: Record<string, string> = {
  зелений: "green",
  жовтий: "yellow",
  червоний: "red",
};

const BRANCH_MAP: Record<string, string> = {
  файна: "faina",
  француз: "francuz",
  севен: "seven",
};

const tz = "Europe/Kyiv";

// --- Z/X Report wizard ---
type ReportType = "x" | "z";

interface ReportSession {
  reportType: ReportType;
  stepIndex: number;
  data: Record<string, string>;
  photoFileIds: string[];
  messageIdsToDelete: number[];
  botMessageIdsToDelete: number[];
  username: string;
  chatId: string;
  createdAt: number;
}

type ReportStepInput = "text" | "photo" | "choice";

interface ReportStepConfig {
  id: string;
  question: string;
  input: ReportStepInput;
  choices?: [string, string][]; // [label, value]
  dataKey?: string;
  default?: string;
}

const reportSessions = new Map<string, ReportSession>();

/** Видаляє сесії звітів, старші за 48 годин за київським часом. Викликати при обробці запитів звітів. */
function cleanupExpiredReportSessions(): void {
  const nowKyiv = dayjs().tz(tz);
  for (const [chatId, session] of reportSessions.entries()) {
    const createdKyiv = dayjs(session.createdAt).tz(tz);
    if (nowKyiv.diff(createdKyiv, "hour") >= 48) {
      reportSessions.delete(chatId);
    }
  }
}

/** Id повідомлення «Відправити звіт»/ /report перед вибором X/Z — додається в messageIdsToDelete при старті */
const pendingReportStartMessageIds = new Map<string, number>();
/** Id повідомлення бота «Оберіть тип звіту» — додається в botMessageIdsToDelete при старті */
const pendingReportStartBotMessageIds = new Map<string, number>();

const REPORT_SALONS: [string, string][] = [
  ["Файна", "Файна"],
  ["Француз", "Француз"],
  ["Севен", "Севен"],
  ["Республіка", "Республіка"],
];

const X_REPORT_STEPS: ReportStepConfig[] = [
  { id: "x_date", question: "📆 Дата (наприклад 03.03.2026)", input: "text", dataKey: "date" },
  { id: "x_admin", question: "👤 Адміністратор (ваш нік або ПІБ)", input: "text", dataKey: "administrator" },
  { id: "x_salon", question: "🏪 Салон", input: "choice", choices: REPORT_SALONS, dataKey: "salon" },
  { id: "x_cash", question: "💵 Готівка в касі", input: "text", dataKey: "cash" },
  { id: "x_photo", question: "📷 Надішліть фото звіту (одне або альбом)", input: "photo" },
];

const Z_REPORT_STEPS: ReportStepConfig[] = [
  { id: "z_date", question: "📆 Дата (наприклад 03.03.2026)", input: "text", dataKey: "date" },
  { id: "z_salon", question: "🏪 Салон", input: "choice", choices: REPORT_SALONS, dataKey: "salon" },
  { id: "z_cash_day", question: "🖥 Каса за день", input: "text", dataKey: "cash_day" },
  { id: "z_delivery", question: "🚙 Доставка", input: "text", dataKey: "delivery" },
  { id: "z_pass_through", question: "🚶🏻‍♂️‍➡️ Прохідні", input: "text", dataKey: "pass_through" },
  { id: "z_write_off", question: "✅ Списання внесено", input: "choice", choices: [["Так", "Так"], ["Ні", "Ні"]], dataKey: "write_off_done" },
  { id: "z_cash", question: "💵 Готівка в касі", input: "text", dataKey: "cash" },
  { id: "z_comment", question: "💬 Коментар (або напишіть —)", input: "text", dataKey: "comment" },
  { id: "z_admin", question: "👤 Адміністратор (ваш нік або ПІБ)", input: "text", dataKey: "administrator" },
  { id: "z_photo", question: "📷 Надішліть фото звіту (одне або альбом)", input: "photo" },
];

function getReportSteps(type: ReportType): ReportStepConfig[] {
  return type === "x" ? X_REPORT_STEPS : Z_REPORT_STEPS;
}

function buildReportSummaryText(session: ReportSession): string {
  const { reportType, data } = session;
  if (reportType === "x") {
    return (
      `🧾 Тип звіту: X-звіт\n` +
      `📆 Дата: ${data.date ?? "—"}\n` +
      `👤 Адміністратор: ${data.administrator ?? "—"}\n` +
      `🏪 Салон: ${data.salon ?? "—"}\n` +
      `💵 Готівка в касі: ${data.cash ?? "—"}`
    );
  }
  return (
    `Z\n\n` +
    `📆 Дата: ${data.date ?? "—"}\n\n` +
    `🏪 Салон: ${data.salon ?? "—"}\n\n` +
    `🖥 Каса за день: ${data.cash_day ?? "—"}\n\n` +
    `🚙 Доставка: ${data.delivery ?? "—"}\n\n` +
    `🚶🏻‍♂️‍➡️ Прохідні: ${data.pass_through ?? "—"}\n\n` +
    `✅ Списання внесено: ${data.write_off_done ?? "—"}\n\n` +
    `💵 Готівка в касі: ${data.cash ?? "—"}\n\n` +
    `Коментар: ${data.comment ?? "—"}\n\n` +
    `👤 Адміністратор: ${data.administrator ?? "—"}`
  );
}

async function sendReportToChannel(
  bot: Bot<Context, Api<RawApi>>,
  session: ReportSession
): Promise<void> {
  const targetChatId = session.reportType === "z" ? zReportChatId : xReportChatId;
  const caption =
    `Звіт від @${session.username}\n\n` + buildReportSummaryText(session);

  if (session.photoFileIds.length === 0) {
    await bot.api.sendMessage(targetChatId, caption);
    return;
  }
  if (session.photoFileIds.length === 1) {
    await bot.api.sendPhoto(targetChatId, session.photoFileIds[0], { caption });
    return;
  }
  const media = session.photoFileIds.map((fileId, i) => ({
    type: "photo" as const,
    media: fileId,
    caption: i === 0 ? caption : undefined,
  }));
  await bot.api.sendMediaGroup(targetChatId, media);
}

async function sendNextReportStep(
  ctx: Context,
  bot: Bot<Context, Api<RawApi>>,
  session: ReportSession
): Promise<void> {
  const steps = getReportSteps(session.reportType);
  const step = steps[session.stepIndex];
  if (!step) {
    await sendReportConfirmStep(ctx, bot, session);
    return;
  }
  if (step.input === "choice" && step.choices?.length) {
    const keyboard = new InlineKeyboard();
    step.choices.forEach(([label], idx) => {
      keyboard.text(label, `report:ch:${session.reportType}:${step.id}:${idx}`).row();
    });
    const msg = await ctx.reply(step.question, { reply_markup: keyboard });
    if (msg?.message_id) session.botMessageIdsToDelete.push(msg.message_id);
    return;
  }
  if (step.input === "photo" && session.photoFileIds.length > 0) {
    const keyboard = new InlineKeyboard().text("Далі", "report:step:next");
    const msg = await ctx.reply(
      `У вас є ${session.photoFileIds.length} фото. Надішліть ще або натисніть Далі.`,
      { reply_markup: keyboard }
    );
    if (msg?.message_id) session.botMessageIdsToDelete.push(msg.message_id);
    return;
  }
  const msg = await ctx.reply(step.question);
  if (msg?.message_id) session.botMessageIdsToDelete.push(msg.message_id);
}

async function sendReportConfirmStep(
  ctx: Context,
  bot: Bot<Context, Api<RawApi>>,
  session: ReportSession
): Promise<void> {
  const text = buildReportSummaryText(session) + `\n\n📷 Фото: ${session.photoFileIds.length} шт.`;
  const keyboard = new InlineKeyboard()
    .text("Відправити звіт", "report:confirm:yes")
    .text("Скасувати", "report:confirm:no");
  const msg = await ctx.reply(text, { reply_markup: keyboard });
  if (msg?.message_id) session.botMessageIdsToDelete.push(msg.message_id);
}

async function startReportSession(
  ctx: Context,
  bot: Bot<Context, Api<RawApi>>,
  reportType: ReportType,
  initialPhotoFileIds: string[] = [],
  initialMessageIds: number[] = []
): Promise<void> {
  if (!ctx.from?.username || !ctx.chat?.id) return;
  const chatId = String(ctx.chat.id);
  const msgId = ctx.message?.message_id;
  const allMsgIds =
    initialMessageIds.length > 0
      ? initialMessageIds
      : msgId != null
        ? [msgId]
        : [];
  reportSessions.set(chatId, {
    reportType,
    stepIndex: 0,
    data: { administrator: ctx.from.username },
    photoFileIds: [...initialPhotoFileIds],
    messageIdsToDelete: [...allMsgIds],
    botMessageIdsToDelete: [],
    username: ctx.from.username,
    chatId,
    createdAt: Date.now(),
  });
  const session = reportSessions.get(chatId)!;
  await sendNextReportStep(ctx, bot, session);
}

export const isCourier = (username: string) => {
  return couriersList.includes(username.toLowerCase());
};
export const sendTelegramMessage = async (
  chatId: string,
  text: string,
  parseMode?: "Markdown" | "HTML" | "MarkdownV2"
) => {
  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        chat_id: chatId,
        text: text || "empty",
        ...(parseMode ? { parse_mode: parseMode } : {}),
      }
    );

    return response.data;
  } catch (error) {
    console.error("Telegram send error:", error);
  }
};

export const sendTelegramMessageToMainAccount = async (text: string) => {
  try {
    const users = fileHelper.loadUsers();

    let chatId = "";
    for (const id in users) {
      if (users[id].username === sunflowerUsername) {
        chatId = id;

        break;
      }
    }

    const res = await sendTelegramMessage(chatId, text);

    return res;
  } catch (error) {
    console.log("Error", error);
  }
};

export const sendTelegramMessageToNotificationsChanel = async (
  text: string
) => {
  try {
    const res = await sendTelegramMessage(managerChanelChatId, text);

    return res;
  } catch (error) {
    console.log("Error", error);
  }
};

export const handleVideoMessage = async (
  ctx: Context,
  bot: Bot<Context, Api<RawApi>>
) => {
  const caption = ctx?.message?.caption || "";

  if (!ctx?.from?.username) {
    ctx.reply(
      "Наш бот не бачить твій nickname (ім'я користувача після @). Зміни будь ласка налаштування безпеки та спробуй наново (наново введи команду /start)."
    );

    return;
  }

  if (caption && deliveryRegex.test(caption.trim())) {
    try {
      const orderId = caption.trim().split(" ")[1].trim();

      const res = await keycrmApiClient.get<Order>(
        `order/${+orderId}?include=manager,assigned`
      );

      if (!res.data) {
        ctx.reply(
          "Такого замовлення не існує, перевірте будь ласка номер замовлення та спробуйте ще раз."
        );

        return;
      }

      const { data: order } = res;

      // Видалити на свята
      if (!isHoliday && !isCourier(ctx.from.username)) {
        ctx.reply("Вибачте, цей функціонал доступний тільки кур'єрам.");

        return;
      }

      // Видалити на свята
      if (!isHoliday && !res.data?.assigned?.length) {
        ctx.reply("На це замовлення спершу треба призначити відповідальних.");

        return;
      }

      // Видалити на свята
      // if (
      //   !order?.assigned?.find(
      //     (ass) =>
      //       ass.username.toLowerCase() === ctx.from?.username?.toLowerCase()
      //   )
      // ) {
      //   ctx.reply(
      //     "Це замовлення призначене не на вас. Будь ласка, попросіть менеджерів переназначити його на вас у СРМ системі."
      //   );

      //   return;
      // }

      const promises = [
        forwardReport(
          bot,
          forwardChatId,
          ctx?.chat?.id || "",
          ctx?.message?.message_id || 0
        ),
        await changeOrderStatus(orderId, productDeliveredStatus),
      ];
      const results = await Promise.allSettled(promises);

      // Написать менедежеру о статусе
      const managerUsername = order.manager.username;

      const users = fileHelper.loadUsers();

      const userEntry = Object.entries(users).find(
        ([, user]) =>
          (user as TelegramUserDatabase)?.username === managerUsername
      )?.[0];

      let messageForManager = "";
      let messageForCourier = "";

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

      ctx.reply(messageForCourier);

      const managerChatId = userEntry;

      const resp = managerChatId
        ? await sendTelegramMessage(managerChatId, messageForManager)
        : await sendTelegramMessageToMainAccount(messageForManager);

      return resp;
    } catch (error: any) {
      if (error?.status && error?.status === 404) {
        ctx.reply(
          "Такого замовлення не існує, перевірте будь ласка номер замовлення та спробуйте ще раз."
        );

        return;
      }
      console.log(error);

      ctx.reply(
        "Сталася якась помилка при пересилці відео у групу. Спробуйте це зробити власноруч."
      );
    }
  } else {
    ctx.reply(
      "Суворий формат тексту: `Доставка 0000` , де 0000 це номер замовлення",
      { parse_mode: "Markdown" }
    );
  }
};

export const forwardReport = async (
  bot: Bot,
  chatToForward: string,
  fromChatId: string | number,
  messageId: number
) => {
  try {
    bot.api.forwardMessage(chatToForward, fromChatId, messageId || 0);
  } catch (error) {
    console.error(error);
  }
};

const albumBuffer = new Map<
  string,
  { messages: Context["message"][]; timeout: NodeJS.Timeout }
>();

export const handlePhotoMessage = async (
  ctx: Context,
  bot: Bot<Context, Api<RawApi>>
) => {
  try {
    if (!ctx?.from?.username) {
      ctx.reply(
        "Наш бот не бачить твій nickname (ім'я користувача після @). Зміни будь ласка налаштування безпеки та спробуй наново (наново введи команду /start)."
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
              await processAlbumMessages(ctx, messages, bot);
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
      await processSinglePhoto(ctx, bot);
    }
  } catch (error: any) {
    ctx.reply(
      "Сталася якась помилка. Напишіть керуючому." + JSON.stringify(error)
    );
  }
};

async function processAlbumMessages(
  ctx: Context,
  messages: Context["message"][],
  _bot: Bot<Context>
) {
  const firstMessage = messages[0];
  const caption = firstMessage?.caption || "";

  if (!firstMessage?.from?.username) {
    await ctx.reply(
      "Наш бот не бачить твій nickname (ім'я користувача після @). Змініть налаштування безпеки та спробуйте ще раз (/start)."
    );
    return;
  }

  if (!caption.trim().length) {
    return;
  }

  const reportType = caption.trim().split(" ")[0].toLowerCase();
  const media = messages
    .map((msg, index) => {
      const photoSizes = msg?.photo;
      if (!photoSizes || photoSizes.length === 0) return null;
      const fileId = photoSizes[photoSizes.length - 1].file_id;
      const photoCaption =
        index === 0 ? `Звіт від @${msg?.from.username}\n${caption}` : undefined;
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
      await _bot.api.sendMediaGroup(zReportChatId, media);
      for (const msg of messages) {
        if (msg) await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
      }
      await ctx.reply("Ваш Z-звіт було успішно відправлено.");
      return;
    }
    if (reportType.includes("x") || reportType.includes("х")) {
      await _bot.api.sendMediaGroup(xReportChatId, media);
      for (const msg of messages) {
        if (msg) await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
      }
      await ctx.reply("Ваш Х-звіт було успішно відправлено.");
      return;
    }
  } catch (error: any) {
    await ctx.reply(
      "Сталася якась помилка. Напишіть керуючому. " + JSON.stringify(error)
    );
  }
}

async function processSinglePhoto(ctx: Context, bot: Bot<Context>) {
  const caption = ctx.message?.caption || "";

  if (!ctx.from?.username) {
    await ctx.reply(
      "Наш бот не бачить твій nickname (ім'я користувача після @). Змініть налаштування безпеки та спробуйте ще раз (/start)."
    );
    return;
  }

  if (!caption.trim().length) {
    return;
  }

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
      return;
    }
  } catch (error: any) {
    await ctx.reply(
      "Сталася якась помилка. Напишіть керуючому. " + JSON.stringify(error)
    );
  }
}

export const initializeBot = () => {
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
    {
      command: "start",
      description: "Запуск бота",
    },
    {
      command: "my_orders",
      description: "Номери моїх замовлення",
    },
    {
      command: "report",
      description: "Відправити звіт (X або Z)",
    },
  ]);

  /** Z/X Report wizard: callback_query */
  bot.on("callback_query", async (ctx) => {
    const data = ctx.callbackQuery?.data;
    if (!data?.startsWith("report:") || !ctx.chat?.id || !ctx.from?.username) {
      return;
    }
    cleanupExpiredReportSessions();
    await ctx.answerCallbackQuery();

    if (data === "report:start:x" || data === "report:start:z") {
      const reportType: ReportType = data === "report:start:z" ? "z" : "x";
      const chatId = String(ctx.chat.id);
      const messageIdsToDelete: number[] = [];
      const pendingId = pendingReportStartMessageIds.get(chatId);
      if (pendingId != null) {
        messageIdsToDelete.push(pendingId);
        pendingReportStartMessageIds.delete(chatId);
      }
      const botMessageIdsToDelete: number[] = [];
      const pendingBotId = pendingReportStartBotMessageIds.get(chatId);
      if (pendingBotId != null) {
        botMessageIdsToDelete.push(pendingBotId);
        pendingReportStartBotMessageIds.delete(chatId);
      }
      reportSessions.set(chatId, {
        reportType,
        stepIndex: 0,
        data: { administrator: ctx.from.username },
        photoFileIds: [],
        messageIdsToDelete,
        botMessageIdsToDelete,
        username: ctx.from.username,
        chatId,
        createdAt: Date.now(),
      });
      const session = reportSessions.get(chatId)!;
      await sendNextReportStep(ctx, bot, session);
      return;
    }

    const chatId = String(ctx.chat.id);
    const session = reportSessions.get(chatId);
    if (!session) return;

    if (data === "report:confirm:no") {
      reportSessions.delete(chatId);
      await ctx.reply("Звіт скасовано.");
      return;
    }

    if (data === "report:confirm:yes") {
      try {
        await sendReportToChannel(bot, session);
        for (const msgId of session.messageIdsToDelete) {
          try {
            await ctx.api.deleteMessage(session.chatId, msgId);
          } catch {
            // ignore delete errors
          }
        }
        for (const msgId of session.botMessageIdsToDelete) {
          try {
            await ctx.api.deleteMessage(session.chatId, msgId);
          } catch {
            // ignore delete errors
          }
        }
        reportSessions.delete(chatId);
        const label = session.reportType === "z" ? "Z" : "X";
        await ctx.reply(`Ваш ${label}-звіт було успішно відправлено.`);
      } catch {
        await ctx.reply("Помилка відправки звіту. Спробуйте пізніше.");
      }
      return;
    }

    if (data === "report:step:next") {
      session.stepIndex += 1;
      await sendNextReportStep(ctx, bot, session);
      return;
    }

    if (data.startsWith("report:ch:")) {
      const parts = data.split(":");
      if (parts.length < 5) return;
      const [, , type, stepId, idxStr] = parts;
      const stepIndex = parseInt(idxStr, 10);
      if (Number.isNaN(stepIndex)) return;
      const steps = getReportSteps(type as ReportType);
      const step = steps.find((s) => s.id === stepId);
      if (!step?.choices?.[stepIndex] || !step.dataKey) return;
      session.data[step.dataKey] = step.choices[stepIndex][1];
      session.stepIndex += 1;
      await sendNextReportStep(ctx, bot, session);
      return;
    }
  });

  /** Z/X Report wizard: start by text "z" / "x" or command */
  const startReportWizard = async (ctx: Context, reportType: ReportType) => {
    if (!ctx.from?.username || !ctx.chat?.id) return;
    const chatId = String(ctx.chat.id);
    const msgId = ctx.message?.message_id;
    reportSessions.set(chatId, {
      reportType,
      stepIndex: 0,
      data: { administrator: ctx.from.username },
      photoFileIds: [],
      messageIdsToDelete: msgId != null ? [msgId] : [],
      botMessageIdsToDelete: [],
      username: ctx.from.username,
      chatId,
      createdAt: Date.now(),
    });
    const session = reportSessions.get(chatId)!;
    await sendNextReportStep(ctx, bot, session);
  };

  bot.hears(/^(z|x|х)$/i, async (ctx) => {
    if (!ctx.message?.text) return;
    const t = ctx.message.text.trim().toLowerCase();
    const reportType: ReportType = t === "z" ? "z" : "x";
    await startReportWizard(ctx, reportType);
  });

  bot.command("z_report", async (ctx) => startReportWizard(ctx, "z"));
  bot.command("x_report", async (ctx) => startReportWizard(ctx, "x"));

  const showReportTypeChoice = async (ctx: Context) => {
    const chatId = ctx.chat?.id != null ? String(ctx.chat.id) : null;
    const msgId = ctx.message?.message_id;
    if (chatId != null && msgId != null) {
      pendingReportStartMessageIds.set(chatId, msgId);
    }
    const keyboard = new InlineKeyboard()
      .text("X-звіт", "report:start:x")
      .text("Z-звіт", "report:start:z");
    const sent = await ctx.reply("Оберіть тип звіту:", { reply_markup: keyboard });
    if (chatId != null && sent?.message_id) {
      pendingReportStartBotMessageIds.set(chatId, sent.message_id);
    }
  };

  bot.command("report", async (ctx) => showReportTypeChoice(ctx));
  bot.hears(/відправити\s+звіт/i, async (ctx) => showReportTypeChoice(ctx));

  /** Z/X Report wizard: text reply when in session */
  bot.on("message:text", async (ctx, next) => {
    if (!ctx.chat?.id || !ctx.from?.username) return next();
    cleanupExpiredReportSessions();
    const chatId = String(ctx.chat.id);
    const text = ctx.message?.text?.trim() ?? "";
    const session = reportSessions.get(chatId);
    if (!session) return next();

    const msgId = ctx.message?.message_id;
    if (msgId != null) session.messageIdsToDelete.push(msgId);

    if (/^(z|x|х)$/i.test(text)) {
      const reportType: ReportType = text.toLowerCase() === "z" ? "z" : "x";
      reportSessions.set(chatId, {
        reportType,
        stepIndex: 0,
        data: { administrator: ctx.from.username },
        photoFileIds: [],
        messageIdsToDelete: session.messageIdsToDelete,
        botMessageIdsToDelete: session.botMessageIdsToDelete,
        username: ctx.from.username,
        chatId,
        createdAt: Date.now(),
      });
      const newSession = reportSessions.get(chatId)!;
      await sendNextReportStep(ctx, bot, newSession);
      return;
    }

    const steps = getReportSteps(session.reportType);
    const step = steps[session.stepIndex];
    if (!step || step.input !== "text") return next();

    if (step.dataKey) session.data[step.dataKey] = text;
    session.stepIndex += 1;
    await sendNextReportStep(ctx, bot, session);
  });

  /** Парсинг філії та кількості (1-5) з тексту про проходки */
  const parsePassArgs = (text: string): { complexId?: number; count: number } => {
    const parts = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let complexId: number | undefined;
    let count = 1;
    for (const p of parts) {
      const branch = parseFaynatownBranch(p);
      if (branch !== undefined) complexId = branch;
      const num = /^\d+$/.test(p) ? parseInt(p, 10) : NaN;
      if (!Number.isNaN(num) && num >= 1 && num <= 5) count = num;
    }
    return { complexId, count };
  };

  /** Затримка мс між відправками кількох фото */
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const PASS_DELAY_MS = 700;

  /** Формат дати з ISO в DD.MM.YYYY HH:mm */
  const formatPassDate = (iso: string) => {
    const d = new Date(iso);
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${day}.${month}.${year} ${h}:${m}`;
  };

  /** Підпис під QR у вигляді як у додатку: ЖК, період дії перепустки, дати */
  const formatPassCaption = (pass: { complexName: string; visitorName?: string; startTime: string; endTime: string }) => {
  const name = `ЖК ${pass.complexName}`;
    const from = formatPassDate(pass.startTime);
    const to = formatPassDate(pass.endTime);
    return `${name}\n${pass.visitorName ?? ""}\n\nПеріод дії перепустки\n${from}\n${to}`;
  };

  /** Отримати авто-перепустки (до 30): перепустки авто, перепустки авто файна 10 */
  bot.hears(/перепустки\s+авто/i, async (ctx) => {
    const text = ctx.message?.text?.trim() ?? "";
    console.log("[Faynatown hears GET] перепустки авто, text:", JSON.stringify(text));
    try {
      const configError = getFaynatownConfigError();
      if (configError) {
        await ctx.reply(configError);
        return;
      }
      const numbers = text.match(/\d+/g);
      const count =
        numbers?.length
          ? Math.min(30, Math.max(1, Math.max(...numbers.map((n) => parseInt(n, 10)))))
          : 10;
      const { complexId } = parsePassArgs(text);
      const list = await getLatestCarPasses(complexId, count);
      if (list.length === 0) {
        await ctx.reply("Авто-перепусток не знайдено для обраного комплексу. Спробуйте вказати файна або республіка.");
        return;
      }
      const lines = list.map(
        (p) =>
          `${p.plateNumber ?? p.hikvisionPassId ?? "—"} — ЖК ${p.complexName} — ${formatPassDate(p.startTime)} … ${formatPassDate(p.endTime)}`
      );
      await ctx.reply(lines.join("\n"));
    } catch (error: unknown) {
      console.error("[Faynatown hears GET] перепустки авто помилка:", error);
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Помилка отримання авто-перепусток: ${msg}`);
    }
  });

  /** Отримати перепустки (до 5): перепустки, перепустки файна, перепустки файна 3 */
  bot.hears(/перепустки/i, async (ctx) => {
    const text = ctx.message?.text?.trim() ?? "";
    console.log("[Faynatown hears GET] перепустки, text:", JSON.stringify(text));
    try {
      const configError = getFaynatownConfigError();
      if (configError) {
        console.log("[Faynatown hears GET] config error:", configError);
        await ctx.reply(configError);
        return;
      }
      const numbers = text.match(/\d+/g);
      if (numbers?.some((n) => parseInt(n, 10) > 5)) {
        console.log("[Faynatown hears GET] число > 5");
        await ctx.reply("Можна отримати максимум 5 останніх перепусток. Вкажіть число від 1 до 5.");
        return;
      }
      const { complexId, count } = parsePassArgs(text);
      console.log("[Faynatown hears GET] parsePassArgs:", { complexId, count });
      const results = await getLatestPassesWithQr(complexId, count);
      console.log("[Faynatown hears GET] getLatestPassesWithQr результатів:", results.length);
      if (results.length === 0) {
        await ctx.reply("Перепусток не знайдено для обраного комплексу. Спробуйте вказати файна або республіка.");
        return;
      }
      for (let i = 0; i < results.length; i++) {
        if (i > 0) await delay(PASS_DELAY_MS);
        const { pass, qrBuffer } = results[i];
        await ctx.replyWithPhoto(new InputFile(qrBuffer, "pass-qr.png"), {
          caption: formatPassCaption(pass),
        });
      }
      console.log("[Faynatown hears GET] відправлено фото:", results.length);
    } catch (error: unknown) {
      console.error("[Faynatown hears GET] помилка:", error);
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Помилка отримання перепусток: ${msg}`);
    }
  });

  /** Створити авто-перепустку. Філія та номер авто обовʼязкові: нова перепустка авто республіка KA7877AM */
  bot.hears(/нова\s+перепустка\s+авто/i, async (ctx) => {
    const text = ctx.message?.text?.trim() ?? "";
    console.log("[Faynatown hears CREATE] нова перепустка авто, text:", JSON.stringify(text));
    try {
      const configError = getFaynatownConfigError();
      if (configError) {
        await ctx.reply(configError);
        return;
      }
      const afterAuto = text.replace(/нова\s+перепустка\s+авто\s+/i, "").trim();
      const tokens = afterAuto.split(/\s+/).filter(Boolean);
      const plate = tokens[tokens.length - 1];
      if (!plate || !/^[A-Za-z0-9]{5,12}$/i.test(plate)) {
        await ctx.reply("Вкажіть номер авто (латиницею, наприклад KA7877AM). Приклад: нова перепустка авто республіка KA7877AM");
        return;
      }
      const argsWithoutPlate = tokens.slice(0, -1).join(" ");
      const { complexId } = parsePassArgs(argsWithoutPlate);
      if (complexId === undefined) {
        await ctx.reply("Обовʼязково вкажіть філію: файна або республіка. Наприклад: нова перепустка авто республіка KA7877AM");
        return;
      }
      const ok = await createCarPass(complexId, plate);
      const branchName = complexId === 1 ? "Файна Таун" : complexId === 2 ? "Республіка" : `комплекс ${complexId}`;
      if (ok) {
        await ctx.reply(`Створено авто-перепустку для ${plate.toUpperCase()}, ЖК ${branchName}. Період 24 год.`);
      } else {
        await ctx.reply(`API повернув помилку при створенні авто-перепустки для ${plate}. Спробуйте пізніше.`);
      }
    } catch (error: unknown) {
      console.error("[Faynatown hears CREATE] нова перепустка авто помилка:", error);
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Помилка створення авто-перепустки: ${msg}`);
    }
  });

  /** Створити перепустки (1-5). Філія обовʼязкова: нова перепустка файна, нова перепустка республіка 3 */
  bot.hears(/нова\s+перепустка/i, async (ctx) => {
    const text = ctx.message?.text?.trim() ?? "";
    console.log("[Faynatown hears CREATE] нова перепустка, text:", JSON.stringify(text));
    try {
      const configError = getFaynatownConfigError();
      if (configError) {
        console.log("[Faynatown hears CREATE] config error:", configError);
        await ctx.reply(configError);
        return;
      }
      const numbers = text.match(/\d+/g);
      if (numbers?.some((n) => parseInt(n, 10) > 5)) {
        console.log("[Faynatown hears CREATE] число > 5");
        await ctx.reply("Максимум можна створити 5 перепусток за раз. Вкажіть число від 1 до 5.");
        return;
      }
      const { complexId, count } = parsePassArgs(text);
      if (complexId === undefined) {
        await ctx.reply("Обовʼязково вкажіть філію: файна або республіка. Наприклад: нова перепустка файна");
        return;
      }
      const branchId = complexId;
      console.log("[Faynatown hears CREATE] parsePassArgs:", { complexId, count }, "branchId:", branchId);
      await createVisitorPasses(branchId, count);
      console.log("[Faynatown hears CREATE] createVisitorPasses виконано, count:", count);
      await delay(PASS_DELAY_MS);
      const results = await getLatestPassesWithQr(branchId, count);
      if (results.length > 0) {
        for (let i = 0; i < results.length; i++) {
          if (i > 0) await delay(PASS_DELAY_MS);
          const { pass, qrBuffer } = results[i];
          await ctx.replyWithPhoto(new InputFile(qrBuffer, "pass-qr.png"), {
            caption: formatPassCaption(pass),
          });
        }
      }
      const branchName = branchId === 1 ? "Файна Таун" : branchId === 2 ? "Республіка" : `комплекс ${branchId}`;
      await ctx.reply(`Створено ${count} перепусток для ${branchName}.`);
    } catch (error: unknown) {
      console.error("[Faynatown hears CREATE] помилка:", error);
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Помилка створення перепусток: ${msg}`);
    }
  });

  bot.command("my_orders", async (ctx) => {
    if (!ctx.from?.username) {
      ctx.reply(
        "Наш бот не бачить твій nickname (ім'я користувача після @). Зміни будь ласка налаштування безпеки та спробуй наново (наново введи команду /start)."
      );

      return;
    }

    // if (!isCourier(ctx.from.username)) {
    //   ctx.reply("Вибачте, цей функціонал доступний тільки кур'єрам.");

    //   return false;
    // }

    const users = fileHelper.loadUsers();

    const { id: chatId, username } = ctx.from;

    if (users[chatId]) {
      if (users[chatId].username !== username) {
        users[chatId].username = username;
      }
    } else {
      users[chatId] = { username, addedAt: new Date().toISOString() };
    }

    fileHelper.saveUsers(users);

    // Getting all related orders for this employee

    const startOfToday = dayjs().startOf("day").format("YYYY-MM-DD HH:mm:ss");

    const endOfNextDay = dayjs()
      .add(5, "day")
      .endOf("day")
      .format("YYYY-MM-DD HH:mm:ss");
    const shippingBetween = `${startOfToday},${endOfNextDay}`;

    const orders = await fetchAllOrders(shippingBetween);

    ctx.reply(messageHelper.formatMyOrdersMessage(orders, username), {
      parse_mode: "MarkdownV2",
    });
  });

  bot.hears(/^друк\s\d+$/i, async (ctx) => {
    try {
      if (!ctx.message?.text) {
        return;
      }

      const messageText = ctx.message.text.trim();
      const orderId = messageText.split(" ")[1];

      if (!orderId) {
        return ctx.reply(
          "Будь ласка, введіть коректний номер замовлення. Приклад: 'Друк 1234'"
        );
      }

      const printUrl = `http://194.113.32.44/print/${orderId}`;

      await ctx.reply(
        `🖨 Для друку замовлення натисніть на посилання:\n${printUrl}`
      );
    } catch (error) {
      console.error("Помилка при обробці запиту на друк:", error);
      await ctx.reply("❌ Виникла помилка. Будь ласка, спробуйте ще раз.");
    }
  });

  bot.hears(/^(\d+)\s+в\s+(.+)$/i, async (ctx) => {
    try {
      if (!ctx.message?.text) {
        return;
      }

      const orderId = ctx.match[1]; // номер заказа

      if (!orderId) {
        return ctx.reply(
          "Будь ласка, введіть коректний номер замовлення. Приклад: '1234'"
        );
      }

      const extraArgument = ctx.match[2].trim(); // аргумент после "в"
      await addTagToOrder(ctx, Number(orderId), bot, extraArgument);
    } catch (error) {
      console.error("Помилка при обробці запиту на друк:", error);
      await ctx.reply("❌ Виникла помилка. Будь ласка, спробуйте ще раз.");
    }
  });

  bot.command("start", async (ctx) => {
    if (!ctx.from?.username) {
      ctx.reply(
        "Наш бот не бачить твій nickname (ім'я користувача після @). Зміни будь ласка налаштування безпеки та спробуй наново (наново введи команду /start)."
      );

      return;
    }

    const users = fileHelper.loadUsers();

    const { id: chatId, username } = ctx.from;

    if (users[chatId]) {
      if (users[chatId].username !== username) {
        users[chatId].username = username;
      }
    } else {
      users[chatId] = { username, addedAt: new Date().toISOString() };
    }

    fileHelper.saveUsers(users);

    ctx.reply(
      `Привіт ${username}. Дякую за реєстрацію. Тут будуть приходити сповіщення про призначене на вас замовлення.`
    );
  });

  bot.on("message:video", async (ctx) => await handleVideoMessage(ctx, bot));
  bot.on("message:photo", async (ctx) => await handlePhotoMessage(ctx, bot));

  bot.hears(
    /^статус\s+([а-яіїєґa-zA-Z0-9_]+)\s+([а-яіїєґa-zA-Z0-9_]+)$/i,
    async (ctx) => {
      const parts = ctx.message?.text?.trim().toLowerCase().split(" ");

      if (!parts) {
        return ctx.reply(
          `Формат повідомлення для зміни статусу: статус <філія> <колір>`
        );
      }

      const branch = parts[1] || "null";
      const color = parts[2] || "null";

      if (!STUDIOS.includes(branch)) {
        return ctx.reply(
          `Невідома філія. Можливі варіанти: ${STUDIOS.join(", ")}`
        );
      }

      if (!STATUSES.includes(color)) {
        return ctx.reply(
          `Невідомий статус. Можливі варіанти: ${STATUSES.join(", ")}`
        );
      }

      const studioId = BRANCH_MAP[branch];
      const statusValue = COLOR_MAP[color];

      const filePath = path.join(process.cwd(), "studios.json");
      const file = await fs.readFile(filePath, "utf-8");
      const studios = JSON.parse(file);

      const updated = studios.map((studio: StudioStatus) => {
        if (studio.id === studioId) {
          return {
            ...studio,
            status: statusValue,
            lastUpdated: dayjs().tz(tz).toISOString(),
          };
        }
        return studio;
      });

      await fs.writeFile(filePath, JSON.stringify(updated, null, 2), "utf-8");
      await ctx.reply(`✅ Статус філії "${branch}" змінено на "${color}"`);
    }
  );

  // bot.hears("change_status", async (ctx) => {
  //   const text = ctx.message?.text || "";
  //   const args = text.split(" ");

  //   if (args.length < 3) {
  //     return ctx.reply(
  //       "Використання: /status <філія> <зелений|жовтий|червоний>"
  //     );
  //   }

  //   const branchAlias = args[1]?.toLowerCase();
  //   const color = args[2]?.toLowerCase();

  //   const allowedColors = ["зелений", "жовтий", "червоний"];
  //   const colorMap = {
  //     зелений: "green",
  //     жовтий: "yellow",
  //     червоний: "red",
  //   };

  //   const branchMap = {
  //     файна: "faina",
  //     француз: "francuz",
  //     севен: "seven",
  //   };

  //   const typedBranchAlias = branchAlias as keyof typeof branchMap;

  //   if (!branchMap[typedBranchAlias]) {
  //     return ctx.reply("Невідома філія");
  //   }

  //   if (!allowedColors.includes(color)) {
  //     return ctx.reply("Дозволені кольори: зелений, жовтий, червоний.");
  //   }

  //   const filePath = path.join(process.cwd(), "studios.json");
  //   const file = await fs.readFile(filePath, "utf-8");

  //   const studios = JSON.parse(file);

  //   const updated = studios.map((studio: StudioStatus) => {
  //     if (studio.id === branchMap[typedBranchAlias]) {
  //       return {
  //         ...studio,
  //         status: colorMap[color as keyof typeof colorMap],
  //         lastUpdated: dayjs.tz(tz).toISOString(),
  //       };
  //     }
  //     return studio;
  //   });

  //   await fs.writeFile(filePath, JSON.stringify(updated, null, 2), "utf-8");

  //   ctx.reply(`✅ Статус студії ${branchAlias} змінено на ${color}`);
  // });

  // bot.command("change_status", async (ctx) => {
  //   const keyboard = new InlineKeyboard();

  //   for (const studio of STUDIOS) {
  //     keyboard.text(studio, `select_studio:${studio}`).row();
  //   }

  //   await ctx.reply("Обери філію для зміни статусу:", {
  //     reply_markup: keyboard,
  //   });
  // });
  return bot;
};
