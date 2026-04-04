import { FastifyReply } from "fastify";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import {
  keycrmAdminApiClient,
  keycrmApiClient,
} from "../api/keycrmApiClient.js";
import { AdminOrder, Conversation, Order } from "../types/keycrm.js";
import {
  extractCommentsFromOrder,
  formatTimeOnly,
  messageHelper,
} from "../helpers/messageHelper.js";
import { fileHelper } from "../helpers/fileHelper.js";
import {
  sendTelegramMessage,
  sendTelegramMessageToMainAccount,
  sendTelegramMessageToNotificationsChanel,
} from "./telegram.service.js";
import axios from "axios";
import { StorageUploadResponse } from "../types/keycrm.js";
import { createPosterOrdersAndStoreReceipts } from "./poster.service.js";

import "dotenv/config";
import { isCrmAssigneeCourier } from "../helpers/crmRoleHelper.js";
import { extractBranchNames } from "../helpers/keycrmHelper.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const KYIV_TZ = "Europe/Kyiv";

/** ID чату складу для повідомлень про тег "букет на складі" */
export const WAREHOUSE_CHAT_ID = "-1002318769632";
const INITIAL_STATUS_ID = "1";
/** Статус, на який відкатуємо замовлення при невалідній адресі/координатах */
const ADDRESS_REVERT_STATUS_ID = "31";
/** Статус помилки для замовлень з проблемами оплати (такий самий як адреса) */
const PAYMENT_ERROR_STATUS_ID = "31";
const BRANCH_TAGS = ["Файна", "Севен", "Француз", "Республіка"];

/** Формат координат у полі індекс: "число, число" (наприклад "50.45, 30.52") */
const COORDINATES_REGEX = /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/;
const photoApprovalChatId = process?.env?.PHOTO_APPROVAL_CHAT_ID || "";
const managersChatId = process?.env?.MANAGERS_CHAT_ID || "";

