import dayjs from "dayjs";
import { Order } from "../types/index.js";

import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Форматирует время из ISO строки, извлекая только время без даты
 * @param timeValue - значение времени в формате ISO (например, "2025-12-23T15:00:00.000000Z")
 * @returns отформатированное время в формате HH:mm или исходное значение, если не удалось распарсить
 */
export const formatTimeOnly = (timeValue: string | number): string => {
  if (!timeValue) return String(timeValue);

  try {
    const parsed = dayjs(timeValue);
    if (parsed.isValid()) {
      return parsed.format("HH:mm");
    }
  } catch {
    // Если не удалось распарсить, возвращаем исходное значение
  }

  return String(timeValue);
};

// const customTimeField = process?.env?.TIME_CUSTOM_FIELD_ID || "";

export const extractCommentsFromOrder = (order: Order) => {
  const giftMessage = order?.gift_message
    ? `Листівка: ${order.gift_message}`
    : "";
  const productComment = order.products?.[0]?.comment
    ? `Коментар до товару: ${order.products?.[0]?.comment}`
    : "";

  return {
    giftMessage,
    productComment,
  };
};

const getPosterReceiptFromOrder = (order: Order): string | null => {
  const field = order.custom_fields?.find((item) => {
    const name = String(item.name ?? "").toLowerCase();
    return item.uuid === "OR_1018" || name.includes("номер замовлення у poster");
  });

  const value = String(field?.value ?? "").trim();
  return value.length ? value : null;
};

const formatOrderMessage = (order: Order, posterReceipt?: string | null) => {
  const { assigned, id } = order;

  const assignedPeopleNicknames =
    assigned?.map((orderItem) => `@${orderItem.username}`).join(", ") ||
    "НЕ НАЗНАЧЕНО";
  // const managerFullName = manager?.full_name || "Не назначений менеджер";

  const { giftMessage, productComment } = extractCommentsFromOrder(order);

  let finalMessage = `Менеджер назначив замовлення №${id} на ${assignedPeopleNicknames}.`;

  if (giftMessage) {
    finalMessage += ` ${giftMessage}`;
  }

  if (productComment) {
    finalMessage += `. ${productComment}`;
  }

  const receiptText = posterReceipt ?? getPosterReceiptFromOrder(order);
  if (receiptText) {
    finalMessage += `. Номер чека Poster: ${receiptText}`;
  }

  return finalMessage;
};

