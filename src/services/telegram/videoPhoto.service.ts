import { keycrmApiClient } from "../../api/keycrmApiClient.js";
import { Order } from "../../types/keycrm.js";
import { isCourier, isHoliday, deliveryRegex } from "./config.js";

export { deliveryRegex };

export type DeliveryValidationResult =
  | {
      success: true;
      order: Order;
      orderId: string;
      managerUsername: string;
    }
  | { success: false; userMessage: string };

/** Перевіряє замовлення та права кур'єра. Не змінює статус — це робить хендлер після пересилки. */
export async function validateDeliveryVideo(
  orderId: string,
  username: string,
): Promise<DeliveryValidationResult> {
  try {
    const res = await keycrmApiClient.get<Order>(
      `order/${+orderId}?include=manager,assigned`,
    );

    if (!res?.data) {
      return {
        success: false,
        userMessage:
          "Такого замовлення не існує, перевірте будь ласка номер замовлення та спробуйте ще раз.",
      };
    }

    const order = res.data;

    if (!isHoliday && !isCourier(username)) {
      return {
        success: false,
        userMessage: "Вибачте, цей функціонал доступний тільки кур'єрам.",
      };
    }

    if (!isHoliday && (!order.assigned || order.assigned.length === 0)) {
      return {
        success: false,
        userMessage:
          "На це замовлення спершу треба призначити відповідальних.",
      };
    }

    const managerUsername = order.manager?.username ?? "";
    return {
      success: true,
      order,
      orderId,
      managerUsername,
    };
  } catch (error: unknown) {
    const is404 =
      typeof (error as { status?: number })?.status === "number" &&
      (error as { status: number }).status === 404;
    if (is404) {
      return {
        success: false,
        userMessage:
          "Такого замовлення не існує, перевірте будь ласка номер замовлення та спробуйте ще раз.",
      };
    }
    throw error;
  }
}

export function buildDeliveryMessages(
  orderId: string,
  forwardOk: boolean,
  statusOk: boolean,
): { messageForCourier: string; messageForManager: string } {
  let messageForCourier: string;
  if (forwardOk) {
    messageForCourier =
      "Дякуємо за вашу роботу. Повідомлення було відправлено у групу.";
  } else {
    messageForCourier =
      "Сталася якась помилка при пересилці відео у групу. Спробуйте це зробити власноруч.";
  }

  let messageForManager: string;
  if (statusOk) {
    messageForManager = `Замовлення №${orderId} було доставлено. Статус замовлення було змінено.`;
  } else {
    messageForManager = `Кур'єр доставив замовлення №${orderId}, однак воно не було переведено по статусу далі. Перевірте будь ласка у CRM.`;
    messageForCourier +=
      " Статус замовлення не був змінений у системі. Напишіть менеджеру.";
  }

  return { messageForCourier, messageForManager };
}
