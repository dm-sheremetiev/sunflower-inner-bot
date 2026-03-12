import { FastifyReply, FastifyRequest } from "fastify";
import cron from "node-cron";
import { generalSafetyWrapper } from "../helpers/safety.js";
import { syncReserveToSheets } from "../services/reserveOrders.service.js";

const RESERVE_CRON_ENABLED = true; // зміни на false щоб вимкнути

export const scheduleReserveCronJobs = () => {
  if (!RESERVE_CRON_ENABLED) {
    console.log("[CRON] Reserve sync cron disabled");
    return;
  }

  cron.schedule("0 8-22/2 * * *", async () => {
    try {
      const result = await syncReserveToSheets();
      console.log(
        `[CRON] Reserve sync: ${result.ordersCount} orders${result.error ? `, error: ${result.error}` : ""}`
      );
    } catch (err) {
      console.error("[CRON] Reserve sync error:", err);
    }
  });

  console.log("[CRON] Reserve sync scheduled (8:00–22:00 every 2 hours)");
};

export const syncReserve = async (
  _request: FastifyRequest,
  reply: FastifyReply
) => {
  return generalSafetyWrapper(
    _request,
    reply,
    async () => {
      const result = await syncReserveToSheets();

      if (result.error) {
        return reply.status(500).send({
          success: false,
          error: result.error,
          ordersCount: result.ordersCount,
        });
      }

      return reply.send({
        success: true,
        ordersCount: result.ordersCount,
      });
    },
    { handleResponse: false }
  );
};
