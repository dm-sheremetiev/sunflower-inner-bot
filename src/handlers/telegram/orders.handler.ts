import dayjs from "dayjs";
import type { Context } from "grammy";
import { Bot, Api, RawApi, type HearsContext } from "grammy";
import { fileHelper } from "../../helpers/fileHelper.js";
import { fetchAllOrders } from "../../helpers/keycrmHelper.js";
import { messageHelper } from "../../helpers/messageHelper.js";
import { addTagToOrder } from "../../services/keycrm.service.js";

export async function handleStart(ctx: Context): Promise<void> {
  if (!ctx.from?.username) {
    await ctx.reply(
      "Наш бот не бачить твій nickname (ім'я користувача після @). Зміни будь ласка налаштування безпеки та спробуй наново (наново введи команду /start).",
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

  await ctx.reply(
    `Привіт ${username}. Дякую за реєстрацію. Тут будуть приходити сповіщення про призначене на вас замовлення.`,
  );
}

export async function handleMyOrders(ctx: Context): Promise<void> {
  if (!ctx.from?.username) {
    await ctx.reply(
      "Наш бот не бачить твій nickname (ім'я користувача після @). Зміни будь ласка налаштування безпеки та спробуй наново (наново введи команду /start).",
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

  const startOfToday = dayjs().startOf("day").format("YYYY-MM-DD HH:mm:ss");
  const endOfNextDay = dayjs()
    .add(5, "day")
    .endOf("day")
    .format("YYYY-MM-DD HH:mm:ss");
  const shippingBetween = `${startOfToday},${endOfNextDay}`;

  const orders = await fetchAllOrders(shippingBetween);

  await ctx.reply(messageHelper.formatMyOrdersMessage(orders, username), {
    parse_mode: "MarkdownV2",
  });
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
  bot: Bot<Context, Api<RawApi>>,
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
    await addTagToOrder(ctx, Number(orderId), bot, extraArgument);
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
