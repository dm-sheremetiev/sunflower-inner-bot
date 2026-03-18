import type { Context } from "grammy";
import { Bot, Api, RawApi } from "grammy";
import { updateStudioStatus } from "../../services/telegram/studio.service.js";

export async function handleStudioStatus(ctx: Context): Promise<void> {
  const parts = ctx.message?.text?.trim().toLowerCase().split(" ");

  if (!parts || parts.length < 3) {
    await ctx.reply(
      "Формат повідомлення для зміни статусу: статус <філія> <колір>",
    );
    return;
  }

  const branch = parts[1] ?? "null";
  const color = parts[2] ?? "null";

  const result = await updateStudioStatus(branch, color);

  if (result.success) {
    await ctx.reply(`✅ Статус філії "${branch}" змінено на "${color}"`);
  } else {
    await ctx.reply(result.error);
  }
}

export function registerStudioHandler(
  bot: Bot<Context, Api<RawApi>>,
): void {
  bot.hears(
    /^статус\s+([а-яіїєґa-zA-Z0-9_]+)\s+([а-яіїєґa-zA-Z0-9_]+)$/i,
    async (ctx) => handleStudioStatus(ctx),
  );
}
