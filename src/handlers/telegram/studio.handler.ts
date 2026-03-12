import fs from "fs/promises";
import path from "path";
import dayjs from "dayjs";
import type { Context } from "grammy";
import { Bot, Api, RawApi } from "grammy";
import { StudioStatus } from "../../services/workload.service.js";
import { STUDIOS, STATUSES, COLOR_MAP, BRANCH_MAP, tz } from "./config.js";

import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export async function handleStudioStatus(ctx: Context): Promise<void> {
  const parts = ctx.message?.text?.trim().toLowerCase().split(" ");

  if (!parts) {
    await ctx.reply(
      "Формат повідомлення для зміни статусу: статус <філія> <колір>",
    );
    return;
  }

  const branch = parts[1] || "null";
  const color = parts[2] || "null";

  if (!STUDIOS.includes(branch)) {
    await ctx.reply(
      `Невідома філія. Можливі варіанти: ${STUDIOS.join(", ")}`,
    );
    return;
  }

  if (!STATUSES.includes(color)) {
    await ctx.reply(
      `Невідомий статус. Можливі варіанти: ${STATUSES.join(", ")}`,
    );
    return;
  }

  const studioId = BRANCH_MAP[branch];
  const statusValue = COLOR_MAP[color];

  const filePath = path.join(process.cwd(), "studios.json");
  const file = await fs.readFile(filePath, "utf-8");
  const studios = JSON.parse(file);

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
  await ctx.reply(`✅ Статус філії "${branch}" змінено на "${color}"`);
}

export function registerStudioHandler(
  bot: Bot<Context, Api<RawApi>>,
): void {
  bot.hears(
    /^статус\s+([а-яіїєґa-zA-Z0-9_]+)\s+([а-яіїєґa-zA-Z0-9_]+)$/i,
    async (ctx) => handleStudioStatus(ctx),
  );
}
