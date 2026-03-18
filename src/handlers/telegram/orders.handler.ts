import type { Context } from "grammy";
import { Bot, Api, RawApi, type HearsContext } from "grammy";
import {
  addTagToOrderInCrm,
  WAREHOUSE_CHAT_ID,
} from "../../services/keycrm.service.js";
import {
  getOrderDetails,
  getUserOrdersSummary,
  type UserOrderSummary,
} from "../../services/telegram/orders.service.js";
import { sendTelegramMessage } from "../../services/telegram/telegramApi.js";
import { escapeAllSymbols } from "../../helpers/messageHelper.js";
import dayjs from "dayjs";
import type { Order } from "../../types/keycrm.js";

const PAGE_SIZE = 10;
const BTN_REFRESH = "🔄 Оновити мої замовлення";
const BTN_REFRESH_ORDER = "🔄 Оновити замовлення";
const BTN_BACK = "Назад";
const BTN_PREV_PREFIX = "« Стор.";
const BTN_NEXT_PREFIX = "Стор. »";

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

const PAYMENT_STATUS_TRANSLATIONS: Record<string, string> = {
  paid: "Оплачено",
  overpaid: "Переплачено",
  unpaid: "Не оплачено",
};

function translateStatus(o: UserOrderSummary): string {
  const byAlias = o.statusAlias
    ? STATUS_TRANSLATIONS[o.statusAlias]
    : undefined;
  if (byAlias) return byAlias;
  const raw = (o.statusName ?? "").trim();
  const key = raw.toLowerCase().replace(/\s+/g, "_");
  return STATUS_TRANSLATIONS[key] ?? raw ?? "—";
}

function translatePaymentStatus(raw: string | undefined | null): string {
  if (!raw) return "—";
  const key = raw.toLowerCase();
  return PAYMENT_STATUS_TRANSLATIONS[key] ?? raw;
}

function translateOrderStatus(alias?: string, name?: string): string {
  if (alias && STATUS_TRANSLATIONS[alias]) return STATUS_TRANSLATIONS[alias];
  const raw = (name ?? "").trim();
  if (!raw) return "—";
  const key = raw.toLowerCase().replace(/\s+/g, "_");
  return STATUS_TRANSLATIONS[key] ?? raw;
}

function formatOrderButtonLabel(order: UserOrderSummary): string {
  const timeWindow = (order.timeWindow?.trim() || "Не визначено").replace(
    /\s+/g,
    " ",
  );
  const label = `${order.id} (${timeWindow})`;
  // Telegram keyboard button text limit ~64 chars
  return label.length > 64
    ? `${order.id} (${timeWindow.slice(0, 55)}…)`
    : label;
}

function buildOrdersReplyKeyboard(
  orders: UserOrderSummary[],
  page: number,
): { keyboard: Array<Array<{ text: string }>>; resize_keyboard: true } {
  const start = page * PAGE_SIZE;
  const slice = orders.slice(start, start + PAGE_SIZE);

  const keyboard: Array<Array<{ text: string }>> = [];
  for (const o of slice) keyboard.push([{ text: formatOrderButtonLabel(o) }]);

  const totalPages = Math.max(1, Math.ceil(orders.length / PAGE_SIZE));
  const navRow: Array<{ text: string }> = [];
  if (totalPages > 1) {
    const prevPage = Math.max(0, page - 1);
    const nextPage = Math.min(totalPages - 1, page + 1);
    navRow.push({ text: `${BTN_PREV_PREFIX}${prevPage + 1}` });
    navRow.push({ text: `${BTN_NEXT_PREFIX}${nextPage + 1}` });
  }
  navRow.push({ text: BTN_REFRESH });
  if (navRow.length) keyboard.push(navRow);

  return { keyboard, resize_keyboard: true };
}

