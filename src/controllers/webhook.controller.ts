import type { FastifyReply, FastifyRequest } from "fastify";
import { ChangeOrderEvent } from "../types/index.js";
import {
  sendPackedMessageNotification,
  sendMessageAboutWaiting,
  sendWithoutPackageMessageToManager,
  sendMessageAboutPackage,
  sendTelegramMessageAboutOrder,
  sendMessageAboutNewOrder,
  sendImageToCustomerChat,
  validateOrderStatusChange,
  validateOrderAddressAndRevert,
  checkOrderPaymentsAndRevert,
} from "../services/keycrm.services.js";

// Функция для валидации запроса и извлечения orderId
const validateOrderChangeEvent = (
  request: FastifyRequest<{ Body: ChangeOrderEvent | undefined }>
): number => {
  const body = request.body as ChangeOrderEvent | undefined;
  if (!body) {
    throw new Error("There is no body request provided.");
  }
  if (body.event !== "order.change_order_status") {
    throw new Error("Unsupported event.");
  }
  const orderId = body.context?.id;
  if (!orderId) {
    throw new Error("There is no order id provided.");
  }
  return orderId;
};
const safetyWrapper = async (
  request: FastifyRequest<{ Body: ChangeOrderEvent | undefined }>,
  reply: FastifyReply,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callback: (orderId: number) => Promise<any>,
  options?: { handleResponse?: boolean }
) => {
  try {
    const orderId = validateOrderChangeEvent(request);
    const result = await callback(orderId);
    
    // Only send response if the callback doesn't handle it itself
    if (!options?.handleResponse) {
      return reply.status(200).send(result);
    }
  } catch (error) {
    request.log.error({ error });
    
    // Only send error response if no response has been sent yet
    if (!reply.sent) {
      return reply.status(501).send({ message: "Internal Server Error", error });
    }
  }
};

// Использование safetyWrapper в обработчике getEvent
export const getEvent = async (
  request: FastifyRequest<{ Body: ChangeOrderEvent | undefined }>,
  reply: FastifyReply
) => {
  // В данном примере callback выполняет необходимую логику, например отправку сообщения в Telegram
  return safetyWrapper(request, reply, async (orderId) => {
    await sendTelegramMessageAboutOrder(orderId, reply);
  });
};

export const sendWithoutPackageMessage = async (
  request: FastifyRequest<{ Body: ChangeOrderEvent | undefined }>,
  reply: FastifyReply
) => {
  return safetyWrapper(request, reply, async (orderId) => {
    await sendWithoutPackageMessageToManager(orderId, reply, true); // isGeneralMessage means that you will send messages to all managers
  });
};

export const sendPackMeMessage = async (
  request: FastifyRequest<{ Body: ChangeOrderEvent | undefined }>,
  reply: FastifyReply
) => {
  return safetyWrapper(request, reply, async (orderId) => {
    await sendMessageAboutPackage(orderId, reply);
  });
};

export const sendPackedMessage = async (
  request: FastifyRequest<{ Body: ChangeOrderEvent | undefined }>,
  reply: FastifyReply
) => {
  return safetyWrapper(request, reply, async (orderId) => {
    await sendPackedMessageNotification(orderId, reply, true); // isGeneralMessage means that you will send messages to all managers
  });
};

export const sendWaitingForDeliveryMessage = async (
  request: FastifyRequest<{ Body: ChangeOrderEvent | undefined }>,
  reply: FastifyReply
) => {
  try {
    const body = request?.body as ChangeOrderEvent | undefined;

    if (!body) {
      throw new Error("There is no body request provided.");
    }

    // Only for change order status event
    if (body?.event === "order.change_order_status") {
      if (!body?.context?.id) {
        throw new Error("There is no order id provided.");
      }
      const orderId = body?.context?.id;

      const res = await sendMessageAboutWaiting(orderId, reply);

      return reply.status(200).send(res);
    }

    return reply.status(200).send();
  } catch (error) {
    request.log.error({ error });

    return reply.status(501).send({ message: "Internal Server Error", error });
  }
};

export const sendNewOrderMessage = async (
  request: FastifyRequest<{ Body: ChangeOrderEvent | undefined }>,
  reply: FastifyReply
) => {
  return safetyWrapper(request, reply, async (orderId) => {
    await sendMessageAboutNewOrder(orderId, reply);
  });
};

export const sendBareCompositionImageHandler = async (
  request: FastifyRequest<{ Body: ChangeOrderEvent | undefined }>,
  reply: FastifyReply
) => {
  return safetyWrapper(request, reply, async (orderId) => {
    await sendImageToCustomerChat(reply, orderId, 0);
  }, { handleResponse: true });
};

export const sendPackedCompositionImageHandler = async (
  request: FastifyRequest<{ Body: ChangeOrderEvent | undefined }>,
  reply: FastifyReply
) => {
  return safetyWrapper(request, reply, async (orderId) => {
    await sendImageToCustomerChat(reply, orderId, 1);
  }, { handleResponse: true });
};

export const validateStatusChangeHandler = async (
  request: FastifyRequest<{ Body: ChangeOrderEvent | undefined }>,
  reply: FastifyReply
) => {
  return safetyWrapper(request, reply, async (orderId) => {
    return await validateOrderStatusChange(orderId, reply);
  });
};

/**
 * Валідація адреси та координат замовлення.
 * Якщо адреса/координати не відповідають правилам — замовлення відкатується на статус id=7.
 * Очікує тіло події order.change_order_status (KeyCRM webhook).
 */
export const validateAddressAndRevertHandler = async (
  request: FastifyRequest<{ Body: ChangeOrderEvent | undefined }>,
  reply: FastifyReply
) => {
  return safetyWrapper(request, reply, async (orderId) => {
    return await validateOrderAddressAndRevert(orderId, reply);
  });
};

/**
 * Перевірка оплат замовлення.
 * Очікує тіло події order.change_order_status (KeyCRM webhook), як і перевірка адреси та інші вебхуки.
 * Якщо не самовивіз: при відсутності оплат або при відсутності description у оплати —
 * переводить замовлення в статус помилки та надсилає повідомлення в Telegram (з менеджером як на інших помилках).
 */
export const checkPaymentsHandler = async (
  request: FastifyRequest<{ Body: ChangeOrderEvent | undefined }>,
  reply: FastifyReply
) => {
  return safetyWrapper(request, reply, async (orderId) => {
    return await checkOrderPaymentsAndRevert(orderId, reply);
  });
};
