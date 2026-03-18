import type { Context } from "grammy";
import { Bot, Api, RawApi, type HearsContext } from "grammy";
import {
  addTagToOrderInCrm,
  WAREHOUSE_CHAT_ID,
} from "../../services/keycrm.service.js";
import { getUserOrdersFormatted } from "../../services/telegram/orders.service.js";
import { sendTelegramMessage } from "../../services/telegram/telegramApi.js";

export async function handleStart(ctx: Context): Promise<void> {
  await ctx.reply(
    "Привіт! Якщо у вас є username в Telegram — ми спробуємо авторизувати вас автоматично. Інакше поділіться контактом або введіть ваш логін (username) чи номер телефону текстом.",
    {
      reply_markup: {
        keyboard: [[{ text: "Поділитися контактом", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    }
  );
}

export async function handleMyOrders(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  try {
    const messages = await getUserOrdersFormatted(telegramId);
    
    if (!messages || messages.length === 0) {
      await ctx.reply("Наразі у вас немає активних замовлень");
      return;
    }
    
    for (const text of messages) {
      if (text.trim()) {
        await ctx.reply(text, { parse_mode: "MarkdownV2" });
      }
    }
  } catch (error) {
    console.error("Orders Handler Error", error);
    await ctx.reply("Виникла помилка під час обробки. Спробуйте пізніше.");
  }
}

export async function handlePrint(ctx: Context): Promise<void> {
  try {
    if (!ctx.message?.text) return;

    const messageText = ctx.message.text.trim();
    const orderId = messageText.split(" ")[1];

    if (!orderId) {
      await ctx.reply(
        "Будь ласка, введіть коректний номер замовлення. Приклад: 'Друк 1234'",
      );
      return;
    }

    const printUrl = `http://194.113.32.44/print/${orderId}`;

    await ctx.reply(
      `🖨 Для друку замовлення натисніть на посилання:\n${printUrl}`,
    );
  } catch (error) {
    console.error("Помилка при обробці запиту на друк:", error);
    await ctx.reply("❌ Виникла помилка. Будь ласка, спробуйте ще раз.");
  }
}

export async function handleAddTag(
  ctx: HearsContext<Context>,
  _bot: Bot<Context, Api<RawApi>>,
): Promise<void> {
  try {
    if (!ctx.message?.text) return;

    const orderId = ctx.match?.[1];
    if (!orderId) {
      await ctx.reply(
        "Будь ласка, введіть коректний номер замовлення. Приклад: '1234 в тег'",
      );
      return;
    }

    const extraArgument = (ctx.match?.[2] ?? "").trim();
    const result = await addTagToOrderInCrm(Number(orderId), extraArgument);

    await ctx.reply(result.userMessage);

    if (result.success && result.warehouseMessage) {
      await sendTelegramMessage(WAREHOUSE_CHAT_ID, result.warehouseMessage);
    }
  } catch (error) {
    console.error("Помилка при обробці запиту:", error);
    await ctx.reply("❌ Виникла помилка. Будь ласка, спробуйте ще раз.");
  }
}

export function registerOrderHandlers(
  bot: Bot<Context, Api<RawApi>>,
): void {
  bot.command("start", async (ctx) => handleStart(ctx));
  bot.command("my_orders", async (ctx) => handleMyOrders(ctx));
  bot.hears(/^друк\s\d+$/i, async (ctx) => handlePrint(ctx));
  bot.hears(/^(\d+)\s+в\s+(.+)$/i, async (ctx) => handleAddTag(ctx, bot));
}
