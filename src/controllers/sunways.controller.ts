import cron from "node-cron";
import { triggerSunwaysAutoCloseShifts } from "../services/sunways.service.js";

export const scheduleSunwaysAutoCloseCronJob = () => {
  cron.schedule(
    "0 2 * * *",
    async () => {
      try {
        const result = await triggerSunwaysAutoCloseShifts();
        console.log(
          `[CRON] Sunways auto-close: date=${result.processedDateKyiv}, autoClosed=${result.autoClosed}, skippedAlreadyClosed=${result.skippedAlreadyClosed}`,
        );
      } catch (error) {
        console.error("[CRON] Sunways auto-close error:", error);
      }
    },
    { timezone: "Europe/Kyiv" },
  );

  console.log("[CRON] Sunways auto-close scheduled at 02:00 Europe/Kyiv");
};
