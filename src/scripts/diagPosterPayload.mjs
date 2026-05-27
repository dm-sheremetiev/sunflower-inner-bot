// Диагностика: повторяет логику poster.service.ts и печатает payload,
// который бот отправил бы в Poster для заданного заказа KeyCRM.
// Запуск: node --env-file=.env src/scripts/diagPosterPayload.mjs <orderId>

const BASE = process.env.KEYCRM_API_URL;
const KEY = process.env.KEYCRM_API_KEY;
const orderId = process.argv[2] || "31244";

const CT_PARENT = "CT_1022";
const CT_MODIFICATOR = "CT_1025";
const CT_DISHMOD = "CT_1026";
const CT_STOCK = "CT_1008";
const DELIVERY_TIME_FIELD_UUID = "OR_1006";
const DEFAULT_PHONE = "+380989000000";

const get = async (path) => {
  const r = await fetch(`${BASE}/${path}`, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
};

const cfByUuid = (fields, uuid) => {
  if (!Array.isArray(fields)) return null;
  const f = fields.find((x) => x && x.uuid === uuid);
  return f ? f.value ?? null : null;
};

const numId = (v) => {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.trunc(v);
  if (typeof v !== "string") return null;
  const m = v.trim().match(/\d+/);
  return m ? Number(m[0]) : null;
};

const parseIds = (v) => {
  if (v == null) return [];
  return String(v)
    .trim()
    .split(/[,;|\s]+/)
    .map(numId)
    .filter((x) => x != null);
};

const normPhone = (v) => {
  if (!v) return DEFAULT_PHONE;
  const c = String(v).replace(/[^\d+]/g, "").trim();
  if (!c) return DEFAULT_PHONE;
  if (c.startsWith("+")) return c;
  if (c.startsWith("380")) return `+${c}`;
  if (c.startsWith("0")) return `+38${c}`;
  return `+${c}`;
};

const main = async () => {
  const order = await get(
    `order/${orderId}?include=assigned,custom_fields,shipping.deliveryService,buyer,manager,products,products.offer,tags,payments`,
  );

  console.log("=== ORDER", orderId, "===");
  console.log("tags:", (order.tags || []).map((t) => t.name));
  console.log("buyer.phone:", order.buyer?.phone, "buyer.full_name:", order.buyer?.full_name);
  console.log("shipping_price:", order.shipping_price);
  console.log("shipping_date_actual:", order.shipping?.shipping_date_actual);
  const slot = cfByUuid(order.custom_fields, DELIVERY_TIME_FIELD_UUID);
  console.log("delivery slot (OR_1006):", JSON.stringify(slot));
  console.log("products count:", (order.products || []).length);
  console.log();

  // подтянем детали каталога (custom_fields) по каждому товару
  const detailsMap = new Map();
  for (const p of order.products || []) {
    const cid = numId(p.offer?.product_id) ?? numId(p.id);
    if (cid && !detailsMap.has(cid)) {
      try {
        const d = await get(`products/${cid}?include=custom_fields`);
        detailsMap.set(cid, d);
      } catch (e) {
        console.log("  ! failed product", cid, e.message);
      }
    }
  }

  const products = [];
  for (const p of order.products || []) {
    const cid = numId(p.offer?.product_id) ?? numId(p.id);
    const d = cid ? detailsMap.get(cid) : null;
    const rawValue = (uuid) =>
      cfByUuid(p.custom_fields, uuid) ??
      cfByUuid(p.offer?.product?.custom_fields, uuid) ??
      cfByUuid(d?.custom_fields, uuid);

    const count = Number(p.quantity ?? 0);
    const parent = parseIds(rawValue(CT_PARENT))[0];
    const modificatorId = parseIds(rawValue(CT_MODIFICATOR))[0];
    const dishMods = parseIds(rawValue(CT_DISHMOD));
    const stock = parseIds(rawValue(CT_STOCK))[0];

    let productId = parent;
    let usedFallback = false;
    if (!productId && !modificatorId && !dishMods.length) {
      productId = stock;
      usedFallback = true;
    }

    console.log(
      `LINE "${p.name}" qty=${count} | CT_1022=${parent ?? "-"} CT_1025=${modificatorId ?? "-"} CT_1026=[${dishMods}] CT_1008=${stock ?? "-"} => product_id=${productId ?? "SKIP"}${usedFallback ? " (fallback CT_1008)" : ""}`,
    );

    if (!Number.isFinite(count) || count <= 0) continue;
    if (!productId) continue;

    const item = { product_id: productId, count };
    if (modificatorId && modificatorId !== productId) item.modificator_id = modificatorId;
    else if (dishMods.length) {
      const qty = Math.max(1, Math.trunc(count));
      item.modification = JSON.stringify(
        [...dishMods].sort((a, b) => a - b).map((m) => ({ m, a: qty })),
      );
    }
    const cmt = String(p.comment ?? "").trim();
    if (cmt) item.comment = cmt;
    products.push(item);
  }

  const phone = normPhone(order.buyer?.phone);
  const payload = {
    spot_id: "<SPOT>",
    first_name: order.buyer?.full_name || order.shipping?.recipient_full_name || phone,
    ...(order.buyer?.email ? { email: order.buyer.email } : {}),
    phone,
    comment: `СРМ №${orderId}`,
    delivery_time: "<computed>",
    skip_phone_validation: true,
    products,
  };

  console.log("\n=== PAYLOAD (bot would send) ===");
  console.log(JSON.stringify(payload, null, 2));
};

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
