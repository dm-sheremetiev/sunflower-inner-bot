import axios from "axios";
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
const POSTER_INCOMING_PARENT_PRODUCT_FIELD_UUID = "CT_1022";
const POSTER_INCOMING_MODIFICATOR_FIELD_UUID = "CT_1025";
const POSTER_INCOMING_DISH_MODIFICATION_FIELD_UUID = "CT_1026";

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

type PosterIncomingOrderProduct = {
  product_id: number;
  count: number;
  modificator_id?: number;
  /** JSON-рядок: [{"m": dish_modification_id,"a": qty}, ...] відсортовано за m */
  modification?: string;
  comment?: string;
};

type KeycrmProductDetails = {
  id: number;
  parent_id?: number | null;
  custom_fields?: KeycrmCustomField[];
};

type PosterReceiptRecord = {
  branchName: string;
  transactionId: number;
};

type PosterApiLikePayload = {
  response?: {
    transaction_id?: unknown;
  };
};

type KeycrmCustomField = {
  id?: number;
  uuid?: string;
  name?: string;
  value?: unknown;
};

type OrderProduct = Order["products"][number];
type OrderProductWithMeta = OrderProduct & {
  id?: number;
  custom_fields?: KeycrmCustomField[];
  modificator_id?: number | string;
  offer: OrderProduct["offer"] & {
    product?: { custom_fields?: KeycrmCustomField[] };
  };
};

const hasSelfPickupTag = (order: Order): boolean =>
  order.tags?.some((tag) =>
    (tag.name ?? "").toLowerCase().includes("самовивіз"),
  ) ?? false;

const getPosterDeliveryPriceKopecks = (order: Order): number => {
  const raw = order.shipping_price;
  const uah = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(uah) || uah <= 0) return 0;
  return Math.round(uah * 100);
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

type PosterBuyerIdentity = {
  firstName?: string;
  email?: string;
};