function buildOrdersListText(orders: UserOrderSummary[], page: number): string {
  const start = page * PAGE_SIZE;
  const slice = orders.slice(start, start + PAGE_SIZE);
  const groups: Record<string, UserOrderSummary[]> = {};
  for (const o of slice) {
    const dateKey = o.shippingDateIso
      ? dayjs(o.shippingDateIso).format("DD.MM.YYYY")
      : "Не визначено";
    (groups[dateKey] ||= []).push(o);
  }

  const dateKeys = Object.keys(groups).sort((a, b) => {
    if (a === "Не визначено" && b !== "Не визначено") return 1;
    if (b === "Не визначено" && a !== "Не визначено") return -1;
    const da = dayjs(a, "DD.MM.YYYY");
    const db = dayjs(b, "DD.MM.YYYY");
    if (da.isValid() && db.isValid()) return da.valueOf() - db.valueOf();
    return a.localeCompare(b);
  });

  const sections: string[] = [];
  for (const dateKey of dateKeys) {
    const header = `*${escapeAllSymbols(dateKey)}*\n──────────────`;
    const items = groups[dateKey].map((o) => {
      const timeWindow = o.timeWindow?.trim().length
        ? o.timeWindow
        : "Не визначено";
      const status = escapeAllSymbols(translateStatus(o) || "—");
      const total =
        typeof o.grandTotal === "number" ? `${o.grandTotal} грн` : "—";
      const address = o.address?.trim().length
        ? escapeAllSymbols(o.address)
        : "—";
      return (
        `*${o.id}*\n` +
        `Статус: ${status}\n` +
        `💰 Загальна вартість: ${escapeAllSymbols(total)}\n` +
        `🕒 ${escapeAllSymbols(timeWindow)}\n` +
        `📍 ${address}`
      );
    });
    sections.push([header, ...items].join("\n"));
  }

  return `*Мої замовлення*\n\n${sections.join("\n\n")}`;
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
  const dateIso =
    order.shipping?.shipping_date_actual || order.shipping?.shipping_date;
  const dateStr = dateIso
    ? dayjs(dateIso).format("DD.MM.YYYY")
    : "Не визначено";
  const timeWindow = getTimeWindow(order);

  const products = (order.products ?? [])
    .map((p) => `\\- ${escapeAllSymbols(p.name ?? "—")} x${p.quantity ?? 1}`)
    .join("\n");

  const managerComment = order.manager_comment
    ? escapeAllSymbols(String(order.manager_comment))
    : "—";
  const clientComment = order.buyer_comment
    ? escapeAllSymbols(String(order.buyer_comment))
    : "—";
  const giftMessage = order.gift_message
    ? escapeAllSymbols(String(order.gift_message))
    : "—";

  const balloons = getCustomFieldValue(order, "OR_1017", "кульки") ?? "—";
  const compositions = getCustomFieldValue(order, "OR_1015", "комп") ?? "—";

  const tagXL = (order.tags ?? []).some((t) =>
    /(^|\\s)(XL|XXL)(\\s|$)/i.test(String(t.name ?? "")),
  );
  const paymentStatus = translatePaymentStatus(order.payment_status);
  const anyStatus = order.status as unknown as { alias?: string; name?: string } | undefined;
  const orderStatus = translateOrderStatus(anyStatus?.alias, anyStatus?.name);

  const productsTotal = (order.products ?? []).reduce((sum, p) => {
    const anyProduct = p as unknown as {
      price_sold?: number;
      price?: number;
      quantity?: number;
    };
    const price = Number(anyProduct.price_sold ?? anyProduct.price ?? 0);
    const qty = Number(anyProduct.quantity ?? 0);
    return sum + price * qty;
  }, 0);

  const paidTotal = (order.payments ?? []).reduce((sum, payment) => {
    const anyPayment = payment as unknown as { amount?: number };
    return sum + Number(anyPayment.amount ?? 0);
  }, 0);

  const city = order.shipping?.shipping_address_city
    ? `${order.shipping.shipping_address_city}, `
    : "";
  const street = order.shipping?.shipping_receive_point
    ? `${order.shipping.shipping_receive_point}, `
    : "";
  const secondary = order.shipping?.shipping_secondary_line
    ? `${order.shipping.shipping_secondary_line}`
    : "";
  const address = `${city}${street}${secondary}`
    .replace(/,\\s*,/g, ", ")
    .replace(/,\\s*$/, "")
    .trim();
  const addressText = address ? escapeAllSymbols(address) : "—";

  const lines: string[] = [];

  lines.push(
    `*Замовлення ${order.id}*`,
    `📆 ${escapeAllSymbols(dateStr)}`,
    `*Статус замовлення:* ${escapeAllSymbols(orderStatus)}`,
    `🕒 Час доставки/самовивозу: ${escapeAllSymbols(timeWindow)}`,
  );

  if (products) {
    lines.push(`\n*Товари:*\n${products}`);
  }

  if (productsTotal > 0 || paidTotal > 0) {
    const totalStr = productsTotal.toFixed(2).replace(".", "\\.");
    const paidStr = paidTotal.toFixed(2).replace(".", "\\.");
    lines.push(
      `\n*Сума товарів:* ${totalStr} грн`,
      `*Сплачено:* ${paidStr} грн`,
    );
  }

  if (managerComment !== "—") {
    lines.push(`\n*Коментар менеджера:*\n${managerComment}`);
  }

  if (clientComment !== "—") {
    lines.push(`\n*Коментар клієнта:*\n${clientComment}`);
  }

  if (giftMessage !== "—") {
    lines.push(`\n*Листівка:* ${giftMessage}`);
  }

  if (balloons !== "—") {
    lines.push(`*Кульки:* ${escapeAllSymbols(String(balloons))}`);
  }

  if (compositions !== "—") {
    lines.push(
      `*Кількість композицій:* ${escapeAllSymbols(String(compositions))}`,
    );
  }

  if (tagXL) {
    lines.push(`*XL/XXL:* Так`);
  }

  lines.push(`\n*Статус оплати:* ${escapeAllSymbols(paymentStatus)}`);

  if (addressText !== "—") {
    lines.push(`*Адреса доставки:* ${addressText}`);
  }

  return lines.join("\n");
}

