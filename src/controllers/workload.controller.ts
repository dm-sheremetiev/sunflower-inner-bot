import { FastifyReply, FastifyRequest } from "fastify";
import { generalSafetyWrapper } from "../helpers/safety.js";
import {
  getWorkloadInfoHandler,
  StudioStatus,
} from "../services/workload.service.js";
import { CallCompletedBody } from "../types/binotel.js";
import cron from "node-cron";
import fs from "fs/promises";
import path from "path";
import dayjs from "dayjs";

import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);
dayjs.extend(timezone);
const tz = "Europe/Kyiv";

export const getWorkloadInfo = async (
  request: FastifyRequest<{ Body: CallCompletedBody }>,
  reply: FastifyReply
) => {
  return generalSafetyWrapper(
    request,
    reply,
    async () => {
      const data = await getWorkloadInfoHandler();

      return reply.send({
        data,
      });
    },
    { handleResponse: true }
  );
};

export const scheduleWorkloadResetCronJobs = () => {
  cron.schedule("0 0 * * *", async () => {
    const filePath = path.join(process.cwd(), "studios.json");
    const file = await fs.readFile(filePath, "utf-8");
    const studios = JSON.parse(file);

    const updated = studios.map((studio: StudioStatus[]) => ({
      ...studio,
      status: "green",
      lastUpdated: dayjs().tz(tz).toISOString(),
    }));

    await fs.writeFile(filePath, JSON.stringify(updated, null, 2), "utf-8");

    console.log("[CRON] Статуси всіх студій скинуті на зелений");
  });
};
