import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import type { FastifyReply } from "fastify";
import { keycrmApiClient } from "../api/keycrmApiClient.js";
import { posterApiClient } from "../api/posterApiClient.js";
import type { Order } from "../types/keycrm.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const KYIV_TZ = "Europe/Kyiv";
const DEFAULT_POSTER_PHONE = "+380989000000";
const POSTER_RECEIPT_FIELD_UUID = "OR_1018";
const DELIVERY_TIME_FIELD_UUID = "OR_1006";

type PosterSpot = {
  spot_id: number;
  name: string;
  spot_delete: number;
};

type PosterCreateIncomingOrderResponse = {
  response?: {
    transaction_id?: number;
  };
};

type PosterReceiptRecord = {
  branchName: string;
  transactionId: number;
};

type KeycrmCustomField = {
  id?: number;
  uuid?: string;
  name?: string;
  value?: unknown;
};

const extractOrderBranches = (order: Order, branchTags: string[]): string[] => {
  const byTags =
    order.tags
      ?.map((tag) => {
        const hit = branchTags.find((branch) =>
          tag.name.toLowerCase().includes(branch.toLowerCase()),
        );
        return hit ?? null;
      })
      .filter((item): item is string => Boolean(item)) ?? [];

  return [...new Set(byTags)];
};

const normalizePosterPhone = (value: string | null | undefined): string => {
  if (!value) return DEFAULT_POSTER_PHONE;
  const cleaned = value.replace(/[^\d+]/g, "").trim();
  if (!cleaned) return DEFAULT_POSTER_PHONE;
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("380")) return `+${cleaned}`;
  if (cleaned.startsWith("0")) return `+38${cleaned}`;
  return `+${cleaned}`;
};

const getDeliveryTimeRangeStart = (order: Order): string | null => {
  const timeField = order.custom_fields?.find((field) => {
    const name = String(field.name ?? "").toLowerCase();
    return (
      field.uuid === DELIVERY_TIME_FIELD_UUID ||
      name.includes("часовий проміжок")
    );
  });

  const raw = String(timeField?.value ?? "").trim();
  const match = raw.match(/^(\d{1,2}:\d{2})\s*-/);
  if (!match) return null;

  const [hours, minutes] = match[1].split(":").map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;
};

const getPosterDeliveryTime = (order: Order): string => {
  const baseDate = order.shipping?.shipping_date_actual
    ? dayjs(order.shipping.shipping_date_actual).tz(KYIV_TZ)
    : dayjs().tz(KYIV_TZ);
  const datePart = baseDate.format("YYYY-MM-DD");
  const timePart =
    getDeliveryTimeRangeStart(order) ?? dayjs().tz(KYIV_TZ).format("HH:mm:ss");
  return `${datePart} ${timePart}`;
};

const formatPosterReceiptsText = (receipts: PosterReceiptRecord[]): string => {
  if (receipts.length === 1) {
    return String(receipts[0].transactionId);
  }

  return receipts
    .map((item) => `${item.branchName}: ${item.transactionId}`)
    .join(", ");
};

const findPosterReceiptField = (
  customFields: KeycrmCustomField[] | undefined,
): KeycrmCustomField | undefined =>
  customFields?.find((field) => {
    const name = String(field.name ?? "").toLowerCase();

    return (
      field.uuid === POSTER_RECEIPT_FIELD_UUID ||
      name.includes("номер замовлення у poster")
    );
  });

const updatePosterReceiptInCrm = async (
  orderId: number,
  order: Order,
  receiptValue: string,
) => {
  const receiptField = findPosterReceiptField(
    order.custom_fields as KeycrmCustomField[],
  );
  const customFieldPayload = receiptField?.id
    ? [{ id: receiptField.id, value: receiptValue }]
    : [{ uuid: POSTER_RECEIPT_FIELD_UUID, value: receiptValue }];

  await keycrmApiClient.put<Order>(`order/${orderId}`, {
    custom_fields: customFieldPayload,
  });
};

const fetchPosterSpots = async (): Promise<PosterSpot[]> => {
  const { data } = await posterApiClient.get<{ response?: PosterSpot[] }>(
    `/spots.getSpots`,
  );

  return Array.isArray(data?.response) ? data.response : [];
};

