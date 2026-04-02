import "dotenv/config";
import axios from "axios";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { keycrmApiClient } from "../api/keycrmApiClient.js";
import { posterApiClient } from "../api/posterApiClient.js";
import type { Order } from "../types/keycrm.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const KYIV_TZ = "Europe/Kyiv";
const DEFAULT_POSTER_PHONE = "+380989000000";
const BRANCH_TAGS = ["Файна", "Севен", "Француз", "Республіка"];
const POSTER_PRODUCT_FIELD_UUID = "CT_1008";
const POSTER_INGREDIENTS_FIELD_UUID = "CT_1014";

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

const parseCt1014ModifierIds = (value: unknown): number[] => {
  if (value == null) return [];
  const raw = String(value).trim();
  if (!raw) return [];
  return raw
    .split(/[,;|\s]+/)
    .map((part) => getNumericIdFromUnknown(part))
    .filter((id): id is number => id != null);
};

const buildPosterModificationString = (
  entries: Array<{ m: number; a: number }>,
): string | undefined => {
  if (!entries.length) return undefined;
  const sorted = [...entries].sort((a, b) => a.m - b.m);
  return JSON.stringify(sorted);
};

const mergeCt1014FromProductSources = (
  product: Order["products"][number],
  catalogDetails: KeycrmProductDetails | undefined,
): number[] => {
  const anyProduct = product as unknown as Record<string, unknown>;
  const offer = anyProduct.offer as Record<string, unknown> | undefined;
  const offerProduct = offer?.product as Record<string, unknown> | undefined;
  const seen = new Set<number>();
  const out: number[] = [];
  const pushAll = (value: unknown) => {
    for (const id of parseCt1014ModifierIds(value)) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  };
  pushAll(getCustomFieldValueByUuid(anyProduct.custom_fields, POSTER_INGREDIENTS_FIELD_UUID));
  pushAll(
    getCustomFieldValueByUuid(offerProduct?.custom_fields, POSTER_INGREDIENTS_FIELD_UUID),
  );
  if (catalogDetails) {
    pushAll(
      getCustomFieldValueByUuid(catalogDetails.custom_fields, POSTER_INGREDIENTS_FIELD_UUID),
    );
  }
  return out;
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

const extractPosterIdFromDetails = (
  details: KeycrmProductDetails | undefined,
): number | null =>
  details
    ? getNumericIdFromUnknown(
        getCustomFieldValueByUuid(details.custom_fields, POSTER_PRODUCT_FIELD_UUID),
      )
    : null;

const normalizePosterPhone = (value: string | null | undefined): string => {
  if (!value) return DEFAULT_POSTER_PHONE;
  const cleaned = value.replace(/[^\d+]/g, "").trim();
  if (!cleaned) return DEFAULT_POSTER_PHONE;
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("380")) return `+${cleaned}`;
  if (cleaned.startsWith("0")) return `+38${cleaned}`;
  return `+${cleaned}`;
};

const extractPosterProductId = (
  product: Order["products"][number],
  productsDetailsMap: Map<number, KeycrmProductDetails>,
): number | null => {
  const anyProduct = product as unknown as Record<string, unknown>;
  const fromProductCustomFields = getCustomFieldValueByUuid(
    anyProduct.custom_fields,
    POSTER_PRODUCT_FIELD_UUID,
  );
  const offer = anyProduct.offer as Record<string, unknown> | undefined;
  const offerProduct = offer?.product as Record<string, unknown> | undefined;
  const fromOfferProductCustomFields = getCustomFieldValueByUuid(
    offerProduct?.custom_fields,
    POSTER_PRODUCT_FIELD_UUID,
  );
  const offerProductId = getNumericIdFromUnknown(
    (product.offer as { product_id?: unknown })?.product_id,
  );
  const fallbackProductId = getNumericIdFromUnknown(
    (product as unknown as { id?: unknown })?.id,
  );
  const catalogProductId = offerProductId ?? fallbackProductId;
  const fromCatalogProductCustomFields = catalogProductId
    ? getCustomFieldValueByUuid(
        productsDetailsMap.get(catalogProductId)?.custom_fields,
        POSTER_PRODUCT_FIELD_UUID,
      )
    : null;

  return (
    getNumericIdFromUnknown(fromProductCustomFields) ??
    getNumericIdFromUnknown(fromOfferProductCustomFields) ??
    getNumericIdFromUnknown(fromCatalogProductCustomFields) ??
    getNumericIdFromUnknown((product.offer as { product_id?: unknown })?.product_id) ??
    null
  );
};

