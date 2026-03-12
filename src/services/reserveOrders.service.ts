import dayjs from "dayjs";
import {
  Order,
  Product,
  CustomField,
  Assigned,
  Tag,
} from "../types/keycrm.js";
import { fetchOrdersForReserve } from "./keycrm.service.js";
import {
  ensureSheetsExist,
  getSheetData,
  sheetNames,
  syncReserveSheets,
} from "./googleSheets.service.js";

const BRANCH_TAGS = ["Республіка", "Файна", "Севен", "Француз"];

const CUSTOM_FIELD_NAMES = {
  deliveryTimeRange: "Часовий проміжок доставки або самовивозу",
  deliveryDistrict: "Район доставки / самовивіз",
  bouquetReadyBy: "Час, до якого букет повинен бути готовий повністю",
} as const;

const HEADERS = [
  "№ замовлення",
  "Філія",
  "Дата доставки",
  "Менеджер",
  "Призначені",
  "Товари",
  "Листівка",
  "Телефон покупця",
  "Покупець",
  "Адреса отримувача",
  "Телефон отримувача",
  "Ім'я отримувача",
  "Заметки менеджера",
  "Заметки клієнта",
  CUSTOM_FIELD_NAMES.deliveryTimeRange,
  CUSTOM_FIELD_NAMES.deliveryDistrict,
  CUSTOM_FIELD_NAMES.bouquetReadyBy,
  "Теги",
  "Є координати?",
];

/** Формат координат у полі індекс: "число, число" */
const COORDINATES_REGEX = /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/;

function hasCoordinates(order: Order): boolean {
  const zip = (order.shipping?.shipping_address_zip ?? "").trim();
  return zip.length > 0 && COORDINATES_REGEX.test(zip);
}

function formatAddress(order: Order): string {
  const s = order.shipping;
  if (!s) return "";
  const parts = [
    s.shipping_address_city,
    s.shipping_receive_point,
    s.shipping_secondary_line,
  ].filter(Boolean);
  return parts.join(", ");
}

function formatProducts(order: Order): string {
  if (!order.products?.length) return "";
  return order.products
    .map((p: Product) => `${p.name}${p.quantity > 1 ? ` x${p.quantity}` : ""}`)
    .join("; ");
}

function toSheetCellValue(val: unknown): string {
  if (val == null) return "";
  if (Array.isArray(val)) return val.map((v) => String(v ?? "")).join(", ");
  return String(val);
}

function getCustomFieldValue(order: Order, namePart: string): string {
  if (!order.custom_fields?.length) return "";
  const field = order.custom_fields.find((f: CustomField) =>
    f.name.toLowerCase().includes(namePart.toLowerCase())
  );
  return toSheetCellValue(field?.value ?? "");
}

function formatBouquetReadyTime(value: string): string {
  if (!value) return "";
  try {
    const parsed = dayjs(value);
    return parsed.isValid() ? parsed.format("HH:mm") : value;
  } catch {
    return value;
  }
}

function formatAssigned(order: Order): string {
  if (!order.assigned?.length) return "";
  return order.assigned.map((a: Assigned) => a.full_name).join(", ");
}

function getBranch(order: Order): string {
  if (!order.tags?.length) return "";
  const branch = order.tags.find((tag: Tag) =>
    BRANCH_TAGS.includes(tag.name)
  );
  return branch?.name ?? "";
}

function getTagsString(order: Order): string {
  if (!order.tags?.length) return "";
  return order.tags.map((t: Tag) => t.name).join(", ");
}

function getDeliveryDate(order: Order): string {
  const date = order.shipping?.shipping_date_actual;
  if (!date) return "";
  try {
    const parsed = dayjs(date);
    return parsed.isValid() ? parsed.format("YYYY-MM-DD") : "";
  } catch {
    return "";
  }
}

function orderToRow(order: Order): string[] {
  const bouquetReadyRaw = getCustomFieldValue(
    order,
    "Час, до якого букет повинен бути готовий повністю"
  );
  const bouquetReadyFormatted = formatBouquetReadyTime(bouquetReadyRaw);

  const row = [
    order.id,
    getBranch(order),
    getDeliveryDate(order),
    order.manager?.full_name ?? "",
    formatAssigned(order),
    formatProducts(order),
    order.gift_message ?? "",
    order.buyer?.phone ?? "",
    order.buyer?.full_name ?? "",
    formatAddress(order),
    order.shipping?.recipient_phone ?? "",
    order.shipping?.recipient_full_name ?? "",
    order.manager_comment ?? "",
    order.buyer_comment ?? "",
    getCustomFieldValue(order, "Часовий проміжок доставки або самовивозу"),
    getCustomFieldValue(order, "Район доставки / самовивіз"),
    bouquetReadyFormatted,
    getTagsString(order),
    hasCoordinates(order) ? "+" : "-",
  ];
  return row.map((v) => toSheetCellValue(v));
}

function ordersToRows(orders: Order[]): string[][] {
  const sorted = [...orders].sort((a, b) => {
    const dateA = getDeliveryDate(a);
    const dateB = getDeliveryDate(b);
    return dateA.localeCompare(dateB);
  });
  return [HEADERS, ...sorted.map(orderToRow)];
}

export async function syncReserveToSheets(): Promise<{
  ordersCount: number;
  error?: string;
}> {
  try {
    const orders = await fetchOrdersForReserve();

    await ensureSheetsExist();

    const mainData = await getSheetData(sheetNames.main);
    const copy1Data = await getSheetData(sheetNames.copy1);

    const newMainRows = ordersToRows(orders);
    const dataForCopy1 = mainData && mainData.length > 0 ? mainData : newMainRows;
    const dataForCopy2 =
      copy1Data && copy1Data.length > 0 ? copy1Data : dataForCopy1;

    await syncReserveSheets(dataForCopy2, dataForCopy1, newMainRows);

    return { ordersCount: orders.length };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error("Reserve sync error:", error);
    return { ordersCount: 0, error: message };
  }
}
