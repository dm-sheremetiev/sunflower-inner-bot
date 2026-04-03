import "dotenv/config";
import axios from "axios";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { keycrmApiClient } from "../api/keycrmApiClient.js";
import {
  posterApiClient,
  POSTER_API_TOKEN,
} from "../api/posterApiClient.js";
import type { Order } from "../types/keycrm.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const KYIV_TZ = "Europe/Kyiv";
const DEFAULT_POSTER_PHONE = "+380989000000";
const BRANCH_TAGS = ["Файна", "Севен", "Француз", "Республіка"];
const POSTER_INCOMING_PARENT_PRODUCT_FIELD_UUID = "CT_1022";
const POSTER_INCOMING_MODIFICATOR_FIELD_UUID = "CT_1025";
const POSTER_INCOMING_DISH_MODIFICATION_FIELD_UUID = "CT_1026";

type PosterSpot = {
  spot_id: number;
  name: string;
  spot_delete: number;
};

type KeycrmProductDetails = {
  id: number;
  parent_id?: number | null;
  custom_fields?: Array<{ uuid?: string; value?: unknown }>;
};

function parseArgs() {
  const args = process.argv.slice(2);
  const orderId = Number(args[0]);
  const send = args.includes("--send");
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error(
      "Usage: npm run debug:poster:order -- <orderId> [--send]",
    );
  }
  return { orderId, send };
}

