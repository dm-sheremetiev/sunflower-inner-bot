import type { Context } from "grammy";
import { Bot, Api, RawApi, InlineKeyboard } from "grammy";
import { zReportChatId, xReportChatId } from "../../services/telegram/config.js";
import {
  reportSessions,
  pendingReportStartMessageIds,
  pendingReportStartBotMessageIds,
  getReportSteps,
  cleanupExpiredReportSessions,
  buildReportSummaryText,
  getCurrentStep,
  createReportSession,
  applyTextStep,
  applyChoiceStep,
  goToNextStep,
  type ReportType,
  type ReportSession,
} from "../../services/telegram/reportWizard.service.js";

export type { ReportType };

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
  const step = getCurrentStep(session);
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
  createReportSession(
    chatId,
    ctx.from.username,
    reportType,
    initialPhotoFileIds,
    allMsgIds,
  );
  const session = reportSessions.get(chatId)!;
  await sendNextReportStep(ctx, bot, session);
}

export { reportSessions, getReportSteps, cleanupExpiredReportSessions };

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
      createReportSession(
        chatId,
        ctx.from.username,
        reportType,
        [],
        messageIdsToDelete,
        botMessageIdsToDelete,
      );
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
      goToNextStep(session);
      await sendNextReportStep(ctx, bot, session);
      return;
    }

    if (data.startsWith("report:ch:")) {
      const parts = data.split(":");
      if (parts.length < 5) return;
      const [, , , stepId, idxStr] = parts;
      const choiceIndex = parseInt(idxStr, 10);
      if (Number.isNaN(choiceIndex)) return;
      if (!applyChoiceStep(session, stepId, choiceIndex)) return;
      await sendNextReportStep(ctx, bot, session);
    }
  });

  const startReportWizard = async (ctx: Context, reportType: ReportType) => {
    if (!ctx.from?.username || !ctx.chat?.id) return;
    const chatId = String(ctx.chat.id);
    const msgId = ctx.message?.message_id;
    createReportSession(
      chatId,
      ctx.from.username,
      reportType,
      [],
      msgId != null ? [msgId] : [],
    );
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
      createReportSession(
        chatId,
        ctx.from.username,
        reportType,
        [],
        session.messageIdsToDelete,
        session.botMessageIdsToDelete,
      );
      const newSession = reportSessions.get(chatId)!;
      await sendNextReportStep(ctx, bot, newSession);
      return;
    }

    const step = getCurrentStep(session);
    if (!step || step.input !== "text") return next();

    applyTextStep(session, text);
    await sendNextReportStep(ctx, bot, session);
  });
}
