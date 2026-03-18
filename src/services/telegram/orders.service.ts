import dayjs from "dayjs";
import { fileHelper } from "../../helpers/fileHelper.js";
import { fetchAllOrders } from "../../helpers/keycrmHelper.js";
import { messageHelper } from "../../helpers/messageHelper.js";

export const getUserOrdersFormatted = async (chatId: number): Promise<string[]> => {
  const users = fileHelper.loadUsers();
  const crmUser = users[chatId];
  if (!crmUser) return [];

  const startOfToday = dayjs().startOf("day").format("YYYY-MM-DD HH:mm:ss");
  const endOfNextDay = dayjs()
    .add(3, "day") // Let's show up to 3 days to be useful
    .endOf("day")
    .format("YYYY-MM-DD HH:mm:ss");
  const shippingBetween = `${startOfToday},${endOfNextDay}`;

  const orders = await fetchAllOrders(shippingBetween);

  return messageHelper.formatMyOrdersMessage(orders, crmUser);
};