const getCustomFieldValueByUuid = (customFields: unknown, uuid: string): unknown => {
  if (!Array.isArray(customFields)) return null;
  const field = customFields.find(
    (item) =>
      item &&
      typeof item === "object" &&
      (item as { uuid?: string }).uuid === uuid,
  ) as { value?: unknown } | undefined;
  return field?.value ?? null;
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
    const offerProductId = getNumericIdFromUnknown(
      (product.offer as { product_id?: unknown })?.product_id,
    );
    const fallbackProductId = getNumericIdFromUnknown(
      (product as unknown as { id?: unknown })?.id,
    );
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

const buildPosterModificationString = (
  entries: Array<{ m: number; a: number }>,
): string | undefined => {
  if (!entries.length) return undefined;
  const sorted = [...entries].sort((a, b) => a.m - b.m);
  return JSON.stringify(sorted);
};

const getIncomingFieldRawValue = (
  product: Order["products"][number],
  catalogDetails: KeycrmProductDetails | undefined,
  uuid: string,
): unknown => {
  const anyProduct = product as unknown as Record<string, unknown>;
  const offer = anyProduct.offer as Record<string, unknown> | undefined;
  const offerProduct = offer?.product as Record<string, unknown> | undefined;
  return (
    getCustomFieldValueByUuid(anyProduct.custom_fields, uuid) ??
    getCustomFieldValueByUuid(offerProduct?.custom_fields, uuid) ??
    getCustomFieldValueByUuid(catalogDetails?.custom_fields, uuid)
  );
};

const parseFieldIds = (value: unknown): number[] => {
  if (value == null) return [];
  const raw = String(value).trim();
  if (!raw) return [];
  return raw
    .split(/[,;|\s]+/)
    .map((part) => getNumericIdFromUnknown(part))
    .filter((id): id is number => id != null);
};

const getCatalogProductIdForLine = (
  product: Order["products"][number],
): number | null => {
  const offerProductId = getNumericIdFromUnknown(
    (product.offer as { product_id?: unknown })?.product_id,
  );
  const fallbackProductId = getNumericIdFromUnknown(
    (product as unknown as { id?: unknown })?.id,
  );
  return offerProductId ?? fallbackProductId;
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
    return field.uuid === "OR_1006" || name.includes("часовий проміжок");
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

function extractBranches(order: Order): string[] {
  const names = order.tags
    ?.map((tag) =>
      BRANCH_TAGS.find((branch) =>
        tag.name.toLowerCase().includes(branch.toLowerCase()),
      ),
    )
    .filter((x): x is string => Boolean(x));
  return [...new Set(names ?? [])];
}

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

const getPosterOnlineShopSpotsByBranches = (
  spots: PosterSpot[],
  branches: string[],
): Array<{ branchName: string; spot: PosterSpot }> => {
  return branches
    .map((branchName) => {
      const branchNorm = normalizeSpotName(branchName);
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

function buildComment(order: Order): string {
  const manager = String(order.manager_comment ?? "").trim();
  const client = String(order.buyer_comment ?? "").trim();
  return [manager && `Коментар менеджера: ${manager}`, client && `Коментар клієнта: ${client}`]
    .filter(Boolean)
    .join(" | ");
}

async function main() {
  const { orderId, send } = parseArgs();
  if (!String(POSTER_API_TOKEN ?? "").trim()) {
    console.error(
      "POSTER_API_TOKEN не задан у .env — spots.getSpots поверне порожній список, відправка неможлива.",
    );
    process.exit(1);
  }
  const include =
    "custom_fields,shipping,buyer,products,products.offer,tags,manager,payments,assigned";
  const { data: order } = await keycrmApiClient.get<Order>(
    `order/${orderId}?include=${include}`,
  );

  const branches = extractBranches(order);
  const productsDetailsMap = await fetchOrderProductsDetailsMap(order);
  const { data: spotsRes } = await posterApiClient.get<{ response?: PosterSpot[] }>(
    "/spots.getSpots",
  );
  const spots = spotsRes.response ?? [];
  const onlineShops = spots.filter(
    (spot) => spot.spot_delete === 0 && isOnlineShopSpotName(spot.name),
  );
  const branchSpotPairs = getPosterOnlineShopSpotsByBranches(spots, branches);
  const matchedSpots = branchSpotPairs.map((p) => p.spot);

  const productsPreview = (order.products ?? []).map((product) => {
    const anyProduct = product as unknown as Record<string, unknown>;
    const offer = anyProduct.offer as Record<string, unknown> | undefined;
    const offerProduct = offer?.product as Record<string, unknown> | undefined;
    const catalogId = getCatalogProductIdForLine(product);
    const details = catalogId ? productsDetailsMap.get(catalogId) : undefined;
    const parentId = details ? getNumericIdFromUnknown(details.parent_id) : null;

    const count = Number(product.quantity ?? 0);
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

    const productId = incomingParentProductId ?? null;

    if (productId) {
      if (incomingModificatorId && incomingModificatorId !== productId) {
        modificatorId = incomingModificatorId;
      } else if (incomingDishModificationIds.length) {
        const qty = Math.max(1, Math.trunc(count));
        const sorted = [...incomingDishModificationIds].sort((a, b) => a - b);
        modification = buildPosterModificationString(
          sorted.map((m) => ({ m, a: qty })),
        );
      }
    }

    return {
      name: product.name,
      quantity: product.quantity,
      catalog_product_id: catalogId,
      crm_parent_id: parentId,
      ct1008_from_product_custom_fields: getCustomFieldValueByUuid(
        anyProduct.custom_fields,
        "CT_1008",
      ),
      ct1008_from_offer_product_custom_fields: getCustomFieldValueByUuid(
        offerProduct?.custom_fields,
        "CT_1008",
      ),
      ct1014_from_product_custom_fields: getCustomFieldValueByUuid(
        anyProduct.custom_fields,
        "CT_1014",
      ),
      ct1022_parent_product_id: getIncomingFieldRawValue(
        product,
        details,
        POSTER_INCOMING_PARENT_PRODUCT_FIELD_UUID,
      ),
      ct1025_modificator_id: getIncomingFieldRawValue(
        product,
        details,
        POSTER_INCOMING_MODIFICATOR_FIELD_UUID,
      ),
      ct1026_dish_modification_id: getIncomingFieldRawValue(
        product,
        details,
        POSTER_INCOMING_DISH_MODIFICATION_FIELD_UUID,
      ),
      ct1008_from_catalog_product_custom_fields: getCustomFieldValueByUuid(
        productsDetailsMap.get(
          getNumericIdFromUnknown((product.offer as { product_id?: unknown })?.product_id) ??
            getNumericIdFromUnknown((product as unknown as { id?: unknown })?.id) ??
            -1,
        )?.custom_fields,
        "CT_1008",
      ),
      offer_product_id: (product.offer as { product_id?: unknown })?.product_id,
      poster_payload_product_id_ct1022_only: productId,
      resolved_modificator_id: modificatorId,
      resolved_modification_json_string: modification,
      raw_properties: product.properties ?? [],
    };
  });

  const products = (order.products ?? [])
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

      const productId = incomingParentProductId ?? null;

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

      const row: Record<string, unknown> = {
        product_id: productId,
        count,
      };
      if (modificatorId) row.modificator_id = modificatorId;
      if (modification) row.modification = modification;
      if (comment) row.comment = comment;
      return row;
    })
    .filter(Boolean);

  const phone = normalizePosterPhone(order.buyer?.phone);
  const delivery_time = getPosterDeliveryTime(order);
  const basePayload = {
    first_name: order.shipping?.recipient_full_name || phone,
    phone,
    comment: buildComment(order),
    delivery_time,
    skip_phone_validation: true,
    products,
  };

  console.log("=== ORDER DEBUG ===");
  console.log(
    JSON.stringify(
      {
        orderId: order.id,
        branches,
        spotsCount: spots.length,
        onlineShopsCount: onlineShops.length,
        onlineShopSpotNames: onlineShops.map((s) => s.name),
        matchedSpotsCount: matchedSpots.length,
        matchedSpotsPreview: branchSpotPairs.map((p) => ({
          branchName: p.branchName,
          spot_id: p.spot.spot_id,
          name: p.spot.name,
        })),
        spotsApiRawHint:
          spots.length === 0
            ? "Сирий відповідь spots.getSpots (перевірте token / обліковий запис): якщо порожньо — подивіться error у відповіді API у мережі"
            : undefined,
        spotsResponseSnippet: spots.length === 0 ? spotsRes : undefined,
      },
      null,
      2,
    ),
  );
  console.log("=== PRODUCTS PREVIEW ===");
  console.log(JSON.stringify(productsPreview, null, 2));
  console.log("=== POSTER PAYLOAD PREVIEW ===");
  console.log(JSON.stringify(basePayload, null, 2));

  if (!send) {
    console.log(
      "\nDry-run mode. To create real orders in Poster, run with --send",
    );
    return;
  }

  if (!products.length || !matchedSpots.length) {
    console.log("\nCannot send:");
    if (!products.length) {
      console.log(
        "- products порожній: перевірте CT_1022 / маппінг рядків замовлення.",
      );
    }
    if (!matchedSpots.length) {
      console.log(
        "- немає matched online-shop spots: перевірте теги філій у замовленні, назви точок Poster та POSTER_API_TOKEN.",
      );
      console.log(
        `  branches=${JSON.stringify(branches)}, spotsCount=${spots.length}, onlineShopsCount=${onlineShops.length}`,
      );
    }
    return;
  }

  for (const spot of matchedSpots) {
    const payload = { ...basePayload, spot_id: spot.spot_id };
    const { data } = await posterApiClient.post(
      "/incomingOrders.createIncomingOrder",
      payload,
    );
    console.log(`\n=== POSTER RESPONSE spot_id=${spot.spot_id} ===`);
    console.log(JSON.stringify(data, null, 2));
  }
}

main().catch((error) => {
  if (axios.isAxiosError(error)) {
    console.error("Debug script failed (HTTP):", {
      status: error.response?.status,
      responseData: error.response?.data,
      url: error.config?.url,
      method: error.config?.method,
    });
  } else {
    console.error("Debug script failed:", error);
  }
  process.exit(1);
});