const getPosterBuyerIdentity = (order: Order): PosterBuyerIdentity => {
  const fullName = String(order.buyer?.full_name ?? "").trim();
  const email = String(order.buyer?.email ?? "").trim();
  const orderId = Number(order.id);
  const crmOrderNumber =
    Number.isFinite(orderId) && orderId > 0
      ? Math.trunc(orderId).toString()
      : String(order.id ?? "").trim();
  const fallbackFirstName = `Клієнт з номеру замовлення ${crmOrderNumber}`;

  return {
    firstName: fullName || fallbackFirstName,
    email: email || undefined,
  };
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

/** OR_1018 завжди повністю замінюється на рядок з поточного синку Poster (без злиття зі старим value у заявці). */
const updatePosterReceiptInCrm = async (
  orderId: number,
  receiptValue: string,
) => {
  const { data: freshOrder } = await keycrmApiClient.get<Order>(
    `order/${orderId}?include=custom_fields`,
  );
  const receiptField = findPosterReceiptField(
    freshOrder?.custom_fields as KeycrmCustomField[],
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

const normalizeSpotName = (value: string): string =>
  value.toLowerCase().replace(/[—–-]/g, "-").replace(/\s+/g, " ").trim();

const isOnlineShopSpotName = (name: string): boolean => {
  const n = normalizeSpotName(name);
  return (
    n.includes("інтернет-магазин") ||
    n.includes("інтернет магазин") ||
    n.includes("интернет-магазин") ||
    n.includes("интернет магазин")
  );
};

// TEMP: у філіала "Француз" тимчасово не працює інтернет-магазин у Poster.
// Щоб прибрати, видаліть цю константу та блок у getPosterOnlineShopSpotsByBranches.
const TEMP_BRANCHES_FORCE_REGULAR_SPOT = [];

export const shouldForceRegularSpotForBranch = (branchName: string): boolean => {
  const branchNorm = normalizeSpotName(branchName);
  return TEMP_BRANCHES_FORCE_REGULAR_SPOT.some((name) =>
    branchNorm.includes(name),
  );
};

const getPosterOnlineShopSpotsByBranches = (
  spots: PosterSpot[],
  branches: string[],
): Array<{ branchName: string; spot: PosterSpot }> => {
  return branches
    .map((branchName) => {
      const branchNorm = normalizeSpotName(branchName);

      // if (shouldForceRegularSpotForBranch(branchName)) {
      //   const forcedRegularSpot = spots.find(
      //     (item) =>
      //       item.spot_delete === 0 &&
      //       normalizeSpotName(item.name).includes(branchNorm) &&
      //       !isOnlineShopSpotName(item.name),
      //   );
      //   return forcedRegularSpot
      //     ? { branchName, spot: forcedRegularSpot }
      //     : null;
      // }

      const spot = spots.find(
        (item) =>
          item.spot_delete === 0 &&
          normalizeSpotName(item.name).includes(branchNorm) &&
          isOnlineShopSpotName(item.name),
      );

      return spot ? { branchName, spot } : null;
    })
    .filter((item): item is { branchName: string; spot: PosterSpot } =>
      Boolean(item),
    );
};

const getPosterRegularSpotByBranch = (
  spots: PosterSpot[],
  branchName: string,
  excludeSpotId?: number,
): PosterSpot | null => {
  const branchNorm = normalizeSpotName(branchName);
  const spot = spots.find(
    (item) =>
      item.spot_delete === 0 &&
      (excludeSpotId == null || item.spot_id !== excludeSpotId) &&
      normalizeSpotName(item.name).includes(branchNorm) &&
      !isOnlineShopSpotName(item.name),
  );
  return spot ?? null;
};

const buildPosterComment = (order: Order): string => {
  const crmOrderId = Number(order.id);
  const crmOrderNumber =
    Number.isFinite(crmOrderId) && crmOrderId > 0
      ? Math.trunc(crmOrderId).toString()
      : String(order.id ?? "").trim();
  const parts: string[] = [`СРМ №${crmOrderNumber}`];

  // const managerComment = String(order.manager_comment ?? "").trim();
  // const clientComment = String(order.buyer_comment ?? "").trim();

  // if (managerComment) {
  //   parts.push(`Коментар менеджера: ${managerComment}`);
  // }
  // if (clientComment) {
  //   parts.push(`Коментар клієнта: ${clientComment}`);
  // }

  return parts.join(" | ");
};

const getNumericIdFromUnknown = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value !== "string") return null;
  const match = value.trim().match(/\d+/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const buildPosterModificationString = (
  entries: Array<{ m: number; a: number }>,
): string | undefined => {
  if (!entries.length) return undefined;
  const sorted = [...entries].sort((a, b) => a.m - b.m);
  return JSON.stringify(sorted);
};

const getIncomingFieldRawValue = (
  product: OrderProduct,
  catalogDetails: KeycrmProductDetails | undefined,
  uuid: string,
): unknown => {
  const productMeta = asOrderProductWithMeta(product);
  const offerProduct = productMeta.offer?.product;

  return (
    getCustomFieldValueByUuid(productMeta.custom_fields, uuid) ??
    getCustomFieldValueByUuid(offerProduct?.custom_fields, uuid) ??
    getCustomFieldValueByUuid(catalogDetails?.custom_fields, uuid)
  );
};

const parseFieldIds = (value: unknown): number[] => {
  if (value == null) {
    return [];
  }

  const raw = String(value).trim();
  if (!raw) {
    return [];
  }

  return raw
    .split(/[,;|\s]+/)
    .map((part) => getNumericIdFromUnknown(part))
    .filter((id): id is number => id != null);
};

const summarizeAxiosErrorForLog = (error: unknown): Record<string, unknown> => {
  if (!axios.isAxiosError(error)) {
    return {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : typeof error,
    };
  }
  const cfg = error.config;
  let requestData: unknown = cfg?.data;
  if (typeof requestData === "string") {
    const raw = requestData;
    try {
      requestData = JSON.parse(raw) as unknown;
    } catch {
      requestData = raw.length > 2500 ? `${raw.slice(0, 2500)}…` : raw;
    }
  }
  return {
    message: error.message,
    name: error.name,
    code: error.code,
    status: error.response?.status,
    statusText: error.response?.statusText,
    responseHeaders: error.response?.headers,
    responseData: error.response?.data,
    url: cfg?.url,
    method: cfg?.method,
    baseURL: cfg?.baseURL,
    requestData,
  };
};

const extractPosterTransactionId = (payload: unknown): number | null => {
  if (!payload || typeof payload !== "object") return null;
  const transactionIdRaw = (payload as PosterApiLikePayload)?.response
    ?.transaction_id;
  const transactionId = Number(transactionIdRaw);
  if (!Number.isFinite(transactionId) || transactionId <= 0) return null;
  return Math.trunc(transactionId);
};

const getCustomFieldValueByUuid = (
  customFields: unknown,
  uuid: string,
): unknown => {
  if (!Array.isArray(customFields)) return null;
  const field = customFields.find(
    (item) =>
      item &&
      typeof item === "object" &&
      (item as { uuid?: string }).uuid === uuid,
  ) as { value?: unknown } | undefined;
  return field?.value ?? null;
};

const asOrderProductWithMeta = (product: OrderProduct): OrderProductWithMeta =>
  product as OrderProductWithMeta;

const fetchProductDetailsById = async (
  productId: number,
): Promise<KeycrmProductDetails | null> => {
  try {
    const { data } = await keycrmApiClient.get<KeycrmProductDetails>(
      `products/${productId}?include=custom_fields`,
    );
    return data ?? null;
  } catch {
    return null;
  }
};

const fetchOrderProductsDetailsMap = async (
  order: Order,
): Promise<Map<number, KeycrmProductDetails>> => {
  const ids = new Set<number>();

  for (const product of order.products ?? []) {
    const productMeta = asOrderProductWithMeta(product);
    const offerProductId = getNumericIdFromUnknown(product.offer?.product_id);
    const fallbackProductId = getNumericIdFromUnknown(productMeta.id);
    const resolvedId = offerProductId ?? fallbackProductId;
    if (resolvedId) ids.add(resolvedId);
  }

  const map = new Map<number, KeycrmProductDetails>();
  await Promise.all(
    [...ids].map(async (id) => {
      const details = await fetchProductDetailsById(id);
      if (details) map.set(id, details);
    }),
  );

  const parentIds = [...map.values()]
    .map((d) => getNumericIdFromUnknown(d.parent_id))
    .filter((id): id is number => id != null && !map.has(id));

  await Promise.all(
    parentIds.map(async (parentId) => {
      const details = await fetchProductDetailsById(parentId);
      if (details) map.set(parentId, details);
    }),
  );

  return map;
};

const getCatalogProductIdForLine = (product: OrderProduct): number | null => {
  const productMeta = asOrderProductWithMeta(product);
  const offerProductId = getNumericIdFromUnknown(product.offer?.product_id);
  const fallbackProductId = getNumericIdFromUnknown(productMeta.id);

  return offerProductId ?? fallbackProductId;
};

const mapOrderProductsToPosterProducts = async (
  order: Order,
  reply: FastifyReply,
): Promise<PosterIncomingOrderProduct[]> => {
  const productsDetailsMap = await fetchOrderProductsDetailsMap(order);
  const mapped = (order.products ?? [])
    .map((product) => {
      const catalogId = getCatalogProductIdForLine(product);
      const details = catalogId ? productsDetailsMap.get(catalogId) : undefined;

      const count = Number(product.quantity ?? 0);
      const comment = String(product.comment ?? "").trim();

      if (!Number.isFinite(count) || count <= 0) {
        return null;
      }

      let modificatorId: number | undefined;
      let modification: string | undefined;

      const incomingParentProductId = parseFieldIds(
        getIncomingFieldRawValue(
          product,
          details,
          POSTER_INCOMING_PARENT_PRODUCT_FIELD_UUID,
        ),
      )[0];

      const incomingModificatorId = parseFieldIds(
        getIncomingFieldRawValue(
          product,
          details,
          POSTER_INCOMING_MODIFICATOR_FIELD_UUID,
        ),
      )[0];
      const incomingDishModificationIds = parseFieldIds(
        getIncomingFieldRawValue(
          product,
          details,
          POSTER_INCOMING_DISH_MODIFICATION_FIELD_UUID,
        ),
      );

      const productId = incomingParentProductId;

      if (!productId) {
        return null;
      }

      if (incomingModificatorId && incomingModificatorId !== productId) {
        modificatorId = incomingModificatorId;
      } else if (incomingDishModificationIds.length) {
        const qty = Math.max(1, Math.trunc(count));
        const sorted = [...incomingDishModificationIds].sort((a, b) => a - b);
        modification = buildPosterModificationString(
          sorted.map((m) => ({ m, a: qty })),
        );
      }

      if (modificatorId && modificatorId === productId) {
        modificatorId = undefined;
      }

      const payloadItem: PosterIncomingOrderProduct = {
        product_id: productId,
        count,
      };

      if (modificatorId) payloadItem.modificator_id = modificatorId;
      if (modification) payloadItem.modification = modification;
      if (comment) payloadItem.comment = comment;

      return payloadItem;
    })
    .filter((item): item is PosterIncomingOrderProduct => Boolean(item));

  if (!mapped.length) {
    reply.log.error(
      {
        orderId: order.id,
        productsPreview: (order.products ?? []).map((product) => {
          const productMeta = asOrderProductWithMeta(product);
          return {
            name: product.name,
            quantity: product.quantity,
            offerProductId: product.offer?.product_id,
            fetchedCatalogProductCustomFields: productsDetailsMap.get(
              getNumericIdFromUnknown(product.offer?.product_id) ??
                getNumericIdFromUnknown(productMeta.id) ??
                -1,
            )?.custom_fields,
            productCustomFields: productMeta.custom_fields,
            offerProductCustomFields: productMeta.offer?.product?.custom_fields,
            properties: product.properties,
          };
        }),
      },
      "Poster sync failed: cannot map KeyCRM products to Poster products",
    );
  }

  return mapped;
};

export const createPosterOrdersAndStoreReceipts = async (
  order: Order,
  reply: FastifyReply,
  branchTags: string[],
): Promise<string | null> => {
  const orderId = Number(order.id);
  const branches = extractOrderBranches(order, branchTags);
  if (!branches.length) {
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

  const phone = normalizePosterPhone(order.buyer?.phone);
  const buyerIdentity = getPosterBuyerIdentity(order);
  const deliveryTime = getPosterDeliveryTime(order);
  // const address = [
  //   order.shipping?.shipping_address_city,
  //   order.shipping?.shipping_receive_point,
  //   order.shipping?.shipping_secondary_line,
  // ]
  //   .filter((item) => typeof item === "string" && item.trim().length > 0)
  //   .join(", ");

  const products = await mapOrderProductsToPosterProducts(order, reply);
  if (!products.length) {
    reply.log.error(
      { orderId },
      "Poster sync failed: no products mapped for Poster payload",
    );
    return null;
  }

  const comment = buildPosterComment(order);
  const deliveryPriceKopecks = getPosterDeliveryPriceKopecks(order);
  const includeDeliveryFields =
    !hasSelfPickupTag(order) && deliveryPriceKopecks > 0;
  const receipts: PosterReceiptRecord[] = [];

  for (const { branchName, spot } of branchSpots) {
    const payloadBase = {
      first_name:
        buyerIdentity.firstName || order.shipping?.recipient_full_name || phone,
      ...(buyerIdentity.email ? { email: buyerIdentity.email } : {}),
      phone,
      // address,
      comment,
      delivery_time: deliveryTime,
      skip_phone_validation: true,
      ...(includeDeliveryFields
        ? { service_mode: 3, delivery_price: deliveryPriceKopecks }
        : {}),
      products,
    };

    try {
      const payload = {
        spot_id: spot.spot_id,
        ...payloadBase,
      };

      const { data } =
        await posterApiClient.post<PosterCreateIncomingOrderResponse>(
          `/incomingOrders.createIncomingOrder`,
          payload,
        );
      console.log("POSTER DATA", data);

      const transactionId = extractPosterTransactionId(data);
      if (!transactionId) {
        reply.log.error(
          { orderId, branchName, spotId: spot.spot_id, response: data },
          "Poster sync failed: invalid transaction_id",
        );
        continue;
      }

      receipts.push({ branchName, transactionId });
    } catch (error) {
      const transactionIdFromError = axios.isAxiosError(error)
        ? extractPosterTransactionId(error.response?.data)
        : null;
      if (transactionIdFromError) {
        receipts.push({ branchName, transactionId: transactionIdFromError });
        reply.log.warn(
          {
            orderId,
            branchName,
            spotId: spot.spot_id,
            transactionId: transactionIdFromError,
            posterRequest: summarizeAxiosErrorForLog(error),
          },
          "Poster returned error but transaction_id was extracted from error response",
        );
        continue;
      }
      reply.log.error(
        {
          orderId,
          branchName,
          spotId: spot.spot_id,
          posterRequest: summarizeAxiosErrorForLog(error),
        },
        "Poster sync failed while creating incoming order",
      );

      const fallbackSpot = getPosterRegularSpotByBranch(
        spots,
        branchName,
        spot.spot_id,
      );
      if (!fallbackSpot) {
        continue;
      }

      try {
        const fallbackPayload = {
          spot_id: fallbackSpot.spot_id,
          ...payloadBase,
        };

        const { data: fallbackData } =
          await posterApiClient.post<PosterCreateIncomingOrderResponse>(
            `/incomingOrders.createIncomingOrder`,
            fallbackPayload,
          );

        const fallbackTransactionId = extractPosterTransactionId(fallbackData);
        if (!fallbackTransactionId) {
          reply.log.error(
            {
              orderId,
              branchName,
              primarySpotId: spot.spot_id,
              fallbackSpotId: fallbackSpot.spot_id,
              response: fallbackData,
            },
            "Poster fallback failed: invalid transaction_id",
          );
          continue;
        }

        receipts.push({ branchName, transactionId: fallbackTransactionId });
        reply.log.warn(
          {
            orderId,
            branchName,
            primarySpotId: spot.spot_id,
            fallbackSpotId: fallbackSpot.spot_id,
          },
          "Poster fallback succeeded: order sent to regular branch spot",
        );
      } catch (fallbackError) {
        const fallbackTransactionIdFromError = axios.isAxiosError(fallbackError)
          ? extractPosterTransactionId(fallbackError.response?.data)
          : null;

        if (fallbackTransactionIdFromError) {
          receipts.push({
            branchName,
            transactionId: fallbackTransactionIdFromError,
          });
          reply.log.warn(
            {
              orderId,
              branchName,
              primarySpotId: spot.spot_id,
              fallbackSpotId: fallbackSpot.spot_id,
              transactionId: fallbackTransactionIdFromError,
              posterRequest: summarizeAxiosErrorForLog(fallbackError),
            },
            "Poster fallback returned error but transaction_id was extracted",
          );
          continue;
        }
        reply.log.error(
          {
            orderId,
            branchName,
            primarySpotId: spot.spot_id,
            fallbackSpotId: fallbackSpot.spot_id,
            posterRequest: summarizeAxiosErrorForLog(fallbackError),
          },
          "Poster fallback failed while creating incoming order",
        );
      }
    }
  }

  if (!receipts.length) return null;

  const receiptValue = formatPosterReceiptsText(receipts);
  try {
    await updatePosterReceiptInCrm(orderId, receiptValue);
    return receiptValue;
  } catch (error) {
    reply.log.error(
      { error, orderId, receiptValue },
      "Poster sync failed while saving receipt to CRM",
    );
    return null;
  }
};