const extractPosterModificatorId = (
  product: Order["products"][number],
): number | null => {
  const anyProduct = product as unknown as Record<string, unknown>;
  const direct = getNumericIdFromUnknown(anyProduct.modificator_id);
  if (direct) return direct;

  if (Array.isArray(product.properties)) {
    for (const prop of product.properties) {
      const key = String(prop.name ?? "").toLowerCase();
      if (!key.includes("modificator") && !key.includes("модиф")) continue;
      const parsed = getNumericIdFromUnknown(prop.value);
      if (parsed) return parsed;
    }
  }
  return null;
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

function buildComment(order: Order): string {
  const manager = String(order.manager_comment ?? "").trim();
  const client = String(order.buyer_comment ?? "").trim();
  return [manager && `Коментар менеджера: ${manager}`, client && `Коментар клієнта: ${client}`]
    .filter(Boolean)
    .join(" | ");
}

async function main() {
  const { orderId, send } = parseArgs();
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
  const onlineShops = (spotsRes.response ?? []).filter(
    (spot) =>
      spot.spot_delete === 0 &&
      (spot.name.toLowerCase().includes("інтернет-магазин") ||
        spot.name.toLowerCase().includes("інтернет магазин")),
  );
  const matchedSpots = onlineShops.filter((spot) =>
    branches.some((branch) => spot.name.toLowerCase().includes(branch.toLowerCase())),
  );

  const productsPreview = (order.products ?? []).map((product) => {
    const anyProduct = product as unknown as Record<string, unknown>;
    const offer = anyProduct.offer as Record<string, unknown> | undefined;
    const offerProduct = offer?.product as Record<string, unknown> | undefined;
    const catalogId = getCatalogProductIdForLine(product);
    const details = catalogId ? productsDetailsMap.get(catalogId) : undefined;
    const parentId = details ? getNumericIdFromUnknown(details.parent_id) : null;
    const parentDetails =
      parentId != null ? productsDetailsMap.get(parentId) : undefined;

    const count = Number(product.quantity ?? 0);
    const modificatorFromLine = extractPosterModificatorId(product);
    let productId: number | null = null;
    let modificatorId: number | undefined;
    let modification: string | undefined;

    const childPosterId = extractPosterIdFromDetails(details);
    const parentPosterId = extractPosterIdFromDetails(parentDetails);

    if (parentDetails && parentPosterId) {
      productId = parentPosterId;
    } else {
      productId = extractPosterProductId(product, productsDetailsMap);
    }

    let techModifierIds = mergeCt1014FromProductSources(product, details);
    if (
      parentDetails &&
      parentPosterId &&
      childPosterId &&
      childPosterId !== parentPosterId &&
      !techModifierIds.includes(childPosterId)
    ) {
      techModifierIds = [...techModifierIds, childPosterId];
    }
    techModifierIds.sort((a, b) => a - b);

    if (modificatorFromLine && productId && modificatorFromLine !== productId) {
      modificatorId = modificatorFromLine;
    } else if (techModifierIds.length && productId) {
      const qty = Math.max(1, Math.trunc(count));
      modification = buildPosterModificationString(
        techModifierIds.map((m) => ({ m, a: qty })),
      );
    }

    return {
      name: product.name,
      quantity: product.quantity,
      catalog_product_id: catalogId,
      crm_parent_id: parentId,
      ct1008_from_product_custom_fields: getCustomFieldValueByUuid(
        anyProduct.custom_fields,
        POSTER_PRODUCT_FIELD_UUID,
      ),
      ct1008_from_offer_product_custom_fields: getCustomFieldValueByUuid(
        offerProduct?.custom_fields,
        POSTER_PRODUCT_FIELD_UUID,
      ),
      ct1014_from_product_custom_fields: getCustomFieldValueByUuid(
        anyProduct.custom_fields,
        POSTER_INGREDIENTS_FIELD_UUID,
      ),
      ct1008_from_catalog_product_custom_fields: getCustomFieldValueByUuid(
        productsDetailsMap.get(
          getNumericIdFromUnknown((product.offer as { product_id?: unknown })?.product_id) ??
            getNumericIdFromUnknown((product as unknown as { id?: unknown })?.id) ??
            -1,
        )?.custom_fields,
        POSTER_PRODUCT_FIELD_UUID,
      ),
      offer_product_id: (product.offer as { product_id?: unknown })?.product_id,
      resolved_product_id_poster: productId,
      child_poster_ct1008: childPosterId,
      parent_poster_ct1008: parentPosterId,
      tech_modifier_ids_for_poster_m: techModifierIds,
      resolved_modificator_id: modificatorId,
      resolved_modification_json_string: modification,
      raw_properties: product.properties ?? [],
    };
  });

  const products = (order.products ?? [])
    .map((product) => {
      const catalogId = getCatalogProductIdForLine(product);
      const details = catalogId ? productsDetailsMap.get(catalogId) : undefined;
      const parentId = details ? getNumericIdFromUnknown(details.parent_id) : null;
      const parentDetails =
        parentId != null ? productsDetailsMap.get(parentId) : undefined;

      const count = Number(product.quantity ?? 0);
      const modificatorFromLine = extractPosterModificatorId(product);
      const comment = String(product.comment ?? "").trim();

      if (!Number.isFinite(count) || count <= 0) {
        return null;
      }

      let productId: number | null = null;
      let modificatorId: number | undefined;
      let modification: string | undefined;

      const childPosterId = extractPosterIdFromDetails(details);
      const parentPosterId = extractPosterIdFromDetails(parentDetails);

      if (parentDetails && parentPosterId) {
        productId = parentPosterId;
      } else {
        productId = extractPosterProductId(product, productsDetailsMap);
      }

      if (!productId) {
        return null;
      }

      let techModifierIds = mergeCt1014FromProductSources(product, details);
      if (
        parentDetails &&
        parentPosterId &&
        childPosterId &&
        childPosterId !== parentPosterId &&
        !techModifierIds.includes(childPosterId)
      ) {
        techModifierIds = [...techModifierIds, childPosterId];
      }
      techModifierIds.sort((a, b) => a - b);

      if (modificatorFromLine && modificatorFromLine !== productId) {
        modificatorId = modificatorFromLine;
      } else if (techModifierIds.length) {
        const qty = Math.max(1, Math.trunc(count));
        modification = buildPosterModificationString(
          techModifierIds.map((m) => ({ m, a: qty })),
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

  const phone = normalizePosterPhone(
    order.shipping?.recipient_phone || order.buyer?.phone,
  );
  const address = [
    order.shipping?.shipping_address_city,
    order.shipping?.shipping_receive_point,
    order.shipping?.shipping_secondary_line,
  ]
    .filter((item) => typeof item === "string" && item.trim().length > 0)
    .join(", ");
  const delivery_time = getPosterDeliveryTime(order);
  const basePayload = {
    first_name: order.shipping?.recipient_full_name || phone,
    phone,
    address,
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
        matchedSpots,
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
    console.log(
      "\nCannot send: no mapped products or no matched online-shop spots.",
    );
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
