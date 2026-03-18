import fs from "fs/promises";
import path from "path";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { StudioStatus } from "../workload.service.js";
import { STUDIOS, STATUSES, COLOR_MAP, BRANCH_MAP, tz } from "./config.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export type UpdateStudioStatusResult =
  | { success: true }
  | { success: false; error: string };

export async function updateStudioStatus(
  branch: string,
  color: string,
): Promise<UpdateStudioStatusResult> {
  if (!STUDIOS.includes(branch)) {
    return {
      success: false,
      error: `Невідома філія. Можливі варіанти: ${STUDIOS.join(", ")}`,
    };
  }
  if (!STATUSES.includes(color)) {
    return {
      success: false,
      error: `Невідомий статус. Можливі варіанти: ${STATUSES.join(", ")}`,
    };
  }

  const studioId = BRANCH_MAP[branch];
  const statusValue = COLOR_MAP[color];
  const filePath = path.join(process.cwd(), "studios.json");
  const file = await fs.readFile(filePath, "utf-8");
  const studios: StudioStatus[] = JSON.parse(file);

  const updated = studios.map((studio: StudioStatus) => {
    if (studio.id === studioId) {
      return {
        ...studio,
        status: statusValue,
        lastUpdated: dayjs().tz(tz).toISOString(),
      };
    }
    return studio;
  });

  await fs.writeFile(filePath, JSON.stringify(updated, null, 2), "utf-8");
  return { success: true };
}