export interface Tag {
  id: number;
  name: string;
  alias: string;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface TagResponse {
  total: number;
  current_page: number;
  per_page: number;
  data: Tag[];
  first_page_url: string;
  last_page_url: string;
  next_page_url: string;
}


const getOrderInfo = async (orderId: string | number, reply: FastifyReply) => {
  try {
    const res = await keycrmApiClient.get<Order>(
      `order/${+orderId}?include=assigned,custom_fields,shipping.deliveryService,buyer,manager,products,products.offer,tags,payments`,
    );

    return res?.data;
  } catch (error) {
    return reply.log.error({ error });
  }
};

export const sendTelegramMessageAboutOrder = async (
  orderId: string | number,
  reply: FastifyReply,
) => {
  try {
    const order = await getOrderInfo(orderId, reply);

    if (!order) {
      return "No order";
    }

    const finalMessage = messageHelper.formatOrderMessage(order);
    const { assigned } = order;

    if (!assigned || !Array.isArray(assigned) || assigned.length === 0) {
      reply.status(500).send({ error: "No assigned" });
      return reply;
    }

    const users = fileHelper.loadUsers();

    const results: Array<
      | { chatId: string; status: string; response?: unknown }
      | { chatId: string; status: string; error?: unknown }
      | { username: string; status: string }
    > = [];

    for (const assignee of assigned) {
      const { username } = assignee;

      const userEntry = Object.entries(users).find(
        ([, user]) => (user as { username?: string }).username === username,
      );

      if (userEntry) {
        const [chatId] = userEntry;
        try {
          const response = await sendTelegramMessage(chatId, finalMessage);

          results.push({
            chatId,
            status: "success",
            response: (response as { data?: unknown })?.data,
          });
        } catch (error) {
          results.push({
            chatId,
            status: "error",
            error,
          });
        }
      } else {
        results.push({ username, status: "not_found" });
      }
    }

    return order;
  } catch (error) {
    reply.log.error({ error });

    reply.status(500).send({ error: "Internal Server Error" });
  }
};

export const sendWithoutPackageMessageToManager = async (
  orderId: string | number,
  reply: FastifyReply,
  isGeneralMessage?: boolean,
) => {
  try {
    const users = fileHelper.loadUsers();

    if (!orderId) {
      return "No order";
    }

    const order = await getOrderInfo(orderId, reply);
    let assignedMessage = "";

    if (!order) {
      assignedMessage = "Помилка в отримані відповідальних та менеджера.";
      const finalMessage = `Замовлення № ${orderId} зібрано. Перевірте наявність фото у файлах`;

      if (isGeneralMessage) {
        await sendTelegramMessageToNotificationsChanel(finalMessage);

        return "Повідомлення було відправлено у канал.";
      }

      await sendTelegramMessageToMainAccount(finalMessage);

      return "Повідомлення було відправлено менеджеру.";
    }

    const { assigned, manager } = order;

    if (assigned?.length) {
      const assignedPeople = assigned
        .filter((as) => !isCrmAssigneeCourier(as))
        .map((as) => as.full_name)
        .join(", ");

      assignedMessage = `. Відповідальні: ${assignedPeople}`;
    } else {
      assignedMessage = `. Відповідальних немає`;
    }

    const finalMessage = `Замовлення № ${orderId} зібрано${assignedMessage}. Перевірте наявність фото у файлах`;

    // Send message only to manager's chanel
    if (isGeneralMessage) {
      const res = await sendTelegramMessageToNotificationsChanel(finalMessage);

      return res;
    }

    let chatId = "";
    for (const id in users) {
      if (
        users[id].username?.toLowerCase() === manager.username.toLowerCase()
      ) {
        chatId = id;

        break;
      }
    }
    const res = chatId
      ? await sendTelegramMessage(chatId, finalMessage)
      : await sendTelegramMessageToMainAccount(finalMessage);

    return res;
  } catch (error) {
    reply.log.error({ error });

    reply.status(500).send({ error: "Internal Server Error" });
  }
};

export const changeOrderStatus = async (
  orderId: number | string,
  status_id: string,
) => {
  const res = await keycrmApiClient.put<Order>(`order/${+orderId}`, {
    status_id: +status_id,
  });

  return res?.data;
};

export const sendMessageAboutPackage = async (
  orderId: string | number,
  reply: FastifyReply,
) => {
  try {
    const users = fileHelper.loadUsers();

    if (!orderId) {
      return "No order";
    }

    const order = await getOrderInfo(orderId, reply);

    if (!order) {
      const finalMessage = `Не відправилось відповідальним повідомлення про пакування замовлення № ${orderId}. Передайте інформацію усно.`;

      await sendTelegramMessageToMainAccount(finalMessage);

      return "Повідомлення було відправлено менеджеру.";
    }

    const { assigned, manager } = order;

    if (!assigned || !Array.isArray(assigned) || assigned.length === 0) {
      let chatId = "";
      for (const id in users) {
        if (
          users[id].username?.toLowerCase() === manager.username.toLowerCase()
        ) {
          chatId = id;

          break;
        }
      }

      const res = chatId
        ? await sendTelegramMessage(
            chatId,
            `Немає відповідальних для замовлення № ${orderId} тому повідомлення не було відправлене`,
          )
        : await sendTelegramMessageToMainAccount(
            `Немає відповідальних для замовлення № ${orderId} тому повідомлення не було відправлене`,
          );

      return res;
    }

    const filteredAssigned = assigned.filter(
      (as) => !isCrmAssigneeCourier(as),
    );
    const { giftMessage, productComment } = extractCommentsFromOrder(order);

    let finalMessage = `Замовлення №${orderId} можна пакувати. ${giftMessage}`;

    if (productComment) {
      finalMessage += `. ${productComment}`;
    }

    for (const assignee of filteredAssigned) {
      const { username } = assignee;

      const userEntry = Object.entries(users).find(
        ([, user]) => (user as { username?: string }).username === username,
      );

      if (userEntry) {
        const [chatId] = userEntry;
        try {
          await sendTelegramMessage(chatId, finalMessage);
        } catch (error) {
          console.error(error);
        }
      }
    }
  } catch (error) {
    reply.log.error({ error });

    reply.status(500).send({ error: "Internal Server Error" });
  }
};

export const sendPackedMessageNotification = async (
  orderId: string | number,
  reply: FastifyReply,
  isGeneralMessage?: boolean,
) => {
  try {
    const users = fileHelper.loadUsers();

    if (!orderId) {
      return "No order";
    }

    const order = await getOrderInfo(orderId, reply);
    let assignedMessage = "";

    if (!order) {
      assignedMessage = "Помилка в отримані відповідальних та менеджера.";
      const finalMessage = `Замовлення № ${orderId} запаковано. Перевірте наявність фото у файлах`;

      const res = isGeneralMessage
        ? await sendTelegramMessageToNotificationsChanel(finalMessage)
        : await sendTelegramMessageToMainAccount(finalMessage);

      return res;
    }

    const { assigned, manager } = order;

    if (assigned?.length) {
      const assignedPeople = assigned
        .filter((as) => !isCrmAssigneeCourier(as))
        .map((as) => as.full_name)
        .join(", ");

      assignedMessage = `. Відповідальні: ${assignedPeople}`;
    } else {
      assignedMessage = `. Відповідальних немає`;
    }

    const finalMessage = `Замовлення №${orderId} запаковано${assignedMessage}. Перевірте наявність фото у файлах`;

    if (isGeneralMessage) {
      const res = await sendTelegramMessageToNotificationsChanel(finalMessage); // Could be deleted in future

      return res;
    }

    let chatId = "";
    for (const id in users) {
      if (
        users[id].username?.toLowerCase() === manager.username.toLowerCase()
      ) {
        chatId = id;

        break;
      }
    }
    const res = chatId
      ? await sendTelegramMessage(chatId, finalMessage)
      : await sendTelegramMessageToMainAccount(finalMessage);

    return res;
  } catch (error) {
    reply.log.error({ error });

    reply.status(500).send({ error: "Internal Server Error" });
  }
};

export const sendMessageAboutWaiting = async (
  orderId: string | number,
  reply: FastifyReply,
) => {
  try {
    const users = fileHelper.loadUsers();

    if (!orderId) {
      return reply.send("No order");
    }

    const order = await getOrderInfo(orderId, reply);
    let assignedMessage = "";

    if (!order) {
      assignedMessage = "Помилка в отримані відповідальних та менеджера.";
      const finalMessage = `Замовлення № ${orderId} очікує відправлення.`;

      await sendTelegramMessageToMainAccount(finalMessage);

      return reply.send("Повідомлення було відправлено менеджеру.");
    }

    const { assigned, manager } = order;

    if (assigned?.length) {
      const assignedPeople = assigned.map((as) => as.full_name).join(", ");

      assignedMessage = `. Відповідальні: ${assignedPeople}`;
    } else {
      assignedMessage = `. Відповідальних немає`;
    }

    let finalMessage = `Замовлення №${orderId} очікує відправлення${assignedMessage}.`;

    const productsString = order?.products?.length
      ? order?.products[0]?.name
        ? `, назва ${order?.products[0]?.name}, `
        : ""
      : "";

    // // Артикул
    const art = order?.products[0]?.sku
      ? `арт.: ${order?.products[0]?.sku}, `
      : "";
    // Час
    const timeFieldFlorist = order.custom_fields.find((f) =>
      f.name.toLowerCase().includes("флор"),
    );
    const timeForFlorist = timeFieldFlorist
      ? `час для флористів: ${formatTimeOnly(timeFieldFlorist.value)}, `
      : "";
    const timeFieldCourier = order.custom_fields.find((f) =>
      f.name.toLowerCase().includes("кур"),
    );
    const timeForCourier = timeFieldCourier
      ? `час для кур'єрів: ${formatTimeOnly(timeFieldCourier.value)}, `
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

    const comment = order.buyer_comment
      ? `, коментар клієнта: ${order.buyer_comment} `
      : "";

    const phoneNumber = order.shipping?.recipient_phone || order.buyer?.phone;

    const number = phoneNumber
      ? `, ${
          order.shipping?.recipient_phone
            ? `отримувач ${order.shipping.recipient_phone.replaceAll(".", "")}`
            : `замовник ${order.buyer.phone.replaceAll(".", "")}`
        }`
      : "";

    const productComment = order.products?.[0]?.comment
      ? `, коментар до товару: ${order.products?.[0]?.comment} `
      : "";

    finalMessage +=
      `${productsString}${art}${timeForFlorist}${timeForCourier}${fullAddress}${comment}${giftMessage}${productComment}` +
      `${number}\n`;

    let chatId = "";
    for (const id in users) {
      if (
        users[id].username?.toLowerCase() === manager.username.toLowerCase()
      ) {
        chatId = id;

        break;
      }
    }
    const res = chatId
      ? await sendTelegramMessage(chatId, finalMessage)
      : await sendTelegramMessageToMainAccount(finalMessage);

    return reply.send(res);
  } catch (error) {
    reply.log.error({ error });

    return reply.status(500).send({ error: "Internal Server Error" });
  }
};

export type AddTagToOrderResult =
  | { success: true; userMessage: string; warehouseMessage: string }
  | { success: false; userMessage: string };

/** Додає тег "Букет на складі" до замовлення. Не відправляє повідомлення — це робить хендлер. */
export async function addTagToOrderInCrm(
  orderId: number | string,
  extraArgument: string,
): Promise<AddTagToOrderResult> {
  const successText = `Замовлення ${orderId} успішно змінило свій тег на "БУКЕТ НА СКЛАДІ. Знаходиться: ${extraArgument || "не вказано"}`;

  try {
    const orderData = await keycrmApiClient.get<Order>(`order/${+orderId}`, {
      params: { include: "tags" },
    });

    if (!orderData?.data) {
      return {
        success: false,
        userMessage:
          "Такого замовлення не існує у системі. Напишіть адміністратору",
      };
    }

    const order = orderData.data;
    const availableTags = order.tags || [];
    const tagExists = availableTags.some((tag) =>
      tag.name.toLowerCase().includes("букет на складі"),
    );

    if (tagExists) {
      return {
        success: true,
        userMessage: successText,
        warehouseMessage: successText,
      };
    }

    const tagsResponse = await keycrmApiClient.get<TagResponse>(`order/tag`, {
      params: { limit: 50 },
    });

    if (!tagsResponse?.data?.data || !Array.isArray(tagsResponse.data.data)) {
      return {
        success: false,
        userMessage:
          "Не вдалося отримати список тегів. Зверніться до адміністратора",
      };
    }

    const tags = tagsResponse.data.data;
    const tagToAdd = tags.find((tag) =>
      tag.name.toLowerCase().includes("букет на складі"),
    );

    if (!tagToAdd) {
      return {
        success: false,
        userMessage: "Тег не було знайдено. Зверніться до адміністраторів",
      };
    }

    availableTags.push(tagToAdd);
    await keycrmApiClient.post<Order>(`/order/${+orderId}/tag/${tagToAdd.id}`, {
      tags: availableTags,
    });

    return {
      success: true,
      userMessage: successText,
      warehouseMessage: successText,
    };
  } catch (error) {
    console.error(error);
    return {
      success: false,
      userMessage: "Сталася якась помилка. Повідомте адміністраторів",
    };
  }
}

export const sendMessageAboutNewOrder = async (
  orderId: string | number,
  reply: FastifyReply,
) => {
  try {
    const users = fileHelper.loadUsers();

    if (!orderId) {
      return "No order";
    }

    const order = await getOrderInfo(orderId, reply);
    let assignedMessage = "";

    if (!order) {
      const finalMessage = `Нове замовлення № ${orderId}. Помилка в отримані відповідальних та менеджера.`;

      await sendTelegramMessageToMainAccount(finalMessage);

      return "Повідомлення було відправлено менеджеру.";
    }

    const { assigned } = order;

    if (assigned?.length) {
      const assignedPeople = assigned.map((as) => as.full_name).join(", ");

      assignedMessage = `. Відповідальні: ${assignedPeople}`;
    } else {
      await sendTelegramMessageToMainAccount(
        `Замовлення № ${orderId} змінило статус, але менеджер не назначив відповідальних.`,
      );

      return;
    }

    const posterReceipt = await createPosterOrdersAndStoreReceipts(
      order,
      reply,
      BRANCH_TAGS,
    );

    // Для чатів, де менеджеру потрібно подивитися контекст замовлення з призначеними відповідальними,
    // використовуємо ту саму формулу, що й у повідомленнях про призначення.
    const finalMessage = `${messageHelper.formatOrderMessage(order, posterReceipt)}${assignedMessage}`;

    const results: Array<
      | { chatId: string; status: string; response?: unknown }
      | { chatId: string; status: string; error?: unknown }
      | { username: string; status: string }
    > = [];

    for (const assignee of assigned) {
      const { username } = assignee;

      const userEntry = Object.entries(users).find(
        ([, user]) => (user as { username?: string }).username === username,
      );

      if (userEntry) {
        const [chatId] = userEntry;
        try {
          const response = await sendTelegramMessage(chatId, finalMessage);

          results.push({
            chatId,
            status: "success",
            response: (response as { data?: unknown })?.data,
          });
        } catch (error) {
          results.push({
            chatId,
            status: "error",
            error,
          });
        }
      } else {
        results.push({ username, status: "not_found" });
      }
    }
  } catch (error) {
    reply.log.error({ error });

    reply.status(500).send({ error: "Internal Server Error" });
  }
};

export const sendImageToCustomerChat = async (
  reply: FastifyReply,
  orderId: number,
  attachmentIndex = 0,
) => {
  reply.status(200).send({ ok: true });

  try {
    // Ensure orderId is a number and convert to string for URL
    const normalizedOrderId = Number(orderId);
    if (isNaN(normalizedOrderId)) {
      throw new Error(
        `Невірний номер замовлення: ${orderId}. Відправте фото вручну.`,
      );
    }

    // Get order info
    const { data: order } = await keycrmAdminApiClient.get<AdminOrder>(
      `/orders/${normalizedOrderId}`,
    );

    if (!order) {
      throw new Error(
        `Не було знайдено замовлення із №${normalizedOrderId}. Відправте фото вручну.`,
      );
    }

    if (
      order?.tags?.find((tag) => tag?.name?.toLowerCase().includes("блогер"))
    ) {
      throw new Error(
        `Замовлення №${normalizedOrderId} для блогера, тому фото не було відправлено.`,
      );
    }

    if (
      order?.tags?.find((tag) => tag?.name?.toLowerCase().includes("скарга"))
    ) {
      throw new Error(
        `Замовлення №${normalizedOrderId} має тег "скарга", тому фото не було відправлено.`,
      );
    }

    const branchNames = extractBranchNames(order);

    // Відправляємо фото тільки якщо дата відправки — сьогодні або завтра (за київським часом)
    const shippingDateStr = order.shipping?.shipping_date_actual;
    if (!shippingDateStr) {
      const msg =
        `${branchNames?.length ? `${branchNames}. ` : ""}` +
        `Замовлення №${normalizedOrderId}. Фото не було відправлено: не вказано дату відправки. Надішліть фото вручну.`;
      try {
        await sendTelegramMessage(photoApprovalChatId, msg);
      } catch (e) {
        console.error("Failed to send Telegram (no shipping date):", e);
      }
      return;
    }

    const todayKyiv = dayjs().tz(KYIV_TZ).startOf("day");
    const tomorrowKyiv = todayKyiv.add(1, "day");
    const deliveryDayKyiv = dayjs(shippingDateStr).tz(KYIV_TZ).startOf("day");
    const isDeliveryTodayOrTomorrow =
      deliveryDayKyiv.isSame(todayKyiv) || deliveryDayKyiv.isSame(tomorrowKyiv);

    if (!isDeliveryTodayOrTomorrow) {
      const deliveryFormatted = deliveryDayKyiv.format("DD.MM.YYYY");
      const msg =
        `${branchNames?.length ? `${branchNames}. ` : ""}` +
        `Замовлення №${normalizedOrderId}. Фото не було відправлено: дата відправки ${deliveryFormatted} — це не сьогодні і не завтра (за київським часом). Надішліть фото вручну.`;
      try {
        await sendTelegramMessage(photoApprovalChatId, msg);
      } catch (e) {
        console.error(
          "Failed to send Telegram (shipping date not today/tomorrow):",
          e,
        );
      }
      return;
    }

    const clientId = order.client_id;
    const attachments = order.attachments || [];

    if (!attachments?.length) {
      throw new Error(
        branchNames.length
          ? `${branchNames}. У замовлення №${normalizedOrderId} не було прикріплено жодного фото. Статус було змінено без автоматичного повідомлення у чат із клієнтом`
          : `Без тегу філії. У замовлення №${normalizedOrderId} не було прикріплено жодного фото. Статус було змінено без автоматичного повідомлення у чат із клієнтом. Замовлення немає тегу філії.`,
      );
    }

    const files = attachments.map((a) => ({
      url: a?.file?.url || null,
      file_name: a?.file?.original_file_name || null,
      size: a?.file?.size || 0,
      thumbnail: a?.file?.thumbnail || null,
    }));

    const assignedPeople =
      order?.assigned?.map((as) => as.full_name)?.join(",") || "";

    const assignedText = `${assignedPeople?.length ? ` Відповідальні ${assignedPeople}` : ""}`;

    const targetFile = files[attachmentIndex];

    if (!targetFile) {
      const fileErrorMessage = branchNames.length
        ? `${branchNames}. Замовлення №${order.id} змінило статус, але фото збірки або пакування відсутнє (індекс ${attachmentIndex}, доступно файлів: ${files.length}). Будь ласка, надішліть його вручну.${assignedText}`
        : `Замовлення №${order.id} змінило статус, але фото збірки або пакування відсутнє (індекс ${attachmentIndex}, доступно файлів: ${files.length}). Будь ласка, надішліть його вручну.${assignedText}. Замовлення немає тегу філії.`;

      throw new Error(fileErrorMessage);
    }

    if (!targetFile.url && !targetFile.thumbnail) {
      throw new Error(
        `Замовлення №${order.id}. Фото з індексом ${attachmentIndex} не має URL або thumbnail. Будь ласка, надішліть фото вручну.${assignedText}`,
      );
    }

    // Get client's conversations
    const { data: conversations } = await keycrmAdminApiClient.get<
      Conversation[]
    >(`/conversations/by-client/${clientId}`);

    if (!conversations.length) {
      throw new Error(
        `${branchNames?.length > 0 ? `${branchNames}. ` : ""}Замовлення №${order.id}. Не було знайдено чату. Відправте фото вручну. ${assignedPeople}`,
      );
    }

    const latest = conversations.reduce((a, b) =>
      new Date(b.updated_at) > new Date(a.updated_at) ? b : a,
    );

    const conversationId = latest.id;

    const text =
      attachmentIndex === 0
        ? "Надсилаємо фото збірки без пакування на затвердження✨"
        : "Надсилаємо фото у пакуванні на затвердження замовлення✨";

    const automaticText =
      "\n\n**Це автоматичне повідомлення, надіслане системою";

    const finalText = text + automaticText;

    // Download and upload file to KeyCRM storage
    let uploadedFileUrl = targetFile.url || targetFile.thumbnail;

    if (!uploadedFileUrl) {
      throw new Error(
        `Замовлення №${order.id}. Фото не має доступного URL. Будь ласка, надішліть фото вручну.${assignedText}`,
      );
    }

    // If file is too large, try to download and re-upload it
    if (targetFile.size >= 5000000 && targetFile.url) {
      try {
        uploadedFileUrl = await downloadAndUploadFile(
          targetFile.url,
          targetFile.file_name || "image.jpg",
        );
      } catch (uploadError) {
        // If upload fails, use original URL or thumbnail
        uploadedFileUrl = targetFile.url || targetFile.thumbnail;
        console.error(
          `Failed to re-upload large file for order ${order.id}, using original URL:`,
          uploadError,
        );
      }
    }

    // Send text message first
    try {
      await keycrmAdminApiClient.post(
        `/conversations/${conversationId}/messages`,
        {
          message_body: finalText,
          type: "outgoing",
          is_email: false,
          attachments: [],
          conversation_id: conversationId,
        },
      );
    } catch (textMessageError) {
      console.error(
        `Failed to send text message for order ${order.id}:`,
        textMessageError,
      );
      // Continue with image sending even if text message fails
    }

    // Wait before sending image
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Send image message
    try {
      await keycrmAdminApiClient.post(
        `/conversations/${conversationId}/messages`,
        {
          message_body: null,
          type: "outgoing",
          is_email: false,
          attachments: [
            {
              url: uploadedFileUrl,
              type: "image",
              file_name: targetFile.file_name || "image.jpg",
            },
          ],
          conversation_id: conversationId,
        },
      );
    } catch (imageMessageError) {
      throw new Error(
        `Не вдалося відправити фото для замовлення №${order.id}. Помилка: ${imageMessageError instanceof Error ? imageMessageError.message : String(imageMessageError)}.${assignedText}`,
      );
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const normalizedOrderId = Number(orderId) || orderId;
    const generalErrorMessage = errorMessage
      ? `${errorMessage}. OrderId: ${normalizedOrderId}`
      : `Невдала відправка фото при зміні статусу у замовлення №${normalizedOrderId}. Відправте вручну.`;

    try {
      await sendTelegramMessage(
        photoApprovalChatId,
        errorMessage || generalErrorMessage,
      );
    } catch (telegramError) {
      console.error(
        `Failed to send error message to Telegram for order ${normalizedOrderId}:`,
        telegramError,
      );
    }
  } finally {
    if (!reply.sent) {
      reply.status(200).send({ ok: true });
    }
  }
};

/**
 * Uploads already downloaded binary buffer to KeyCRM storage.
 * Used by Telegram flow where we download photo from Telegram and then upload to `/storage/upload`.
 */
export const uploadBufferToKeycrmStorage = async (
  buffer: Buffer,
  fileName: string,
  contentType?: string,
): Promise<StorageUploadResponse> => {
  const FormData = (await import("form-data")).default;
  const form = new FormData();

  form.append("file", buffer, {
    filename: fileName || "image.jpg",
    contentType: contentType || "image/jpeg",
  });

  const uploadResponse = await keycrmApiClient.post<StorageUploadResponse>(
    "/storage/upload",
    form,
    {
      headers: {
        ...form.getHeaders(),
      },
      timeout: 60000, // 60 seconds timeout for upload
    },
  );

  if (!uploadResponse.data?.url) {
    throw new Error("Upload response does not contain file URL");
  }

  return uploadResponse.data;
};

/**
 * Sends a composition/packing photo to the latest client conversation.
 * Unlike `sendImageToCustomerChat`, this function sends an explicit file URL
 * (so Telegram flow doesn't need to attach file to order first).
 */
export const sendUploadedImageToCustomerChat = async (
  orderId: number | string,
  attachmentIndex: 0 | 1,
  uploadedFileUrl: string,
  uploadedFileName?: string,
) => {
  try {
    // Ensure orderId is a number and convert to string for URL
    const normalizedOrderId = Number(orderId);
    if (isNaN(normalizedOrderId)) {
      throw new Error(`Невірний номер замовлення: ${orderId}`);
    }

    // Get order info (including shipping, client, tags)
    const { data: order } = await keycrmAdminApiClient.get<AdminOrder>(
      `/orders/${normalizedOrderId}`,
    );

    if (!order) {
      throw new Error(`Не було знайдено замовлення із №${normalizedOrderId}.`);
    }

    if (
      order?.tags?.find((tag) =>
        (tag?.name ?? "").toLowerCase().includes("блогер"),
      )
    ) {
      throw new Error(
        `Замовлення №${normalizedOrderId} для блогера, фото не відправляємо.`,
      );
    }

    if (
      order?.tags?.find((tag) =>
        (tag?.name ?? "").toLowerCase().includes("скарга"),
      )
    ) {
      throw new Error(
        `Замовлення №${normalizedOrderId} має тег "скарга", фото не відправляємо.`,
      );
    }

    const branchNames = extractBranchNames(order);

    // Keep the same "today/tomorrow" rule as existing `sendImageToCustomerChat`
    const shippingDateStr = order.shipping?.shipping_date_actual;
    if (!shippingDateStr) {
      const msg =
        `${branchNames?.length ? `${branchNames}. ` : ""}` +
        `Замовлення №${normalizedOrderId}. Фото не було відправлено: не вказано дату відправки. Надішліть фото вручну.`;
      await sendTelegramMessage(photoApprovalChatId, msg).catch(() => null);
      return;
    }

    const todayKyiv = dayjs().tz(KYIV_TZ).startOf("day");
    const tomorrowKyiv = todayKyiv.add(1, "day");
    const deliveryDayKyiv = dayjs(shippingDateStr).tz(KYIV_TZ).startOf("day");
    const isDeliveryTodayOrTomorrow =
      deliveryDayKyiv.isSame(todayKyiv) || deliveryDayKyiv.isSame(tomorrowKyiv);

    if (!isDeliveryTodayOrTomorrow) {
      const deliveryFormatted = deliveryDayKyiv.format("DD.MM.YYYY");
      const msg =
        `${branchNames?.length ? `${branchNames}. ` : ""}` +
        `Замовлення №${normalizedOrderId}. Фото не було відправлено: дата відправки ${deliveryFormatted} — це не сьогодні і не завтра (за київським часом). Надішліть фото вручну.`;
      await sendTelegramMessage(photoApprovalChatId, msg).catch(() => null);
      return;
    }

    const clientId = order.client_id;
    if (!clientId) {
      throw new Error(
        `Замовлення №${normalizedOrderId}. Не знайдено client_id для відправки фото.`,
      );
    }

    const conversationsRes = await keycrmAdminApiClient.get<Conversation[]>(
      `/conversations/by-client/${clientId}`,
    );
    const conversations = conversationsRes.data;

    if (!conversations.length) {
      throw new Error(
        `${branchNames?.length ? `${branchNames}. ` : ""}Замовлення №${normalizedOrderId}. Не було знайдено чату для клієнта.`,
      );
    }

    const latest = conversations.reduce((a, b) =>
      new Date(b.updated_at) > new Date(a.updated_at) ? b : a,
    );
    const conversationId = latest.id;

    const text =
      attachmentIndex === 0
        ? "Надсилаємо фото збірки без пакування на затвердження✨"
        : "Надсилаємо фото у пакуванні на затвердження замовлення✨";

    const automaticText =
      "\n\n**Це автоматичне повідомлення, надіслане системою";
    const finalText = text + automaticText;
    const preparedAttachmentUrl = await prepareMetaCompatibleAttachmentUrl(
      uploadedFileUrl,
      uploadedFileName || "image.jpg",
    );

    // Send text message first
    try {
      await keycrmAdminApiClient.post(
        `/conversations/${conversationId}/messages`,
        {
          message_body: finalText,
          type: "outgoing",
          is_email: false,
          attachments: [],
          conversation_id: conversationId,
        },
      );
    } catch (e) {
      // Continue with image sending even if text fails
      console.error(
        `Failed to send text message for order ${normalizedOrderId}:`,
        e,
      );
    }

    // Wait before sending image
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await keycrmAdminApiClient.post(
      `/conversations/${conversationId}/messages`,
      {
        message_body: null,
        type: "outgoing",
        is_email: false,
        attachments: [
          {
            url: preparedAttachmentUrl,
            type: "image",
            file_name: uploadedFileName || "image.jpg",
          },
        ],
        conversation_id: conversationId,
      },
    );
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const normalizedOrderId = Number(orderId) || orderId;
    const generalErrorMessage = errorMessage
      ? `${errorMessage}. OrderId: ${normalizedOrderId}`
      : `Невдала відправка фото при зміні статусу у замовлення №${normalizedOrderId}. Відправте вручну.`;

    try {
      await sendTelegramMessage(photoApprovalChatId, generalErrorMessage);
    } catch (telegramError) {
      console.error(
        `Failed to send error message to Telegram for order ${normalizedOrderId}:`,
        telegramError,
      );
    }
  }
};

/**
 * Downloads a file from URL and uploads it to KeyCRM storage
 */
async function downloadAndUploadFile(
  fileUrl: string,
  fileName: string,
): Promise<string> {
  try {
    // Download file from URL
    const response = await axios.get(fileUrl, {
      responseType: "arraybuffer",
      timeout: 30000, // 30 seconds timeout
    });

    if (!response.data || response.status !== 200) {
      throw new Error(`Failed to download file from ${fileUrl}`);
    }

    // Create FormData for upload
    const FormData = (await import("form-data")).default;
    const form = new FormData();

    // Get file extension from URL or filename
    const urlParts = fileUrl.split(".");
    const extension =
      urlParts.length > 1 ? urlParts[urlParts.length - 1].split("?")[0] : "jpg";

    // Create buffer from downloaded data
    const buffer = Buffer.from(response.data);

    // Append file to form data
    form.append("file", buffer, {
      filename: fileName || `file.${extension}`,
      contentType: response.headers["content-type"] || `image/${extension}`,
    });

    // Upload to KeyCRM storage
    const uploadResponse = await keycrmApiClient.post<StorageUploadResponse>(
      "/storage/upload",
      form,
      {
        headers: {
          ...form.getHeaders(),
        },
        timeout: 60000, // 60 seconds timeout for upload
      },
    );

    if (!uploadResponse.data?.url) {
      throw new Error("Upload response does not contain file URL");
    }

    return uploadResponse.data.url;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const fullErrorMessage = `Failed to download and upload file: ${errorMessage}`;
    console.error(fullErrorMessage, error);
    throw new Error(fullErrorMessage);
  }
}

/**
 * Meta/Instagram can reject nested proxy links like `download?url=...`.
 * For Telegram and known proxy patterns, upload to KeyCRM storage first
 * and use the resulting public URL in outgoing attachment.
 */
async function prepareMetaCompatibleAttachmentUrl(
  sourceUrl: string,
  fileName: string,
): Promise<string> {
  const source = sourceUrl.trim();
  const lowered = source.toLowerCase();
  const requiresReupload =
    lowered.includes("api.telegram.org/") || lowered.includes("download?url=");

  if (!requiresReupload) {
    return source;
  }

  return downloadAndUploadFile(source, fileName);
}

/**
 * Чи є замовлення самовивозом (не очікуємо оплату).
 * Перевіряє назву статусу та наявність тегу "Самовивіз".
 */
export const isOrderSelfPickup = (order: Order): boolean => {
  const statusName =
    (order.status as { name?: string } | undefined)?.name ?? "";
  if (statusName.toLowerCase().includes("самовивіз")) return true;
  const hasSelfPickupTag = order.tags?.some((tag) =>
    (tag.name ?? "").toLowerCase().includes("самовивіз"),
  );
  return !!hasSelfPickupTag;
};

export type PaymentValidationResult =
  | { ok: true }
  | { skip: true; reason: "self_pickup" }
  | { skip: true; reason: "no_paid_products" }
  | { error: "no_payments"; message: string }
  | { error: "missing_description"; message: string };

/**
 * Перевіряє оплати замовлення: для не-самовивозу потрібна хоча б одна оплата, у кожної — description.
 * Оплати зі status "canceled" не враховуються (тільки при перевірці на вебхуку).
 */
export const validateOrderPayments = (
  order: Order,
): PaymentValidationResult => {
  if (isOrderSelfPickup(order)) {
    return { skip: true, reason: "self_pickup" };
  }

  const hasPaidProduct = (order.products ?? []).some(
    (p) => (p.price_sold ?? p.price ?? 0) > 0,
  );
  if (!hasPaidProduct) {
    return { skip: true, reason: "no_paid_products" };
  }

  const allPayments = order.payments;
  const payments =
    allPayments && Array.isArray(allPayments)
      ? allPayments.filter(
          (p) => p != null && (p.status ?? "").toLowerCase() !== "canceled",
        )
      : [];

  if (payments.length === 0) {
    return {
      error: "no_payments",
      message: `Замовлення №${order.id}: відсутні оплати. Замовлення переведено в статус «Помилка».`,
    };
  }

  const withoutDescription = payments.filter(
    (p) => p == null || (p.description ?? "").toString().trim() === "",
  );
  if (withoutDescription.length > 0) {
    return {
      error: "missing_description",
      message: `Замовлення №${order.id}: у оплаті (оплатах) відсутній опис. Замовлення переведено в статус «Помилка».`,
    };
  }

  return { ok: true };
};

/**
 * Перевіряє оплати замовлення. Якщо не самовивіз: при відсутності оплат або при відсутності description
 * у будь-якої оплати — переводить замовлення в статус помилки та надсилає повідомлення в Telegram.
 */
export const checkOrderPaymentsAndRevert = async (
  orderId: string | number,
  reply?: FastifyReply,
) => {
  const log = reply?.log ?? console;
  try {
    const res = await keycrmApiClient.get<Order>(
      `order/${+orderId}?include=assigned,custom_fields,shipping.deliveryService,buyer,manager,products,tags,status,payments`,
    );
    const order = res?.data;
    if (!order) {
      log.error({ error: `Order ${orderId} not found` });
      return { ok: false, error: "Order not found" };
    }

    const result = validateOrderPayments(order);
    if ("ok" in result && result.ok === true) {
      return { ok: true, message: "Payments OK" };
    }
    if ("skip" in result && result.skip) {
      return { ok: true, skipped: true, reason: result.reason };
    }

    const message = "error" in result ? result.message : "";
    await changeOrderStatus(orderId, PAYMENT_ERROR_STATUS_ID);
    if (managersChatId && message) {
      const managerText = order.manager?.username
        ? `@${order.manager.username}\n`
        : "";
      const orderLink = `\nhttps://sunflower.keycrm.app/app/orders/view/${orderId}`;
      await sendTelegramMessage(
        managersChatId,
        managerText + message + orderLink,
      );
    }
    return {
      ok: false,
      revertedToStatus: PAYMENT_ERROR_STATUS_ID,
      message,
    };
  } catch (error) {
    log.error({ error });
    throw error;
  }
};

/**
 * Validates order status change and reverts if requirements are not met.
 * Requirements for non-closing statuses:
 * - shipping_date_actual must be set
 * - Order must have a branch tag (Файна, Севен, Француз, Республіка)
 */
export const validateOrderStatusChange = async (
  orderId: string | number,
  reply: FastifyReply,
) => {
  try {
    // Get order with status included
    const res = await keycrmApiClient.get<Order>(
      `order/${+orderId}?include=assigned,custom_fields,shipping.deliveryService,buyer,manager,products,tags,status`,
    );

    const order = res?.data;

    if (!order) {
      reply.log.error({ error: `Order ${orderId} not found` });
      return;
    }

    const { status, shipping, tags, manager } = order;

    // Skip validation if status is closing order
    if (status?.is_closing_order) {
      return {
        validated: true,
        message: "Closing status - no validation needed",
      };
    }

    const errors: string[] = [];

    // Check if shipping_date_actual is set
    const hasShippingDate = !!shipping?.shipping_date_actual;
    if (!hasShippingDate) {
      errors.push("не встановлена дата відправки замовлення");
    }

    // Check if order has a branch tag
    const hasBranchTag = tags?.some((tag) =>
      BRANCH_TAGS.some((branchName) =>
        tag.name.toLowerCase().includes(branchName.toLowerCase()),
      ),
    );
    if (!hasBranchTag) {
      errors.push("немає тегу філії.");
    }

    // If validation failed, revert to initial status and notify
    if (errors.length > 0) {
      // Revert to initial status
      await changeOrderStatus(orderId, INITIAL_STATUS_ID);

      // Get manager username
      const managerText = manager?.username
        ? `\nМенеджер: @${manager.username}`
        : "";

      // Order link
      const orderLink = `\nhttps://sunflower.keycrm.app/app/orders/view/${orderId}`;

      // Build error message
      const errorMessage = `Замовлення №${orderId} ${errors.join(" або ")}${managerText}${orderLink}`;

      // Send notification to managers chat
      await sendTelegramMessage(managersChatId, errorMessage);

      return {
        validated: false,
        message: errorMessage,
        revertedToStatus: INITIAL_STATUS_ID,
      };
    }

    return { validated: true, message: "Order passed validation" };
  } catch (error) {
    reply.log.error({ error });
    throw error;
  }
};

/**
 * Перевіряє адресу доставки та координати замовлення.
 * Відкатує замовлення на статус id=7, якщо:
 * 1) Вказана адреса доставки, але не вказані координати (індекс).
 * 2) Координати вказані не у форматі "число, число".
 * 3) Адреси немає і статус має group_id = 4 (адреса не встановлена взагалі).
 * Для замовлень з тегом "Самовивіз" або "Уточнити адресу" перевірку не виконуємо.
 */
export const validateOrderAddressAndRevert = async (
  orderId: string | number,
  reply?: FastifyReply,
) => {
  const log = reply?.log ?? console;
  try {
    const res = await keycrmApiClient.get<Order>(
      `order/${+orderId}?include=assigned,custom_fields,shipping.deliveryService,buyer,manager,products,tags,status`,
    );
    const order = res?.data;
    if (!order) {
      log.error({ error: `Order ${orderId} not found` });
      return { reverted: false, error: "Order not found" };
    }

    const skipAddressValidationTags = ["самовивіз", "уточнити адресу"];
    const hasSkipAddressValidationTag = order.tags?.some((tag) => {
      const name = (tag.name ?? "").toLowerCase();
      return skipAddressValidationTags.some((t) => name.includes(t));
    });
    if (hasSkipAddressValidationTag) {
      return { reverted: false };
    }

    const { status, shipping, manager } = order;
    const zip = (shipping?.shipping_address_zip ?? "").trim();
    const city = (shipping?.shipping_address_city ?? "").trim();
    const region = (shipping?.shipping_address_region ?? "").trim();
    const secondary = (shipping?.shipping_secondary_line ?? "").trim();
    const receivePoint = (shipping?.shipping_receive_point ?? "").trim();

    const hasAddress = !!city || !!region || !!secondary || !!receivePoint;
    const hasCoordinates = !!zip;
    const validCoordinatesFormat = COORDINATES_REGEX.test(zip);
    const statusGroupId = status?.group_id ?? order.status_group_id;

    const reasons: string[] = [];

    if (hasAddress && !hasCoordinates) {
      reasons.push(
        "вказана адреса доставки, але не вказані координати (індекс)",
      );
    }
    if (hasCoordinates && !validCoordinatesFormat) {
      reasons.push(
        'координати не у форматі "число, число" (наприклад 50.45, 30.52)',
      );
    }
    if (!hasAddress && statusGroupId === 4) {
      reasons.push('адреса не встановлена, а статус у групі "Доставки"');
    }

    if (reasons.length === 0) {
      return { reverted: false, message: "Address and coordinates OK" };
    }

    await changeOrderStatus(orderId, ADDRESS_REVERT_STATUS_ID);
    const managerText = manager?.username ? `@${manager.username}\n` : "";
    const orderLink = `\nhttps://sunflower.keycrm.app/app/orders/view/${orderId}`;
    const message = `${managerText}Замовлення №${orderId}: ${reasons.join("; ")}. Замовлення на статусі «Помилка».\n${orderLink}`;
    if (managersChatId) {
      await sendTelegramMessage(managersChatId, message);
    }
    return {
      reverted: true,
      revertedToStatus: ADDRESS_REVERT_STATUS_ID,
      reasons,
      message,
    };
  } catch (error) {
    log.error({ error });
    throw error;
  }
};

/**
 * Пагіновано отримує замовлення з KeyCRM для дат 13-15 лютого 2026.
 * Фільтрує тільки ті, що не виконані та не скасовані.
 */
export const fetchOrdersForReserve = async (): Promise<Order[]> => {
  const allOrders: Order[] = [];
  let page = 1;
  const limit = 50;
  let hasMore = true;

  const shippingBetween = "2026-02-13 00:00:00,2026-02-15 23:59:59";
  const include =
    "assigned,custom_fields,shipping.deliveryService,buyer,manager,products,tags,status";

  while (hasMore) {
    const response = await keycrmApiClient.get<{ data: Order[] }>("/order", {
      params: {
        limit,
        page,
        "filter[shipping_between]": shippingBetween,
        include,
      },
    });

    const orders = response.data?.data ?? [];
    allOrders.push(...orders);

    if (orders.length < limit) {
      hasMore = false;
    } else {
      page++;
    }

    await new Promise((r) => setTimeout(r, 1100));
  }

  return allOrders.filter((order) => {
    const status = order.status;
    if (!status) return true;
    if (status.is_closing_order) return false;
    const name = (status.name || "").toLowerCase();
    if (name.includes("скасовано") || name.includes("отменен")) return false;
    return true;
  });
};
