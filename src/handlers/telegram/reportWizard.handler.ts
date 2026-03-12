import dayjs from "dayjs";
import type { Context } from "grammy";
import { Bot, Api, RawApi, InlineKeyboard } from "grammy";
import { tz, zReportChatId, xReportChatId } from "./config.js";

import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export type ReportType = "x" | "z";

export interface ReportSession {
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

export interface ReportStepConfig {
  id: string;
  question: string;
  input: ReportStepInput;
  choices?: [string, string][];
  dataKey?: string;
  default?: string;
}

export const reportSessions = new Map<string, ReportSession>();
export const pendingReportStartMessageIds = new Map<string, number>();
export const pendingReportStartBotMessageIds = new Map<string, number>();

const REPORT_SALONS: [string, string][] = [
  ["Файна", "Файна"],
  ["Француз", "Француз"],
  ["Севен", "Севен"],
  ["Республіка", "Республіка"],
];

const X_REPORT_STEPS: ReportStepConfig[] = [
  {
    id: "x_date",
    question: "📆 Дата (наприклад 03.03.2026)",
    input: "text",
    dataKey: "date",
  },
  {
    id: "x_admin",
    question: "👤 Адміністратор (ваш нік або ПІБ)",
    input: "text",
    dataKey: "administrator",
  },
  {
    id: "x_salon",
    question: "🏪 Салон",
    input: "choice",
    choices: REPORT_SALONS,
    dataKey: "salon",
  },
  {
    id: "x_cash",
    question: "💵 Готівка в касі",
    input: "text",
    dataKey: "cash",
  },
  {
    id: "x_photo",
    question: "📷 Надішліть фото звіту (одне або альбом)",
    input: "photo",
  },
];

const Z_REPORT_STEPS: ReportStepConfig[] = [
  {
    id: "z_date",
    question: "📆 Дата (наприклад 03.03.2026)",
    input: "text",
    dataKey: "date",
  },
  {
    id: "z_salon",
    question: "🏪 Салон",
    input: "choice",
    choices: REPORT_SALONS,
    dataKey: "salon",
  },
  {
    id: "z_cash_day",
    question: "🖥 Каса за день",
    input: "text",
    dataKey: "cash_day",
  },
  {
    id: "z_delivery",
    question: "🚙 Доставка",
    input: "text",
    dataKey: "delivery",
  },
  {
    id: "z_pass_through",
    question: "🚶🏻‍♂️‍➡️ Прохідні",
    input: "text",
    dataKey: "pass_through",
  },
  {
    id: "z_write_off",
    question: "✅ Списання внесено",
    input: "choice",
    choices: [
      ["Так", "Так"],
      ["Ні", "Ні"],
    ],
    dataKey: "write_off_done",
  },
  {
    id: "z_cash",
    question: "💵 Готівка в касі",
    input: "text",
    dataKey: "cash",
  },
  {
    id: "z_comment",
    question: "💬 Коментар (або напишіть —)",
    input: "text",
    dataKey: "comment",
  },
  {
    id: "z_admin",
    question: "👤 Адміністратор (ваш нік або ПІБ)",
    input: "text",
    dataKey: "administrator",
  },
  {
    id: "z_photo",
    question: "📷 Надішліть фото звіту (одне або альбом)",
    input: "photo",
  },
];

export function getReportSteps(type: ReportType): ReportStepConfig[] {
  return type === "x" ? X_REPORT_STEPS : Z_REPORT_STEPS;
}

export function cleanupExpiredReportSessions(): void {
  const nowKyiv = dayjs().tz(tz);
  for (const [chatId, session] of reportSessions.entries()) {
    const createdKyiv = dayjs(session.createdAt).tz(tz);
    if (nowKyiv.diff(createdKyiv, "hour") >= 48) {
      reportSessions.delete(chatId);
    }
  }
}

export function buildReportSummaryText(session: ReportSession): string {
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

export async function sendReportToChannel(
  bot: Bot<Context, Api<RawApi>>,
  session: ReportSession,
): Promise<void> {
  const targetChatId =
    session.reportType === "z" ? zReportChatId : xReportChatId;
  const caption =
    `Звіт від @${session.username}\n\n` + buildReportSummaryText(session);

  if (session.photoFileIds.length === 0) {
    await bot.api.sendMessage(targetChatId, caption);
    return;
  }
  if (session.photoFileIds.length === 1) {
    await bot.api.sendPhoto(targetChatId, session.photoFileIds[0], {
      caption,
    });
    return;
  }
  const media = session.photoFileIds.map((fileId, i) => ({
    type: "photo" as const,
    media: fileId,
    caption: i === 0 ? caption : undefined,
  }));
  await bot.api.sendMediaGroup(targetChatId, media);
}

export async function sendNextReportStep(
  ctx: Context,
  bot: Bot<Context, Api<RawApi>>,
  session: ReportSession,
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
      keyboard
        .text(label, `report:ch:${session.reportType}:${step.id}:${idx}`)
        .row();
    });
    const msg = await ctx.reply(step.question, { reply_markup: keyboard });
    if (msg?.message_id) session.botMessageIdsToDelete.push(msg.message_id);
    return;
  }
  if (step.input === "photo" && session.photoFileIds.length > 0) {
    const keyboard = new InlineKeyboard().text("Далі", "report:step:next");
    const msg = await ctx.reply(
      `У вас є ${session.photoFileIds.length} фото. Надішліть ще або натисніть Далі.`,
      { reply_markup: keyboard },
    );
    if (msg?.message_id) session.botMessageIdsToDelete.push(msg.message_id);
    return;
  }
  const msg = await ctx.reply(step.question);
  if (msg?.message_id) session.botMessageIdsToDelete.push(msg.message_id);
}

export async function sendReportConfirmStep(
  ctx: Context,
  bot: Bot<Context, Api<RawApi>>,
  session: ReportSession,
): Promise<void> {
  const text =
    buildReportSummaryText(session) +
    `\n\n📷 Фото: ${session.photoFileIds.length} шт.`;
  const keyboard = new InlineKeyboard()
    .text("Відправити звіт", "report:confirm:yes")
    .text("Скасувати", "report:confirm:no");
  const msg = await ctx.reply(text, { reply_markup: keyboard });
  if (msg?.message_id) session.botMessageIdsToDelete.push(msg.message_id);
}

export async function startReportSession(
  ctx: Context,
  bot: Bot<Context, Api<RawApi>>,
  reportType: ReportType,
  initialPhotoFileIds: string[] = [],
  initialMessageIds: number[] = [],
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

export function registerReportWizard(
  bot: Bot<Context, Api<RawApi>>,
): void {
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
            /* ignore */
          }
        }
        for (const msgId of session.botMessageIdsToDelete) {
          try {
            await ctx.api.deleteMessage(session.chatId, msgId);
          } catch {
            /* ignore */
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
    }
  });

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
    const sent = await ctx.reply("Оберіть тип звіту:", {
      reply_markup: keyboard,
    });
    if (chatId != null && sent?.message_id) {
      pendingReportStartBotMessageIds.set(chatId, sent.message_id);
    }
  };

  bot.command("report", async (ctx) => showReportTypeChoice(ctx));
  bot.hears(/відправити\s+звіт/i, async (ctx) => showReportTypeChoice(ctx));

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
}