export async function handleStart(ctx: Context): Promise<void> {
  await ctx.reply("Привіт! Ви успішно авторизовані у системі.", {
    reply_markup: {
      remove_keyboard: true,
    },
  });
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

    const page = 0;
    await ctx.reply(buildOrdersListText(summary, page), {
      parse_mode: "MarkdownV2",
      reply_markup: buildOrdersReplyKeyboard(summary, page),
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

export async function handleAddTag(ctx: HearsContext<Context>): Promise<void> {
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

export function registerOrderHandlers(bot: Bot<Context, Api<RawApi>>): void {
  bot.command("start", async (ctx) => handleStart(ctx));
  bot.command("my_orders", async (ctx) => handleMyOrders(ctx));
  bot.hears(/^друк\s\d+$/i, async (ctx) => handlePrint(ctx));
  bot.hears(/^(\d+)\s+в\s+(.+)$/i, async (ctx) => handleAddTag(ctx));

  const showOrdersPage = async (ctx: Context, page: number) => {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;
    const summary = await getUserOrdersSummary(telegramId);
    if (!summary || summary.length === 0) {
      await ctx.reply("Наразі у вас немає активних замовлень", {
        reply_markup: { remove_keyboard: true },
      });
      return;
    }
    const totalPages = Math.max(1, Math.ceil(summary.length / PAGE_SIZE));
    const safePage = Math.min(Math.max(0, page), totalPages - 1);
    await ctx.reply(buildOrdersListText(summary, safePage), {
      parse_mode: "MarkdownV2",
      reply_markup: buildOrdersReplyKeyboard(summary, safePage),
    });
  };

  const parsePageFromButton = (text: string): number | null => {
    const mPrev = text.match(/^«\s*Стор\.(\d+)$/);
    if (mPrev) return Math.max(0, parseInt(mPrev[1], 10) - 1);
    const mNext = text.match(/^Стор\.\s*»\s*(\d+)$/);
    if (mNext) return Math.max(0, parseInt(mNext[1], 10) - 1);
    if (/^🔄\s*Оновити$/i.test(text.trim())) return 0;
    return null;
  };

  bot.hears(/^🔄\s*Оновити мої замовлення$/i, async (ctx) => {
    await showOrdersPage(ctx, 0);
  });
  bot.hears(/^«\s*Стор\.\d+$/i, async (ctx) => {
    const page = parsePageFromButton(ctx.message?.text ?? "") ?? 0;
    await showOrdersPage(ctx, page);
  });
  bot.hears(/^Стор\.\s*»\s*\d+$/i, async (ctx) => {
    const page = parsePageFromButton(ctx.message?.text ?? "") ?? 0;
    await showOrdersPage(ctx, page);
  });

  bot.hears(new RegExp(`^${BTN_BACK}$`, "i"), async (ctx) => {
    await showOrdersPage(ctx, 0);
  });

  bot.hears(/^\d+\s*\(.+\)$/, async (ctx) => {
    const text = ctx.message?.text ?? "";
    const m = text.match(/^(\d+)/);
    const orderId = m ? parseInt(m[1], 10) : NaN;
    if (!orderId) return;
    const loadingMsg = await ctx.reply("Завантажую…");

    const order = await getOrderDetails(orderId);
    if (!order) {
      await ctx.reply("Не вдалося отримати замовлення. Спробуйте пізніше.");
      return;
    }

    try {
      if (ctx.chat?.id && loadingMsg.message_id) {
        await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id);
      }
    } catch {
      // ignore
    }

    const detailsText = buildOrderDetailsText(order as OrderWithAttachments);
    await ctx.reply(detailsText, {
      parse_mode: "MarkdownV2",
      reply_markup: {
        keyboard: [
          [{ text: BTN_BACK }, { text: `${BTN_REFRESH_ORDER} ${orderId}` }],
        ],
        resize_keyboard: true,
      },
    });
  });

  bot.hears(/Оновити замовлення\s+(\d+)$/i, async (ctx) => {
    const text = ctx.message?.text ?? "";
    const m = text.match(/(\d+)$/);
    const orderId = m ? parseInt(m[1], 10) : NaN;
    if (!orderId) return;

    const order = await getOrderDetails(orderId);
    if (!order) {
      await ctx.reply("Не вдалося оновити замовлення. Спробуйте пізніше.");
      return;
    }

    const detailsText = buildOrderDetailsText(order as OrderWithAttachments);
    await ctx.reply(detailsText, {
      parse_mode: "MarkdownV2",
      reply_markup: {
        keyboard: [
          [{ text: BTN_BACK }, { text: `${BTN_REFRESH_ORDER} ${orderId}` }],
        ],
        resize_keyboard: true,
      },
    });
  });
}
