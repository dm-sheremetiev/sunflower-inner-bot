import dayjs from "dayjs";
import { FastifyRequest, FastifyReply } from "fastify";
import { keycrmApiClient } from "../api/keycrmApiClient.js";
import { Order } from "../types/keycrm.js";

/** Стилі для iframe Print.js (друк) */
const PRINT_STYLES = `
  body { font-family: Arial, sans-serif; width: 101mm; margin: 0; padding: 1px; }
  .order-container { border: none; padding: 0; width: 100%; text-align: left; height: 101mm; min-height: 101mm; position: relative; box-sizing: border-box; }
  .order-title { font-size: 95px; font-weight: bold; margin-bottom: 10px; text-align: center; }
  .order-item { font-size: 11px; margin: 5px 0; }
  .bold-text { font-weight: bold; }
  .small { font-size: 7px; }
  .sticker-bottom-bar { position: absolute; left: 0; right: 20%; bottom: 0; border: 2px solid black; border-right: none; display: flex; padding: 0; background: white; box-sizing: border-box; }
  .sticker-bottom-bar.full-width { right: 0; border-right: 2px solid black; }
  .sticker-bottom-bar > *:last-child { border-right: none; }
  .sticker-bottom-left { font-weight: 900; font-size: 18px; text-align: left; flex: 0 0 auto; background: white; border-right: 2px solid black; padding: 0 2px; box-sizing: border-box; display: flex; align-items: center; justify-content: flex-start; white-space: nowrap; }
  .sticker-bottom-center { font-weight: 900; font-size: 18px; text-align: center; flex: 0 0 auto; background: white; border-right: 2px solid black; padding: 0 2px; box-sizing: border-box; display: flex; align-items: center; justify-content: center; white-space: nowrap; }
  .sticker-bottom-leaflet { font-weight: 900; font-size: 18px; text-align: center; flex: 0 0 auto; background: white; border-right: 2px solid black; padding: 0 2px; box-sizing: border-box; display: flex; align-items: center; justify-content: center; white-space: nowrap; }
  .sticker-numbering-box { position: absolute; right: 0; bottom: 0; width: 20%; min-height: 52px; border: 2px solid black; background: white; box-sizing: border-box; display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 28px; text-align: center; }
  @page { size: 101mm 101mm; margin: 1px; padding: 1px; }
  .order-container.sticker-copy { page-break-after: always; }
  .order-container.sticker-copy:last-of-type { page-break-after: avoid; }
`;