const getPosterOnlineShopSpotsByBranches = (
  spots: PosterSpot[],
  branches: string[],
): Array<{ branchName: string; spot: PosterSpot }> => {
  return branches
    .map((branchName) => {
      const spot = spots.find(
        (item) =>
          item.spot_delete === 0 &&
          item.name.toLowerCase().includes(branchName.toLowerCase()) &&
          item.name.toLowerCase().endsWith("інтернет-магазин"),
      );

      return spot ? { branchName, spot } : null;
    })
    .filter((item): item is { branchName: string; spot: PosterSpot } =>
      Boolean(item),
    );
};

const buildPosterComment = (order: Order): string => {
  const managerComment = String(order.manager_comment ?? "").trim();
  const clientComment = String(order.buyer_comment ?? "").trim();
  const parts: string[] = [];

  if (managerComment) {
    parts.push(`Коментар менеджера: ${managerComment}`);
  }
  if (clientComment) {
    parts.push(`Коментар клієнта: ${clientComment}`);
  }

  return parts.join(" | ");
};

export const createPosterOrdersAndStoreReceipts = async (
  order: Order,
  reply: FastifyReply,
  branchTags: string[],
): Promise<string | null> => {
  const orderId = Number(order.id);
  const branches = extractOrderBranches(order, branchTags);
  if (!branches.length) {
    reply.log.info({ orderId }, "Poster sync skipped: no branch tags");
    return null;
  }

  const spots = await fetchPosterSpots();
  const branchSpots = getPosterOnlineShopSpotsByBranches(spots, branches);
  if (!branchSpots.length) {
    reply.log.error(
      { orderId, branches },
      "Poster sync failed: no matching online shop spots",
    );
    return null;
  }

  const phone = normalizePosterPhone(
    order.shipping?.recipient_phone || order.buyer?.phone,
  );
  const deliveryTime = getPosterDeliveryTime(order);
  const address = [
    order.shipping?.shipping_address_city,
    order.shipping?.shipping_receive_point,
    order.shipping?.shipping_secondary_line,
  ]
    .filter((item) => typeof item === "string" && item.trim().length > 0)
    .join(", ");

  const products = (order.products ?? [])
    .map((product) => ({
      product_id: Number(product.offer?.product_id),
      count: Number(product.quantity ?? 0),
      price: Number(product.price_sold ?? product.price ?? 0),
    }))
    .filter(
      (product) =>
        Number.isFinite(product.product_id) &&
        product.product_id > 0 &&
        Number.isFinite(product.count) &&
        product.count > 0 &&
        Number.isFinite(product.price) &&
        product.price >= 0,
    );

  if (!products.length) {
    reply.log.error(
      { orderId },
      "Poster sync failed: no products with product_id",
    );
    return null;
  }

  const comment = buildPosterComment(order);
  const receipts: PosterReceiptRecord[] = [];

  for (const { branchName, spot } of branchSpots) {
    try {
      const payload = {
        spot_id: spot.spot_id,
        first_name: order.shipping?.recipient_full_name || phone,
        phone,
        address,
        comment,
        delivery_time: deliveryTime,
        skip_phone_validation: true,
        products,
      };

      const { data } = await posterApiClient.post<PosterCreateIncomingOrderResponse>(
        `/incomingOrders.createIncomingOrder`,
        payload,
      );

      const transactionId = Number(data?.response?.transaction_id);
      if (!Number.isFinite(transactionId) || transactionId <= 0) {
        reply.log.error(
          { orderId, branchName, spotId: spot.spot_id, response: data },
          "Poster sync failed: invalid transaction_id",
        );
        continue;
      }

      receipts.push({ branchName, transactionId });
    } catch (error) {
      reply.log.error(
        { error, orderId, branchName, spotId: spot.spot_id },
        "Poster sync failed while creating incoming order",
      );
    }
  }

  if (!receipts.length) return null;

  const receiptValue = formatPosterReceiptsText(receipts);
  try {
    await updatePosterReceiptInCrm(orderId, order, receiptValue);
    return receiptValue;
  } catch (error) {
    reply.log.error(
      { error, orderId, receiptValue },
      "Poster sync failed while saving receipt to CRM",
    );
    return null;
  }
};
