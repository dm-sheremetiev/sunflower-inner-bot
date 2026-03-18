import { messageHelper } from "./src/helpers/messageHelper.js";
import dayjs from "dayjs";

const crmUser = { crmUserId: 1, username: "dmitry" };
const mockOrders: any[] = [
  {
    id: 1234,
    manager: { id: 1, username: "dmitry" },
    shipping: { shipping_date_actual: dayjs().toISOString() },
    custom_fields: []
  }
];

const messages = messageHelper.formatMyOrdersMessage(mockOrders, crmUser);
console.log("MESSAGES RETURNED:", JSON.stringify(messages, null, 2));

const mockOrders2: any[] = [
];

const messages2 = messageHelper.formatMyOrdersMessage(mockOrders2, crmUser);
console.log("MESSAGES RETURNED EMPTY:", JSON.stringify(messages2, null, 2));