const formatMyOrdersMessage = (
  orders: Order[],
  crmUser: { crmUserId?: number; username?: string },
): string[] => {
  const filteredOrders = orders.filter((order) => {
    if (crmUser.crmUserId && order.manager?.id === crmUser.crmUserId)
      return true;
    if (
      crmUser.crmUserId &&
      order.assigned?.some((as) => as.id === crmUser.crmUserId)
    )
      return true;

    // fallback to username
    const username = crmUser.username?.toLowerCase();
    if (username) {
      if (order?.manager?.username?.toLowerCase() === username) return true;
      if (order.assigned?.some((as) => as.username?.toLowerCase() === username))
        return true;
    }
    return false;
  });

  if (!filteredOrders?.length) {
    return [];
  }

  const groupedByDateAndWindow: Record<string, Record<string, Order[]>> = {};

  filteredOrders.forEach((order) => {
    const fieldDate = order.shipping.shipping_date_actual || dayjs().toString();
    const date = dayjs(fieldDate).format("DD-MM-YYYY");

    const timeWindowField = order.custom_fields?.find(
      (f) =>
        f.uuid === "OR_1006" ||
        f.name.toLowerCase().includes("часовий проміжок"),
    );
    const timeWindow = timeWindowField?.value
      ? String(timeWindowField.value)
      : "Не визначено";

    if (!groupedByDateAndWindow[date]) groupedByDateAndWindow[date] = {};
    if (!groupedByDateAndWindow[date][timeWindow])
      groupedByDateAndWindow[date][timeWindow] = [];

    groupedByDateAndWindow[date][timeWindow].push(order);
  });

  const todayStr = dayjs().format("DD-MM-YYYY");
  const dates = Object.keys(groupedByDateAndWindow).sort((a, b) => {
    if (a === todayStr) return -1;
    if (b === todayStr) return 1;
    const dateA = dayjs(a, "DD-MM-YYYY");
    const dateB = dayjs(b, "DD-MM-YYYY");
    return dateA.valueOf() - dateB.valueOf();
  });

  const messages: string[] = [];
  let currentMessage = "";

  const addLine = (line: string) => {
    if (currentMessage.length + line.length > 3900) {
      messages.push(currentMessage);
      currentMessage = "";
    }
    currentMessage += line;
  };

  for (const date of dates) {
    const displayDate = date === todayStr ? `Сьогодні (${date})` : date;
    addLine(`*${escapeAllSymbols(displayDate)}*\n`);

    const windows = Object.keys(groupedByDateAndWindow[date]).sort((a, b) => {
      if (a === "Не визначено" && b !== "Не визначено") return 1;
      if (b === "Не визначено" && a !== "Не визначено") return -1;
      return a.localeCompare(b);
    });

    for (const timeWindow of windows) {
      addLine(`📌 _${escapeAllSymbols(timeWindow)}_\n`);

      groupedByDateAndWindow[date][timeWindow].forEach((order) => {
        let orderText = ``;

        const productsString =
          order?.products?.length && order?.products[0]?.name
            ? `назва: ${order?.products[0]?.name}, `
            : "";

        const art = order?.products?.[0]?.sku
          ? `арт.: ${order?.products[0]?.sku}, `
          : "";

        const street = order?.shipping?.shipping_receive_point
          ? order?.shipping?.shipping_receive_point + ", "
          : "";
        const secondaryStreet = order?.shipping?.shipping_secondary_line
          ? order?.shipping?.shipping_secondary_line + " "
          : "";
        const city = order?.shipping?.shipping_address_city
          ? order?.shipping?.shipping_address_city + ", "
          : "";
        const address = city + street + secondaryStreet;
        const fullAddress = address.trim().length
          ? `адреса: ${address.trim()}, `
          : "";

        const giftMessage = order.gift_message
          ? `листівка: ${order.gift_message}, `
          : "";
        const comment = order?.buyer_comment
          ? `коментар: ${order.buyer_comment}, `
          : "";
        const productComment = order.products?.[0]?.comment
          ? `коментар: ${order.products?.[0]?.comment}, `
          : "";

        const phoneNumber =
          order.shipping?.recipient_phone || order.buyer?.phone;
        let number = "";
        if (phoneNumber) {
          const escapedPhone = phoneNumber
            .replaceAll("+", "\\+")
            .replaceAll(".", "");
          number = order.shipping?.recipient_phone
            ? `отримувач: \`${escapedPhone}\``
            : `замовник: \`${escapedPhone}\``;
        }

        let customFieldsText = "";
        const targetUuids = [
          "OR_1007",
          "OR_1011",
          "OR_1012",
          "OR_1015",
          "OR_1017",
        ];
        const targetNames: Record<string, string> = {
          OR_1007: "Район",
          OR_1011: "Пробито",
          OR_1012: "Листівка перев.",
          OR_1015: "Комп.",
          OR_1017: "Кульки",
        };

        targetUuids.forEach((uuid) => {
          const field = order.custom_fields?.find(
            (f) => f.uuid === uuid || f.name.includes(targetNames[uuid]),
          );
          if (field && field.value) {
            let valStr = Array.isArray(field.value)
              ? field.value.join(", ")
              : String(field.value);
            if (typeof field.value === "boolean")
              valStr = field.value ? "Так" : "Ні";
            customFieldsText += `${targetNames[uuid]}: ${valStr}, `;
          }
        });

        const allInfo = `${productsString}${art}${fullAddress}${comment}${giftMessage}${productComment}${customFieldsText}`;
        const cleanInfo = cleanupCommasAndSpaces(allInfo);

        orderText += `*${order.id}* \\- ` + escapeAllSymbols(cleanInfo);
        if (cleanInfo && number) orderText += ", ";
        if (number) orderText += number;

        addLine(orderText + `\n\n`);
      });
    }
    addLine(`\n`);
  }

  if (currentMessage.trim()) {
    messages.push(currentMessage);
  }

  return messages;
};

export const escapeAllSymbols = (text: string) => {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("_", "\\_")
    .replaceAll("*", "\\*")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)")
    .replaceAll("~", "\\~")
    .replaceAll("`", "\\`")
    .replaceAll(">", "\\>")
    .replaceAll("#", "\\#")
    .replaceAll("+", "\\+")
    .replaceAll("-", "\\-")
    .replaceAll("=", "\\=")
    .replaceAll("|", "\\|")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}")
    .replaceAll(".", "\\.")
    .replaceAll("!", "\\!")
    .replaceAll(", ,", ",");
};

export const cleanupCommasAndSpaces = (text: string): string => {
  return String(text ?? "")
    .replace(/\s*,\s*(,\s*)+/g, ", ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*\n/g, "\n")
    .replace(/,\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
};

export const messageHelper = {
  formatOrderMessage,
  formatMyOrdersMessage,
};
