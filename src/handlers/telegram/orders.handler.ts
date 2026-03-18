import type { Context } from "grammy";
import { Bot, Api, RawApi, InlineKeyboard, type HearsContext } from "grammy";
import {
  addTagToOrderInCrm,
  WAREHOUSE_CHAT_ID,
} from "../../services/keycrm.service.js";
import { getOrderDetails, getUserOrdersSummary, type UserOrderSummary } from "../../services/telegram/orders.service.js";
import { sendTelegramMessage } from "../../services/telegram/telegramApi.js";
import { escapeAllSymbols } from "../../helpers/messageHelper.js";
import dayjs from "dayjs";
import type { Order } from "../../types/keycrm.js";

const PAGE_SIZE = 10;
const myOrdersState = new Map<number, { orders: UserOrderSummary[] }>();

const STATUS_TRANSLATIONS: Record<string, string> = {
  new: "Нове замовлення",
  waiting_for_prepayment: "Очікує передоплату",
  delivered_to_delivery: "Передано в доставку",
  delivered: "Доставляється",
  completed: "Виконано",
  incorrect_data: "Помилкові дані",
  underbid: "Перебито",
  not_available: "Недоступний",
  bought_elsewhere: "Купили в іншому місці",
  delivery_did_not_arrange: "Доставку не домовились",
  did_not_arrange_price: "Не домовились по ціні",
  canceled: "Скасовано",
  delivering: "Доставляється",
};

function translateStatus(o: UserOrderSummary): string {
  const byAlias = o.statusAlias ? STATUS_TRANSLATIONS[o.statusAlias] : undefined;
  if (byAlias) return byAlias;
  const raw = (o.statusName ?? "").trim();
  const key = raw.toLowerCase().replace(/\s+/g, "_");
  return STATUS_TRANSLATIONS[key] ?? raw ?? "—";
}

function formatOrderButtonLabel(order: UserOrderSummary): string {
  const timeWindow = (order.timeWindow?.trim() || "Не визначено").replace(/\s+/g, " ");
  const suffix = ` (${timeWindow})`;
  const label = `${order.id}${suffix}`;
  // Telegram button text limit is 64 chars
  return label.length > 64 ? `${order.id} (${timeWindow.slice(0, 55)}…)` : label;
}

function buildOrdersListKeyboard(orders: UserOrderSummary[], page: number): InlineKeyboard {
  const orderIds = orders.map((o) => o.id);
  const start = page * PAGE_SIZE;
  const slice = orders.slice(start, start + PAGE_SIZE);

  const kb = new InlineKeyboard();
  for (const o of slice) {
    kb.text(formatOrderButtonLabel(o), `my_orders:open:${o.id}:${page}`).row();
  }

  const totalPages = Math.max(1, Math.ceil(orderIds.length / PAGE_SIZE));
  if (totalPages <= 1) return kb;

  const prevPage = Math.max(0, page - 1);
  const nextPage = Math.min(totalPages - 1, page + 1);

  kb.text("«", `my_orders:list:${prevPage}`);
  kb.text(`${page + 1}/${totalPages}`, "my_orders:noop");
  kb.text("»", `my_orders:list:${nextPage}`);
  return kb;
}

function buildOrdersListText(orders: UserOrderSummary[], page: number): string {
  const start = page * PAGE_SIZE;
  const slice = orders.slice(start, start + PAGE_SIZE);
  const lines = slice.map((o) => {
    const date = o.shippingDateIso ? dayjs(o.shippingDateIso).format("DD.MM.YYYY") : "Не визначено";
    const timeWindow = o.timeWindow?.trim().length ? o.timeWindow : "Не визначено";
    const status = escapeAllSymbols(translateStatus(o) || "—");
    const total = typeof o.grandTotal === "number" ? `${o.grandTotal} грн` : "—";
    const address = o.address?.trim().length ? escapeAllSymbols(o.address) : "—";
    return (
      `*${o.id}* \\(${escapeAllSymbols(date)}\\)\n` +
      `Статус: ${status}\n` +
      `💰 Загальна вартість: ${escapeAllSymbols(total)}\n` +
      `🕒 ${escapeAllSymbols(timeWindow)}\n` +
      `📍 ${address}`
    );
  });

  return `*Мої замовлення*\n\n${lines.join("\n\n")}`;
}

type CustomFieldLike = { uuid?: string; name?: string; value?: unknown };
type OrderWithCustomFields = { custom_fields?: CustomFieldLike[] };

function getTimeWindow(order: OrderWithCustomFields): string {
  const field = order.custom_fields?.find((f) => {
    const name = String(f.name ?? "").toLowerCase();
    return f.uuid === "OR_1006" || name.includes("часовий проміжок");
  });
  const raw = field?.value;
  const v = raw != null ? String(raw).trim() : "";
  return v.length ? v : "Не визначено";
}

function getCustomFieldValue(
  order: OrderWithCustomFields,
  uuid: string,
  nameIncludes: string,
): string | null {
  const needle = nameIncludes.toLowerCase();
  const f = order.custom_fields?.find((x) => {
    const name = String(x.name ?? "").toLowerCase();
    return x.uuid === uuid || name.includes(needle);
  });
  const value = f?.value;
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value === "boolean") return value ? "Так" : "Ні";
  if (Array.isArray(value)) return value.map(String).join(", ");
  return String(value);
}

