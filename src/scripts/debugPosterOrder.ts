import "dotenv/config";
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

type PosterSpot = {
  spot_id: number;
  name: string;
  spot_delete: number;
};

type KeycrmProductDetails = {
  id: number;
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
  return map;
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

const extractPosterProductId = (
  product: Order["products"][number],
  productsDetailsMap: Map<number, KeycrmProductDetails>,
): number | null => {
  const anyProduct = product as unknown as Record<string, unknown>;
  const fromProductCustomFields = getCustomFieldValueByUuid(
    anyProduct.custom_fields,
    "CT_1008",
  );
  const offer = anyProduct.offer as Record<string, unknown> | undefined;
  const offerProduct = offer?.product as Record<string, unknown> | undefined;
  const fromOfferProductCustomFields = getCustomFieldValueByUuid(
    offerProduct?.custom_fields,
    "CT_1008",
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
        "CT_1008",
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
    return {
      name: product.name,
      quantity: product.quantity,
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
      ct1008_from_catalog_product_custom_fields: getCustomFieldValueByUuid(
        productsDetailsMap.get(
          getNumericIdFromUnknown((product.offer as { product_id?: unknown })?.product_id) ??
            getNumericIdFromUnknown((product as unknown as { id?: unknown })?.id) ??
            -1,
        )?.custom_fields,
        "CT_1008",
      ),
      offer_product_id: (product.offer as { product_id?: unknown })?.product_id,
      resolved_product_id: extractPosterProductId(product, productsDetailsMap),
      resolved_modificator_id: extractPosterModificatorId(product),
      raw_properties: product.properties ?? [],
    };
  });

  const products = (order.products ?? [])
    .map((product) => {
      const productId = extractPosterProductId(product, productsDetailsMap);
      const count = Number(product.quantity ?? 0);
      const price = Number(product.price_sold ?? product.price ?? 0);
      const modificatorId = extractPosterModificatorId(product);
      const comment = String(product.comment ?? "").trim();
      if (!productId || !Number.isFinite(count) || count <= 0) return null;
      return {
        product_id: productId,
        count,
        price: Number.isFinite(price) && price >= 0 ? price : 0,
        ...(modificatorId ? { modificator_id: modificatorId } : {}),
        ...(comment ? { comment } : {}),
      };
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
  console.error("Debug script failed:", error?.response?.data || error);
  process.exit(1);
});