export const printOrderInfo = async (
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) => {
  try {
    const { id } = request.params;

    const res = await keycrmApiClient.get(`/order/${id}`, {
      params: {
        include:
          "assigned,custom_fields,shipping.deliveryService,buyer,manager,products,tags",
      },
    });
    const order: Order | null = res.data || null;

    // Если заказ не найден, возвращаем сообщение об ошибке
    if (!order) {
      return reply.type("text/html").send(`
        <html>
          <head>
            <meta charset="UTF-8">
            <title>Замовлення не знайдено</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; display: flex; align-items: center; justify-items: center; }
              .order-title { font-size: 20px; font-weight: bold; color: red; }
            </style>
          </head>
          <body>
            <div class="order-title">Помилка: замовлення #${id} не знайдено</div>
          </body>
        </html>
      `);
    }

    const phone = order.shipping?.recipient_phone || order.buyer?.phone;
    const phoneNumber = phone
      ? `
    <div class="order-item">Тел: ${phone}${order?.shipping?.recipient_full_name ? `, ${order?.shipping?.recipient_full_name}` : ""}</div>`
      : "";

    // Address
    const city = order.shipping?.shipping_address_city
      ? `${order.shipping?.shipping_address_city}, `
      : "";

    const region = order.shipping?.shipping_address_region
      ? `${order.shipping?.shipping_address_region}, `
      : "";

    const coordinates = order.shipping?.shipping_address_zip
      ? `${order.shipping?.shipping_address_zip}, `
      : "";

    const address =
      order.shipping?.shipping_receive_point ||
      order.shipping?.shipping_secondary_line;

    const addressString = city + region + coordinates + address;

    const fullAddress = addressString
      ? `
      <div class="order-item">Адреса: ${addressString}</div>`
      : "";

    const price = (
      order?.products?.[0]?.price_sold || order.products[0]?.price
    )?.toLocaleString("uk-UA", {
      style: "currency",
      currency: "UAH",
      minimumFractionDigits: 0,
    });

    const managerComment =
      order?.manager_comment && order?.manager_comment !== "null"
        ? `<div class="order-item">Ком. <span class="bold-text">менеджера:</span>${order?.manager_comment}</div>`
        : "";
    const buyerComment =
      order?.buyer_comment && order?.buyer_comment !== "null"
        ? `<div class="order-item">Ком. <span class="bold-text">покупця:</span>${order?.buyer_comment}</div>`
        : "";

    const giftMessage = order?.gift_message
      ? `<div class="order-item small"><span class="bold-text">Листівка:</span>${order?.gift_message}</div>`
      : "";

    const hasLeaflet = !!(
      order?.gift_message &&
      String(order.gift_message).trim() !== "" &&
      order.gift_message !== "null"
    );

    const timeFlorField = order?.custom_fields.find((field) => field.id === 4);
    const timeFlor = timeFlorField
      ? `<div class="order-item">Час для <span class="bold-text">флористів:</span>${timeFlorField.value}</div>`
      : "";

    const timeCourierField = order?.custom_fields.find(
      (field) => field.id === 5
    );

    const timeCourierFor = order?.custom_fields.find((field) =>
      field.name.includes("Часовий проміжок доставки або самовивозу")
    );

    const timeCourier = timeCourierField
      ? `<div class="order-item">Час для <span class="bold-text">кур'єрів:</span>${timeCourierField?.value}</div>`
      : "";

    const timeCourierRange = timeCourierFor
      ? `<div class="order-item"><span class="bold-text">Часовий проміжок доставки або самовивозу:</span>${timeCourierFor?.value}</div>`
      : "";

    // District
    const districtField = order?.custom_fields.find((field) =>
      field.name.includes("Район доставки")
    );
    const district = districtField
      ? `<div class="order-item"><span class="bold-text">Район:</span>${districtField?.value}</div>`
      : "";

    const nameOfProd =
      (order?.products?.[0]?.name || "") +
      (order?.products[0]?.sku ? `,Арт.: ${order?.products[0]?.sku}` : "");

    const shippingDate = order.shipping.shipping_date_actual;
    const date =
      order.shipping.shipping_date_actual && dayjs(shippingDate).isValid()
        ? `<div class="order-item"><span class="bold-text">Дата доставки/відправки: ${dayjs(shippingDate).format("DD.MM.YYYY")}</span></div>`
        : "";

    const isPickUp =
      order.tags?.find((tag) =>
        tag?.name ? tag.name.toLowerCase().includes("самовивіз") : false
      ) ||
      order.custom_fields?.find((field) => {
        if (!field) return false;
        const v = field.value;
        const str = Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
        return str.includes("Cамовивіз");
      });

    const pickUpString = isPickUp
      ? `
      <div class="order-item bold-text">САМОВИВІЗ</div>`
      : "";

    // Кількість композицій (OR_1015): value може бути масивом ["2"] або рядком
    const compositionsField = order.custom_fields?.find(
      (f) => f.uuid === "OR_1015" || f.name?.includes("Кількість композицій")
    );
    const rawCompositions = compositionsField?.value;
    const compositionsCount = Array.isArray(rawCompositions)
      ? Math.max(1, parseInt(String(rawCompositions[0]), 10) || 1)
      : Math.max(1, parseInt(String(rawCompositions || "1"), 10) || 1);

    // кульки до замовлення (OR_1017): показувати "кульки" зліва внизу
    const ballsField = order.custom_fields?.find(
      (f) => f.uuid === "OR_1017" || f.name?.includes("кульки до замовлення")
    );
    const rawBalls = ballsField?.value;
    const hasBalls = Array.isArray(rawBalls)
      ? String(rawBalls[0]).toLowerCase() === "true"
      : String(rawBalls || "").toLowerCase() === "true";

    const hasGift = order.is_gift === true;

    // Всього наклейок: композиції + 1 за кульки (якщо є) + 1 за подарунок (якщо є)
    const totalStickersCount =
      compositionsCount + (hasBalls ? 1 : 0) + (hasGift ? 1 : 0);

    // Responsible
    const assignee = order.assigned?.map((as) => as.last_name).join(",");
    const responsible = assignee
      ? `
    <div class="order-item bold-text">Відповідальні: ${assignee}</div>`
      : "";

    const orderNumberDisplay = totalStickersCount >= 2 ? `${id}*` : id;
    const stickerContent = `
            <div class="order-title">${orderNumberDisplay}</div>
            ${date}
            ${responsible}
            ${timeCourierRange}
            ${district}
            ${pickUpString}
            <div class="order-item">${nameOfProd} ${price || "-"}</div>
            ${timeFlor}
            ${timeCourier}
            ${phoneNumber}
            ${fullAddress}
            ${managerComment}
            ${buyerComment}
            ${giftMessage}`;

    const hasBottomBarContent = hasBalls || hasGift || hasLeaflet;
    const buildBottomBar = (fractionRight: string, count: number) => {
      const showNumbering = count >= 2;
      if (!hasBottomBarContent && !showNumbering) return "";
      const showBar = hasBottomBarContent;
      const barClass = "sticker-bottom-bar" + (showNumbering ? "" : " full-width");
      return `
          ${showBar ? `<div class="${barClass}">
            ${hasBalls ? '<span class="sticker-bottom-left">КУЛЬКИ</span>' : ""}
            ${hasGift ? '<span class="sticker-bottom-center">ПОДАРУНОК</span>' : ""}
            ${hasLeaflet ? '<span class="sticker-bottom-leaflet">ЛИСТІВКА</span>' : ""}
          </div>` : ""}
          ${showNumbering ? `<div class="sticker-numbering-box">${fractionRight}</div>` : ""}`;
    };

    const printAreaContent =
      totalStickersCount >= 2
        ? Array.from({ length: totalStickersCount }, (_, i) => i + 1)
            .map(
              (n) => `
          <div class="order-container sticker-copy">
            ${stickerContent}
            ${buildBottomBar(`${n}/${totalStickersCount}`, totalStickersCount)}
          </div>`
            )
            .join("")
        : `<div class="order-container">${stickerContent}${buildBottomBar("", totalStickersCount)}</div>`;

    const printStylesJson = JSON.stringify(PRINT_STYLES);

    reply.type("text/html").send(`
      <html>
        <head>
          <meta charset="UTF-8">
          <title>Замовлення №${id}</title>
          <link rel="stylesheet" href="https://printjs-4de6.kxcdn.com/print.min.css">
          <style>
            body {
              font-family: Arial, sans-serif;
              width: 101mm;
              padding: 10px;
              display: flex;
              flex-direction: column;
              align-items: center;
            }
            .order-container {
              border: none;
              padding: 0;
              width: 100%;
              text-align: left;
              height: 101mm;
              min-height: 101mm;
              position: relative;
              box-sizing: border-box;
            }
            .order-title {
              font-size: 95px;
              font-weight: bold;
              margin-bottom: 10px;
              text-align: center;
            }
            .order-item {
              font-size: 11px;
              margin: 5px 0;
            }
            .order-item-big {
              font-size: 12px;
            }
            .order-item__phone {
              font-size: 8px;
              margin: 5px 0;
              font-style: italic;
            }
            .bold-text {
              font-weight: bold;
            }
            .print-btn {
              margin-top: 0;
              margin-bottom: 10px;
              padding: 10px;
              font-size: 16px;
              background: black;
              color: white;
              border: none;
              cursor: pointer;
              width: 100%;
            }
            .small {
              font-size: 7px;
            }
            .sticker-bottom-bar {
              position: absolute;
              left: 0;
              right: 20%;
              bottom: 0;
              border: 2px solid black;
              border-right: none;
              display: flex;
              padding: 0;
              background: white;
              box-sizing: border-box;
            }
            .sticker-bottom-bar.full-width {
              right: 0;
              border-right: 2px solid black;
            }
            .sticker-bottom-bar > *:last-child {
              border-right: none;
            }
            .sticker-bottom-left {
              font-weight: 900;
              font-size: 18px;
              text-align: left;
              flex: 0 0 auto;
              background: white;
              border-right: 2px solid black;
              padding: 0 2px;
              box-sizing: border-box;
              display: flex;
              align-items: center;
              justify-content: flex-start;
              white-space: nowrap;
            }
            .sticker-bottom-center {
              font-weight: 900;
              font-size: 18px;
              text-align: center;
              flex: 0 0 auto;
              background: white;
              border-right: 2px solid black;
              padding: 0 2px;
              box-sizing: border-box;
              display: flex;
              align-items: center;
              justify-content: center;
              white-space: nowrap;
            }
            .sticker-numbering-box {
              position: absolute;
              right: 0;
              bottom: 0;
              width: 20%;
              min-height: 40px;
              border: 2px solid black;
              background: white;
              box-sizing: border-box;
              display: flex;
              align-items: center;
              justify-content: center;
              font-weight: 900;
              font-size: 28px;
              text-align: center;
            }
            .sticker-bottom-leaflet {
              font-weight: 900;
              font-size: 18px;
              text-align: center;
              flex: 0 0 auto;
              background: white;
              border-right: 2px solid black;
              padding: 0 2px;
              box-sizing: border-box;
              display: flex;
              align-items: center;
              justify-content: center;
              white-space: nowrap;
            }
            .compositions-notice {
              color: red;
              font-weight: bold;
              font-size: 14px;
              text-align: center;
              margin-bottom: 12px;
              padding: 8px;
              border: 2px solid red;
            }
    
            @media print {
          @page {
            size: 101mm 101mm;
            margin: 1px;
          }
            html {
            padding: 0;
            margin: 0;
                visibility: hidden;
          }
          body {
            visibility: hidden;
            width: 101mm;
            height: 101mm;
            margin: 0;
            padding: 1px;
          }
          .order-container {
            visibility: visible;
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            border: none;
            page-break-after: avoid;
          }
          .print-btn {
            display: none;
          }
          .compositions-notice {
            display: none !important;
          }
          .order-container.sticker-copy {
            position: relative;
            left: auto;
            top: auto;
            height: 101mm;
            min-height: 101mm;
            page-break-after: always;
          }
          .order-container.sticker-copy:last-of-type {
            page-break-after: avoid;
          }
        }
          </style>
        </head>
        <body>
          <button type="button" class="print-btn" id="btn-print">Друкувати</button>
          ${
            totalStickersCount >= 2
              ? `<div class="compositions-notice">УВАГА. Це замовлення має ${compositionsCount} композицій${hasBalls ? ", кульки" : ""}${hasGift ? ", подарунок" : ""}. Буде надруковано ${totalStickersCount} наклейок.</div>`
              : ""
          }
          <div id="print-area">${printAreaContent}</div>
          <script src="https://printjs-4de6.kxcdn.com/print.min.js"></script>
          <script>
            (function() {
              var printStyles = ${printStylesJson};
              document.getElementById('btn-print').onclick = function() {
                printJS({
                  printable: 'print-area',
                  type: 'html',
                  documentTitle: 'Замовлення №${id}',
                  style: printStyles,
                  scanStyles: true,
                  targetStyles: ['*']
                });
              };
            })();
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Ошибка:", error);
    return reply.type("text/html").send(`
      <html>
        <head>
          <meta charset="UTF-8">
          <title>Помилка серверу</title>
          <style>
            body { font-family: Arial, sans-serif; text-align: left; margin-top: 50px; }
            .order-title { font-size: 20px; font-weight: bold; color: red; }
          </style>
        </head>
        <body>
          <div class="order-title">Помилка серверу. Спробуйте пізніше.</div>
        </body>
      </html>
    `);
  }
};
