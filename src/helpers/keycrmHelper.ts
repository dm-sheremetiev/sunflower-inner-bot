/* eslint-disable @typescript-eslint/no-explicit-any */
import { keycrmApiClient } from "../api/index.js";
import { AdminOrder, Order } from "../types/keycrm.js";

import "dotenv/config";

const branches = process.env.BRANCHES?.split(",") || [];

export const escapeMarkdown = (text: string) => {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
};

export const fetchAllOrders = async (shippingBetween: string) => {
  const allOrders: Order[] = [];
  let page = 1;
  const limit = 50;
  let hasMore = true;

  try {
    while (hasMore && page < 2) {
      const response = await keycrmApiClient.get("/order", {
        params: {
          limit,
          page: page,
          "filter[shipping_between]": shippingBetween,
          "filter[status_id]": "2,4,6,7,20,10,8,9,21,23,24,25,26,31,30,34,33,32",
          include:
            "assigned,shipping.lastHistory,manager,shipping.deliveryService,customFields,products,productsCount,products.offer,tags,customFieldsExists,status,buyer,attachments,attachments.file",
        },
      });

      const orders = response.data.data;
      allOrders.push(...orders);

      if (orders.length < limit) {
        hasMore = false;
      } else {
        page++;
      }
    }

    return allOrders;
  } catch (error: any) {
    console.error(
      "Getting orders error: ",
      error?.response?.data || error?.message
    );
    throw error;
  }
};

export const extractBranchNames = (order: AdminOrder) => {
  const branchNames = order.tags.filter((tag) =>
    branches.includes(tag.name)
  );

  return branchNames.map((tag) => tag.name).join(", ");
};

export const fetchActiveCrmUsers = async () => {
  const allUsers: any[] = [];
  let page = 1;
  const limit = 50;
  let hasMore = true;

  try {
    while (hasMore) {
      const response = await keycrmApiClient.get("/users", {
        params: {
          limit,
          page,
          "filter[status]": "active",
        },
      });

      const users = response.data.data;
      allUsers.push(...users);

      if (users.length < limit) {
        hasMore = false;
      } else {
        page++;
      }
    }

    return allUsers;
  } catch (error: any) {
    console.error(
      "Getting users error: ",
      error?.response?.data || error?.message
    );
    throw error;
  }
};
