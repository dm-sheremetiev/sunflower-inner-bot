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

const formatOrderMessage = (order: Order) => {
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

  return finalMessage;
};

// interface ExtendedOrder extends Order {
//   exactTime: string;
// }

const formatMyOrdersMessage = (orders: Order[], username: string) => {
  const filteredOrders = orders.filter((order) => {
    return (
      order?.manager?.username?.toLowerCase() === username?.toLowerCase() ||
      order.assigned?.find(
        (as) => as.username?.toLowerCase() === username?.toLowerCase()
      )
    );
  });

  if (!filteredOrders?.length) {
    return "Наразі у вас немає активних замовлень";
  }

  const grouped = filteredOrders.reduce<Record<string, Order[]>>(
    (acc, order) => {
      // const customFieldTime = order.custom_fields.find(
      //   (field) => field.uuid === customTimeField
      // );
      const fieldDate =
        order.shipping.shipping_date_actual || dayjs().toString();

      const date = dayjs(fieldDate).format("DD-MM-YYYY");

      // const timePart = customFieldTime?.value.toLowerCase() || "нема часу";

      // const formattedDateTime = dayjs(`${datePart}T$00:00:00.000000Z`)
      //   .utc()
      //   .tz("Europe/Kiev")
      //   .toString();

      // const date = dayjs(formattedDateTime).format("DD-MM-YYYY");

      if (!acc[date]) {
        acc[date] = [];
      }
      acc[date].push(order);
      return acc;
    },
    {}
  );

  let message = "";

  Object.keys(grouped)
    .sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]))
    .forEach((date) => {
      const prettyDate = date;

      message += `*${prettyDate}*\n`.replaceAll("-", "\\-");
      grouped[date].forEach((order) => {
        const productsString = order?.products?.length
          ? order?.products[0]?.name
            ? `, назва ${order?.products[0]?.name}, `
            : ""
          : "";

        // Артикул
        const art = order?.products[0]?.sku
          ? `арт.: ${order?.products[0]?.sku}, `
          : "";
        // Час
        const timeFieldFlorist = order.custom_fields.find((f) =>
          f.name.toLowerCase().includes("флор")
        );
        const timeForFlorist = timeFieldFlorist
          ? `час для флористів: ${formatTimeOnly(timeFieldFlorist.value)}, `
          : "";
        const timeFieldCourier = order.custom_fields.find((f) =>
          f.name.toLowerCase().includes("кур")
        );
        const timeForCourier = timeFieldCourier
          ? `час для кур'єрів: ${timeFieldCourier.value}, `
          : "";
        // const time = order.exactTime ? `час: ${order.exactTime}` : '';

        // Адреса
        const street = order?.shipping?.shipping_receive_point
          ? order?.shipping?.shipping_receive_point + ", "
          : "";
        const secondaryStreet = order?.shipping.shipping_secondary_line
          ? order?.shipping.shipping_secondary_line + " "
          : "";

        const city = order?.shipping.shipping_address_city
          ? order?.shipping.shipping_address_city + ", "
          : "";
        const address = city + street + secondaryStreet;

        const fullAddress = address.length ? `адреса: ${address}` : "";
        const giftMessage = order.gift_message
          ? `, листівка: ${order.gift_message}`
          : "";

        const comment = order?.buyer_comment
          ? `, коментар клієнта: ${order.buyer_comment} `
          : "";

        const phoneNumber =
          order.shipping?.recipient_phone || order.buyer?.phone;

        const number = phoneNumber
          ? `, ${
              order.shipping?.recipient_phone
                ? `отримувач \\- \`${order.shipping.recipient_phone.replaceAll("+", "\\+").replaceAll(".", "")}\``
                : `замовник  \\- \`${order.buyer.phone.replaceAll("+", "\\+").replaceAll(".", "")}\``
            }`
          : "";

        const productComment = order.products?.[0]?.comment
          ? `, коментар до товару: ${order.products?.[0]?.comment} `
          : "";

        message +=
          `№${order.id}` +
          escapeAllSymbols(
            `${productsString}${art}${timeForFlorist}${timeForCourier}${fullAddress}${comment}${giftMessage}${productComment}`
          ) +
          `${number}\n`;
      });

      message += `\n`;
    });

  return message;
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

export const messageHelper = {
  formatOrderMessage,
  formatMyOrdersMessage,
};
