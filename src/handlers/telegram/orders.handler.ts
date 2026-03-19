import type { Context } from "grammy";
import { Bot, Api, RawApi, type HearsContext } from "grammy";
import {
  addTagToOrderInCrm,
  changeOrderStatus,
  sendUploadedImageToCustomerChat,
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
const BTN_BACK = "Назад";
const BTN_PREV_PREFIX = "« Стор.";
const BTN_NEXT_PREFIX = "Стор. »";

const awaitingOrderId = new Map<number, true>();

type CompositionAttachmentIndex = 0 | 1;

type CompositionPhotoSession = {
  orderId: number;
  attachmentIndex: CompositionAttachmentIndex;
  photoFileId?: string;
  createdAt: number;
};

const awaitingCompositionPhoto = new Map<string, CompositionPhotoSession>();

const COMPOSITION_PHOTO_SESSION_TTL_MS = 10 * 60 * 1000;

const COMPOSITION_BARE_STATUS_ID =
  process?.env?.COMPOSITION_BARE_STATUS_ID ?? "24";
const COMPOSITION_PACKED_STATUS_ID =
  process?.env?.COMPOSITION_PACKED_STATUS_ID ?? "26";

const COMP_PHOTO_ATTACH_PREFIX = "comp:attach:";
const COMP_PHOTO_CONFIRM_PREFIX = "comp:confirm:";
const COMP_PHOTO_CANCEL_PREFIX = "comp:cancel:";

function buildCompositionAttachInlineKeyboard(orderId: number) {
  return {
    inline_keyboard: [
      [
        {
          text: "Прикріпити фото збірки",
          callback_data: `${COMP_PHOTO_ATTACH_PREFIX}0:${orderId}`,
        },
      ],
      [
        {
          text: "Прикріпити фото з пакуванням",
          callback_data: `${COMP_PHOTO_ATTACH_PREFIX}1:${orderId}`,
        },
      ],
    ],
  };
}

function buildCompositionConfirmInlineKeyboard(
  attachmentIndex: CompositionAttachmentIndex,
  orderId: number,
) {
  return {
    inline_keyboard: [
      [
        {
          text: "Надіслати це фото та змінити статус",
          callback_data: `${COMP_PHOTO_CONFIRM_PREFIX}${attachmentIndex}:${orderId}`,
        },
      ],
      [
        {
          text: "Відміна",
          callback_data: `${COMP_PHOTO_CANCEL_PREFIX}${attachmentIndex}:${orderId}`,
        },
      ],
    ],
  };
}

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
  not_paid: "Не оплачено",
  unpaid: "Не оплачено",
  part_paid: "Часткова оплата",
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
  const anyStatus = order.status as unknown as
    | { alias?: string; name?: string }
    | undefined;
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
    `🕒 Час доставки/самовивозу: ${escapeAllSymbols(timeWindow)}`,
    `*Статус замовлення:* ${escapeAllSymbols(orderStatus)}`,
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
  bot.command("order", async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;
    awaitingOrderId.set(telegramId, true);
    await ctx.reply(
      "Введіть номер замовлення (ID).",
      { reply_markup: { remove_keyboard: true } },
    );
  });
  bot.hears(/^друк\s\d+$/i, async (ctx) => handlePrint(ctx));
  bot.hears(/^(\d+)\s+в\s+(.+)$/i, async (ctx) => handleAddTag(ctx));

  bot.on("callback_query", async (ctx, next) => {
    try {
      const data = ctx.callbackQuery?.data;
      if (!data || !ctx.chat?.id) return next();

      const chatId = String(ctx.chat.id);

      if (data.startsWith(COMP_PHOTO_ATTACH_PREFIX)) {
        const rest = data.slice(COMP_PHOTO_ATTACH_PREFIX.length);
        const [attachmentIndexRaw, orderIdRaw] = rest.split(":");
        const attachmentIndex = Number(attachmentIndexRaw) as CompositionAttachmentIndex;
        const orderId = Number(orderIdRaw);

        if (
          (attachmentIndex !== 0 && attachmentIndex !== 1) ||
          Number.isNaN(orderId) ||
          orderId <= 0
        ) {
          await ctx.answerCallbackQuery({ text: "Невірні параметри." });
          return;
        }

        awaitingCompositionPhoto.set(chatId, {
          orderId,
          attachmentIndex,
          photoFileId: undefined,
          createdAt: Date.now(),
        });

        await ctx.answerCallbackQuery();
        await ctx.reply(
          "Надішліть фото одним повідомленням. Якщо фото буде кілька — візьмемо перше.",
        );
        return;
      }

      if (data.startsWith(COMP_PHOTO_CANCEL_PREFIX)) {
        const rest = data.slice(COMP_PHOTO_CANCEL_PREFIX.length);
        const [attachmentIndexRaw, orderIdRaw] = rest.split(":");
        const attachmentIndex = Number(attachmentIndexRaw) as CompositionAttachmentIndex;
        const orderId = Number(orderIdRaw);

        if (
          (attachmentIndex !== 0 && attachmentIndex !== 1) ||
          Number.isNaN(orderId) ||
          orderId <= 0
        ) {
          await ctx.answerCallbackQuery({ text: "Невірні параметри." });
          return;
        }

        const session = awaitingCompositionPhoto.get(chatId);
        if (
          !session ||
          session.orderId !== orderId ||
          session.attachmentIndex !== attachmentIndex
        ) {
          await ctx.answerCallbackQuery({
            text: "Сесію не знайдено або вона застаріла. Почніть заново.",
          });
          return;
        }

        awaitingCompositionPhoto.delete(chatId);
        await ctx.answerCallbackQuery();
        await ctx.reply("Скасовано.");
        return;
      }

      if (data.startsWith(COMP_PHOTO_CONFIRM_PREFIX)) {
        const rest = data.slice(COMP_PHOTO_CONFIRM_PREFIX.length);
        const [attachmentIndexRaw, orderIdRaw] = rest.split(":");
        const attachmentIndex = Number(attachmentIndexRaw) as CompositionAttachmentIndex;
        const orderId = Number(orderIdRaw);

        if (
          (attachmentIndex !== 0 && attachmentIndex !== 1) ||
          Number.isNaN(orderId) ||
          orderId <= 0
        ) {
          await ctx.answerCallbackQuery({ text: "Невірні параметри." });
          return;
        }

        const session = awaitingCompositionPhoto.get(chatId);
        if (
          !session ||
          session.orderId !== orderId ||
          session.attachmentIndex !== attachmentIndex
        ) {
          await ctx.answerCallbackQuery({
            text: "Сесію не знайдено або вона застаріла. Почніть заново.",
          });
          return;
        }

        if (Date.now() - session.createdAt > COMPOSITION_PHOTO_SESSION_TTL_MS) {
          awaitingCompositionPhoto.delete(chatId);
          await ctx.answerCallbackQuery({
            text: "Сесію не знайдено або вона застаріла. Почніть заново.",
          });
          return;
        }

        if (!session.photoFileId) {
          await ctx.answerCallbackQuery({
            text: "Спочатку надішліть фото.",
          });
          return;
        }

        await ctx.answerCallbackQuery();

        const statusId =
          attachmentIndex === 0
            ? COMPOSITION_BARE_STATUS_ID
            : COMPOSITION_PACKED_STATUS_ID;

        const loadingMsg = await ctx.reply("Завантажується...");

        try {
          // Download photo binary from Telegram
          const tgFile = await ctx.api.getFile(session.photoFileId);
          const filePath = tgFile?.file_path;
          if (!filePath) throw new Error("Telegram file_path is empty.");

          const telegramToken = process?.env?.TELEGRAM_BOT_TOKEN || "";
          const downloadUrl = `https://api.telegram.org/file/bot${telegramToken}/${filePath}`;

          // Change order status first
          await changeOrderStatus(orderId, statusId);

          // Send uploaded image to client chat
          const fileName = filePath.split("/").pop() || `photo-${orderId}.jpg`;
          await sendUploadedImageToCustomerChat(
            orderId,
            attachmentIndex,
            downloadUrl,
            fileName,
          );

          awaitingCompositionPhoto.delete(chatId);

          // Replace loading message with success message
          try {
            await ctx.api.editMessageText(chatId, loadingMsg.message_id, "Готово! Фото надіслано клієнту, статус замовлення змінено.");
          } catch {
            await ctx.reply(
              "Готово! Фото надіслано клієнту, статус замовлення змінено.",
            );
          }
        } catch (e) {
          awaitingCompositionPhoto.delete(chatId);
          try {
            await ctx.api.editMessageText(chatId, loadingMsg.message_id, "Сталася помилка. Спробуйте ще раз.");
          } catch {
            await ctx.reply("Сталася помилка. Спробуйте ще раз.");
          }
          throw e;
        }

        return;
      }
    } catch (err) {
      console.error("Composition photo callback error:", err);
      await ctx.reply("Сталася помилка. Спробуйте ще раз.");
      return;
    }

    return next();
  });

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
    await ctx.reply(`${detailsText}\n\nОберіть, яке фото прикріпити:`, {
      parse_mode: "MarkdownV2",
      reply_markup: buildCompositionAttachInlineKeyboard(orderId),
    });

    // Відправляємо зображення з attachments, якщо вони є
    const attachments = (order as OrderWithAttachments).attachments ?? [];
    const urls: string[] = attachments
      .map((a) => a.file?.url)
      .filter(
        (u): u is string => typeof u === "string" && u.startsWith("http"),
      );

    if (urls.length === 1) {
      try {
        await ctx.replyWithPhoto(urls[0]);
      } catch {
        // ignore
      }
    } else if (urls.length > 1) {
      const media = urls.slice(0, 10).map((url) => ({
        type: "photo" as const,
        media: url,
      }));
      try {
        await ctx.api.sendMediaGroup(ctx.chat!.id, media);
      } catch {
        // ignore
      }
    }
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
    await ctx.reply(`${detailsText}\n\nОберіть, яке фото прикріпити:`, {
      parse_mode: "MarkdownV2",
      reply_markup: buildCompositionAttachInlineKeyboard(orderId),
    });

    const attachments = (order as OrderWithAttachments).attachments ?? [];
    const urls: string[] = attachments
      .map((a) => a.file?.url)
      .filter(
        (u): u is string => typeof u === "string" && u.startsWith("http"),
      );

    if (urls.length === 1) {
      try {
        await ctx.replyWithPhoto(urls[0]);
      } catch {
        // ignore
      }
    } else if (urls.length > 1) {
      const media = urls.slice(0, 10).map((url) => ({
        type: "photo" as const,
        media: url,
      }));
      try {
        await ctx.api.sendMediaGroup(ctx.chat!.id, media);
      } catch {
        // ignore
      }
    }
  });

  bot.hears(/^\d+$/, async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;
    if (!awaitingOrderId.has(telegramId)) return;

    const loadingMsg = await ctx.reply("Завантажую…");

    const m = ctx.message?.text?.trim().match(/^(\d+)$/);
    const orderId = m ? parseInt(m[1], 10) : NaN;
    if (!orderId) {
      awaitingOrderId.delete(telegramId);
      await ctx.reply("Некоректний номер замовлення.");
      return;
    }

    awaitingOrderId.delete(telegramId);

    try {
      if (ctx.chat?.id && loadingMsg.message_id) {
        await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id);
      }
    } catch {
      // ignore
    }

    const order = await getOrderDetails(orderId);
    if (!order) {
      await ctx.reply("Не вдалося отримати замовлення. Спробуйте пізніше.");
      return;
    }

    const detailsText = buildOrderDetailsText(order as OrderWithAttachments);
    await ctx.reply(`${detailsText}\n\nОберіть, яке фото прикріпити:`, {
      parse_mode: "MarkdownV2",
      reply_markup: buildCompositionAttachInlineKeyboard(orderId),
    });

    const attachments = (order as OrderWithAttachments).attachments ?? [];
    const urls: string[] = attachments
      .map((a) => a.file?.url)
      .filter((u): u is string => typeof u === "string" && u.startsWith("http"));

    if (urls.length === 1) {
      try {
        await ctx.replyWithPhoto(urls[0]);
      } catch {
        // ignore
      }
    } else if (urls.length > 1) {
      const media = urls.slice(0, 10).map((url) => ({
        type: "photo" as const,
        media: url,
      }));
      try {
        await ctx.api.sendMediaGroup(ctx.chat!.id, media);
      } catch {
        // ignore
      }
    }
  });

  // Composition/packing photo flow (inline keyboard → photo → confirm)
  bot.on("message:photo", async (ctx, next) => {
    try {
      const chatId = ctx.chat?.id;
      if (!chatId) return next();

      const session = awaitingCompositionPhoto.get(String(chatId));
      if (!session) return next();

      if (Date.now() - session.createdAt > COMPOSITION_PHOTO_SESSION_TTL_MS) {
        awaitingCompositionPhoto.delete(String(chatId));
        await ctx.reply("Сесія застаріла. Почніть заново.");
        return next();
      }

      // If user already sent one photo — ignore any further photos.
      if (session.photoFileId) return;

      const photoSizes = ctx.message?.photo;
      if (!photoSizes?.length) return next();

      // "Беремо першу": this handler is invoked for each message, so first photo message wins.
      const fileId = photoSizes[photoSizes.length - 1].file_id;
      session.photoFileId = fileId;

      await ctx.reply("Фото отримано. Підтвердьте дію:", {
        reply_markup: buildCompositionConfirmInlineKeyboard(
          session.attachmentIndex,
          session.orderId,
        ),
      });
    } catch (err) {
      console.error("Composition photo handler error:", err);
      await ctx.reply("Сталася помилка з фото. Спробуйте ще раз.");
    }
  });
}
