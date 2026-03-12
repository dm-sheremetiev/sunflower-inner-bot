import fs from "fs/promises";
import path from "path";
import { Order } from "../types/index.js";
import { keycrmApiClient } from "../api/index.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const STUDIO_TAGS: Record<string, StudioId> = {
  файна: "faina",
  француз: "francuz",
  севен: "seven",
};

type StudioId = "faina" | "francuz" | "seven";

export interface StudioStatus {
  id: StudioId;
  name: string;
  status: "green" | "yellow" | "red";
  lastUpdated: string;
}

interface StatusBreakdown {
  total: number;
  groupA: number;
  groupB: number;
}

interface WorkloadInfo {
  [id: string]: {
    today: StatusBreakdown;
    tomorrow: StatusBreakdown;
    status: "green" | "yellow" | "red";
  };
}

const GROUP_A = [30, 6, 24];
const GROUP_B = [25, 26, 7, 27];

export const getWorkloadInfoHandler = async () => {
  const filePath = path.join(process.cwd(), "studios.json");
  const file = await fs.readFile(filePath, "utf-8");
  const studioStatuses: StudioStatus[] = JSON.parse(file);

  const result: WorkloadInfo = {
    faina: createEmptyBreakdown(),
    francuz: createEmptyBreakdown(),
    seven: createEmptyBreakdown(),
  };

  try {
    const allOrders: Order[] = [];
    let page = 1;
    const limit = 50;
    let hasMore = true;

    const startOfToday = dayjs()
      .tz("Europe/Kyiv")
      .startOf("day")
      .format("YYYY-MM-DD HH:mm:ss");
    const endOfTomorrow = dayjs()
      .tz("Europe/Kyiv")
      .add(1, "day")
      .endOf("day")
      .format("YYYY-MM-DD HH:mm:ss");
    const shippingBetween = `${startOfToday},${endOfTomorrow}`;

    while (hasMore && page < 10) {
      const response = await keycrmApiClient.get("/order", {
        params: {
          limit,
          page,
          "filter[shipping_between]": shippingBetween,
          include:
            "assigned,custom_fields,shipping.deliveryService,buyer,manager,products,tags",
        },
      });

      const orders = response.data.data;
      allOrders.push(...orders);
      hasMore = orders.length >= limit;
      page++;
    }

    const filteredOrders = allOrders.filter(
      (order) => order.status_group_id === 3 && !!order?.tags?.length
    );

    const today = dayjs().tz("Europe/Kyiv").format("YYYY-MM-DD");
    const tomorrow = dayjs()
      .tz("Europe/Kyiv")
      .add(1, "day")
      .format("YYYY-MM-DD");

    for (const order of filteredOrders) {
      const shippingDate = dayjs(order.shipping.shipping_date_actual)
        .tz("Europe/Kyiv")
        .format("YYYY-MM-DD");
      const tagNames = order.tags.map((tag) => tag.name.toLowerCase());

      for (const [alias, id] of Object.entries(STUDIO_TAGS)) {
        if (!tagNames.includes(alias)) continue;

        const target =
          shippingDate === today
            ? result[id].today
            : shippingDate === tomorrow
              ? result[id].tomorrow
              : null;

        if (target) {
          target.total += 1;
          if (GROUP_A.includes(order.status_id)) {
            target.groupA += 1;
          } else if (GROUP_B.includes(order.status_id)) {
            target.groupB += 1;
          }
        }
      }
    }

    for (const studio of studioStatuses) {
      if (!result[studio.id]) continue;
      result[studio.id].status = studio.status;
    }

    return result;
  } catch (error) {
    console.log("Error in workload service", error);
    return result;
  }
};

function createEmptyBreakdown(): {
  today: StatusBreakdown;
  tomorrow: StatusBreakdown;
  status: "green" | "yellow" | "red";
} {
  return {
    today: { total: 0, groupA: 0, groupB: 0 },
    tomorrow: { total: 0, groupA: 0, groupB: 0 },
    status: "green",
  };
}