type OrderWithAttachments = Order &
  OrderWithCustomFields & {
    attachments?: Array<{ file?: { url?: string } }>;
    shipping?: (Order["shipping"] & { shipping_date?: string }) | undefined;
  };

function buildOrderDetailsText(order: OrderWithAttachments): string {
  const dateIso = order.shipping?.shipping_date_actual || order.shipping?.shipping_date;
  const dateStr = dateIso ? dayjs(dateIso).format("DD.MM.YYYY") : "Не визначено";
  const timeWindow = getTimeWindow(order);

  const products = (order.products ?? [])
    .map((p) => `- ${escapeAllSymbols(p.name ?? "—")} x${p.quantity ?? 1}`)
    .join("\n");

  const managerComment = order.manager_comment ? escapeAllSymbols(String(order.manager_comment)) : "—";
  const clientComment = order.buyer_comment ? escapeAllSymbols(String(order.buyer_comment)) : "—";
  const giftMessage = order.gift_message ? escapeAllSymbols(String(order.gift_message)) : "—";

  const balloons = getCustomFieldValue(order, "OR_1017", "кульки") ?? "—";
  const compositions = getCustomFieldValue(order, "OR_1015", "комп") ?? "—";

  const tagXL = (order.tags ?? []).some((t) =>
    /(^|\\s)(XL|XXL)(\\s|$)/i.test(String(t.name ?? "")),
  );
  const paymentStatus = order.payment_status ? escapeAllSymbols(String(order.payment_status)) : "—";

  const city = order.shipping?.shipping_address_city ? `${order.shipping.shipping_address_city}, ` : "";
  const street = order.shipping?.shipping_receive_point ? `${order.shipping.shipping_receive_point}, ` : "";
  const secondary = order.shipping?.shipping_secondary_line ? `${order.shipping.shipping_secondary_line}` : "";
  const address = `${city}${street}${secondary}`.replace(/,\\s*,/g, ", ").replace(/,\\s*$/, "").trim();
  const addressText = address ? escapeAllSymbols(address) : "—";

  return (
    `*Замовлення ${order.id}*\n` +
    `📆 ${escapeAllSymbols(dateStr)}\n` +
    `🕒 ${escapeAllSymbols(timeWindow)}\n\n` +
    `*Товари:*\n${products || "—"}\n\n` +
    `*Коментар менеджера:*\n${managerComment}\n\n` +
    `*Коментар клієнта:*\n${clientComment}\n\n` +
    `*Листівка:* ${giftMessage}\n` +
    `*Кульки:* ${escapeAllSymbols(String(balloons))}\n` +
    `*К-сть композицій:* ${escapeAllSymbols(String(compositions))}\n` +
    `*XL/XXL:* ${tagXL ? "Так" : "Ні"}\n\n` +
    `*Статус оплати:* ${paymentStatus}\n` +
    `*Адреса доставки:* ${addressText}`
  );
}

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
    const summary = await getUserOrdersSummary(telegramId);
    if (!summary || summary.length === 0) {
      await ctx.reply("Наразі у вас немає активних замовлень");
      return;
    }

    myOrdersState.set(telegramId, { orders: summary });

    const page = 0;
    await ctx.reply(buildOrdersListText(summary, page), {
      parse_mode: "MarkdownV2",
      reply_markup: buildOrdersListKeyboard(summary, page),
    });
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
  bot.hears(/^(\d+)\s+в\s+(.+)$/i, async (ctx) => handleAddTag(ctx));

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("my_orders:")) return;
    await ctx.answerCallbackQuery();

    const telegramId = ctx.from?.id;
    if (!telegramId) return;
    const state = myOrdersState.get(telegramId);
    if (!state) return;

    if (data === "my_orders:noop") return;

    const parts = data.split(":");
    if (parts[1] === "list") {
      const page = Number(parts[2] ?? "0") || 0;
      const text = buildOrdersListText(state.orders, page);
      const kb = buildOrdersListKeyboard(state.orders, page);
      try {
        await ctx.editMessageText(text, { parse_mode: "MarkdownV2", reply_markup: kb });
      } catch {
        await ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: kb });
      }
      return;
    }

    if (parts[1] === "open") {
      const orderId = Number(parts[2]);
      const page = Number(parts[3] ?? "0") || 0;
      if (!orderId) return;

      const order = await getOrderDetails(orderId);
      if (!order) {
        await ctx.reply("Не вдалося отримати замовлення. Спробуйте пізніше.");
        return;
      }

      const kb = new InlineKeyboard().text("Назад", `my_orders:list:${page}`);
      const detailsText = buildOrderDetailsText(order as OrderWithAttachments);
      try {
        await ctx.editMessageText(detailsText, { parse_mode: "MarkdownV2", reply_markup: kb });
      } catch {
        await ctx.reply(detailsText, { parse_mode: "MarkdownV2", reply_markup: kb });
      }

      const attachments = (order as OrderWithAttachments).attachments ?? [];
      const urls: string[] = attachments
        .map((a) => a.file?.url)
        .filter((u): u is string => typeof u === "string" && u.startsWith("http"));

      for (const url of urls.slice(0, 10)) {
        try {
          await ctx.replyWithPhoto(url);
        } catch {
          // ignore
        }
      }
    }
  });
}
