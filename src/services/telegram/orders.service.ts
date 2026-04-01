import dayjs from "dayjs";
import axios from "axios";
import { fileHelper } from "../../helpers/fileHelper.js";
import { fetchActiveCrmUsers, fetchAllOrders } from "../../helpers/keycrmHelper.js";
import { keycrmApiClient } from "../../api/keycrmApiClient.js";
import type { Order } from "../../types/keycrm.js";
import { normalizePhone } from "../../helpers/utils.js";
import { isCourier, isFloristRole } from "./config.js";

/** Група статусів «доставка» в KeyCRM — такі замовлення не показуємо флористам у списку. */
const DELIVERY_STATUS_GROUP_ID = 4;

function orderVisibleInFloristList(order: Order): boolean {
  const statusGroupId = order.status?.group_id ?? order.status_group_id;
  if (statusGroupId === DELIVERY_STATUS_GROUP_ID) return false;
  if (order.status?.is_closing_order === true) return false;
  return true;
}

type CrmUserRef = { crmUserId?: number; username?: string; phone?: string };

function matchesCrmUser(order: Order, crmUser: CrmUserRef): boolean {
  if (crmUser.crmUserId && order.manager?.id === crmUser.crmUserId) return true;
  if (
    crmUser.crmUserId &&
    order.assigned?.some((as) => as.id === crmUser.crmUserId)
  )
    return true;

  const username = crmUser.username?.toLowerCase();
  if (username) {
    if (order?.manager?.username?.toLowerCase() === username) return true;
    if (order.assigned?.some((as) => as.username?.toLowerCase() === username))
      return true;
  }

  const phone = crmUser.phone ? normalizePhone(crmUser.phone) : null;
  if (phone) {
    const buyerPhone = order.buyer?.phone ? normalizePhone(order.buyer.phone) : null;
    const recipientPhone = order.shipping?.recipient_phone
      ? normalizePhone(order.shipping.recipient_phone)
      : null;
    if (buyerPhone && buyerPhone === phone) return true;
    if (recipientPhone && recipientPhone === phone) return true;
  }

  return false;
}

function getOrderSortTs(order: Order): number | null {
  const shippingDate = (order.shipping as any)?.shipping_date;
  const iso =
    order.shipping?.shipping_date_actual || shippingDate || order.ordered_at || order.created_at;
  const d = dayjs(iso);
  return d.isValid() ? d.valueOf() : null;
}

export type UserOrderSummary = {
  id: number;
  sortTs: number | null;
  shippingDateIso?: string | null;
  timeWindow?: string;
  address?: string;
  statusName?: string;
  statusAlias?: string;
  grandTotal?: number;
  deliveryServiceName?: string;
};

export async function getUserOrdersSummary(
  chatId: number,
): Promise<UserOrderSummary[]> {
  const users = fileHelper.loadUsers();
  const crmUser = users[chatId];
  if (!crmUser) return [];

  if (crmUser.crmRoleId == null && crmUser.crmUserId != null) {
    try {
      const crmUsers = await fetchActiveCrmUsers();
      const match = (crmUsers as { id: number; role_id?: number }[]).find(
        (u) => u.id === crmUser.crmUserId,
      );
      if (match && typeof match.role_id === "number") {
        crmUser.crmRoleId = match.role_id;
        users[chatId] = crmUser;
        fileHelper.saveUsers(users);
      }
    } catch {
      /* ignore */
    }
  }

  const startOfToday = dayjs().startOf("day").format("YYYY-MM-DD HH:mm:ss");
  const endOfNextDay = dayjs()
    .add(3, "day")
    .endOf("day")
    .format("YYYY-MM-DD HH:mm:ss");
  const shippingBetween = `${startOfToday},${endOfNextDay}`;

  const orders = await fetchAllOrders(shippingBetween);
  let filtered = orders.filter((o) => matchesCrmUser(o, crmUser));
  const username = crmUser.username ?? "";
  if (isFloristRole(crmUser.crmRoleId) && !isCourier(username)) {
    filtered = filtered.filter(orderVisibleInFloristList);
  }

  return filtered
    .map((o) => ({
      id: o.id,
      sortTs: getOrderSortTs(o),
      shippingDateIso: o.shipping?.shipping_date_actual || (o.shipping as any)?.shipping_date || null,
      timeWindow:
        (o.custom_fields as any)?.find?.(
          (f: any) =>
            f.uuid === "OR_1006" ||
            String(f.name ?? "").toLowerCase().includes("часовий проміжок"),
        )?.value
          ? String(
              (o.custom_fields as any).find(
                (f: any) =>
                  f.uuid === "OR_1006" ||
                  String(f.name ?? "")
                    .toLowerCase()
                    .includes("часовий проміжок"),
              )?.value,
            ).trim()
          : "Не визначено",
      address: [
        o.shipping?.shipping_address_city,
        o.shipping?.shipping_receive_point,
        o.shipping?.shipping_secondary_line,
      ]
        .filter((x) => typeof x === "string" && x.trim().length > 0)
        .join(", ")
        .replace(/\s*,\s*(,\s*)+/g, ", ")
        .replace(/,\s*$/, "")
        .trim(),
      statusName: o.status?.name,
      statusAlias: (o.status as any)?.alias,
      grandTotal: o.grand_total,
      deliveryServiceName: (o.shipping as any)?.deliveryService?.name,
    }))
    .sort((a, b) => {
      if (a.sortTs == null && b.sortTs == null) return a.id - b.id;
      if (a.sortTs == null) return 1;
      if (b.sortTs == null) return -1;
      return a.sortTs - b.sortTs;
    });
}

export async function getOrderDetails(orderId: number): Promise<Order | null> {
  try {
    const res = await keycrmApiClient.get<Order>(
      `order/${orderId}?include=assigned,custom_fields,shipping.deliveryService,buyer,manager,products,tags,status,payments,attachments,attachments.file`,
    );
    return res?.data ?? null;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return null;
    }
    throw error;
  }
}
