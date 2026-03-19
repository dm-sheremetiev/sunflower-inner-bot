import type { Context } from "grammy";
import { Bot, Api, RawApi, InputFile } from "grammy";
import { parseFaynatownBranch } from "../../services/faynatown.service.js";
import {
  getFaynatownConfigError,
  getLatestPassesWithQr,
  createVisitorPasses,
  getLatestCarPasses,
  createCarPass,
} from "../../services/faynatown.service.js";

const PASS_DELAY_MS = 700;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function formatPassDate(iso: string): string {
  const d = new Date(iso);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${day}.${month}.${year} ${h}:${m}`;
}

function formatPassCaption(pass: {
  complexName: string;
  visitorName?: string;
  startTime: string;
  endTime: string;
}): string {
  const name = `ЖК ${pass.complexName}`;
  const from = formatPassDate(pass.startTime);
  const to = formatPassDate(pass.endTime);
  return `${name}\n${pass.visitorName ?? ""}\n\nПеріод дії перепустки\n${from}\n${to}`;
}

function parsePassArgs(text: string): { complexId?: number; count: number } {
  const parts = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let complexId: number | undefined;
  let count = 1;
  for (const p of parts) {
    const branch = parseFaynatownBranch(p);
    if (branch !== undefined) complexId = branch;
    const num = /^\d+$/.test(p) ? parseInt(p, 10) : NaN;
    if (!Number.isNaN(num) && num >= 1 && num <= 5) count = num;
  }
  return { complexId, count };
}

export function registerFaynatownHandlers(
  bot: Bot<Context, Api<RawApi>>,
): void {
  bot.hears(/перепустки\s+авто/i, async (ctx) => {
    const text = ctx.message?.text?.trim() ?? "";
    try {
      await ctx.reply("Завантажується...🕒");

      const configError = getFaynatownConfigError();
      if (configError) {
        await ctx.reply(configError);
        return;
      }
      const numbers = text.match(/\d+/g);
      const count = numbers?.length
        ? Math.min(
            30,
            Math.max(1, Math.max(...numbers.map((n) => parseInt(n, 10)))),
          )
        : 10;
      const { complexId } = parsePassArgs(text);
      const list = await getLatestCarPasses(complexId, count);
      if (list.length === 0) {
        await ctx.reply(
          "Авто-перепусток не знайдено для обраного комплексу. Спробуйте вказати файна або республіка.",
        );
        return;
      }
      const lines = list.map(
        (p) =>
          `${p.plateNumber ?? p.hikvisionPassId ?? "—"} — ЖК ${p.complexName} — ${formatPassDate(p.startTime)} … ${formatPassDate(p.endTime)}`,
      );
      await ctx.reply(lines.join("\n"));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Помилка отримання авто-перепусток: ${msg}`);
    }
  });

  bot.hears(/перепустки/i, async (ctx) => {
    const text = ctx.message?.text?.trim() ?? "";
    try {
      await ctx.reply("Завантажується...🕒");

      const configError = getFaynatownConfigError();
      if (configError) {
        await ctx.reply(configError);
        return;
      }
      const numbers = text.match(/\d+/g);
      if (numbers?.some((n) => parseInt(n, 10) > 5)) {
        await ctx.reply(
          "Можна отримати максимум 5 останніх перепусток. Вкажіть число від 1 до 5.",
        );
        return;
      }
      const { complexId, count } = parsePassArgs(text);
      const results = await getLatestPassesWithQr(complexId, count);
      if (results.length === 0) {
        await ctx.reply(
          "Перепусток не знайдено для обраного комплексу. Спробуйте вказати файна або республіка.",
        );
        return;
      }
      for (let i = 0; i < results.length; i++) {
        if (i > 0) await delay(PASS_DELAY_MS);
        const { pass, qrBuffer } = results[i];
        await ctx.replyWithPhoto(new InputFile(qrBuffer, "pass-qr.png"), {
          caption: formatPassCaption(pass),
        });
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Помилка отримання перепусток: ${msg}`);
    }
  });

  bot.hears(/нова\s+перепустка\s+авто/i, async (ctx) => {
    await ctx.reply("Завантажується...🕒");
    const text = ctx.message?.text?.trim() ?? "";
    try {
      const configError = getFaynatownConfigError();
      if (configError) {
        await ctx.reply(configError);
        return;
      }
      const afterAuto = text.replace(/нова\s+перепустка\s+авто\s+/i, "").trim();
      const tokens = afterAuto.split(/\s+/).filter(Boolean);
      const plate = tokens[tokens.length - 1];
      if (!plate || !/^[A-Za-z0-9]{5,12}$/i.test(plate)) {
        await ctx.reply(
          "Вкажіть номер авто (латиницею, наприклад KA7877AM). Приклад: нова перепустка авто республіка KA7877AM",
        );
        return;
      }
      const argsWithoutPlate = tokens.slice(0, -1).join(" ");
      const { complexId } = parsePassArgs(argsWithoutPlate);
      if (complexId === undefined) {
        await ctx.reply(
          "Обовʼязково вкажіть філію: файна або республіка. Наприклад: нова перепустка авто республіка KA7877AM",
        );
        return;
      }
      const ok = await createCarPass(complexId, plate);
      const branchName =
        complexId === 1
          ? "Файна Таун"
          : complexId === 2
            ? "Республіка"
            : `комплекс ${complexId}`;
      if (ok) {
        await ctx.reply(
          `Створено авто-перепустку для ${plate.toUpperCase()}, ЖК ${branchName}. Період 24 год.`,
        );
      } else {
        await ctx.reply(
          `API повернув помилку при створенні авто-перепустки для ${plate}. Спробуйте пізніше.`,
        );
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Помилка створення авто-перепустки: ${msg}`);
    }
  });

  bot.hears(/нова\s+перепустка/i, async (ctx) => {
    const text = ctx.message?.text?.trim() ?? "";
    try {
      await ctx.reply("Завантажується...🕒");

      const configError = getFaynatownConfigError();
      if (configError) {
        await ctx.reply(configError);
        return;
      }
      const numbers = text.match(/\d+/g);
      if (numbers?.some((n) => parseInt(n, 10) > 5)) {
        await ctx.reply(
          "Максимум можна створити 5 перепусток за раз. Вкажіть число від 1 до 5.",
        );
        return;
      }
      const { complexId, count } = parsePassArgs(text);
      if (complexId === undefined) {
        await ctx.reply(
          "Обовʼязково вкажіть філію: файна або республіка. Наприклад: нова перепустка файна",
        );
        return;
      }
      const branchId = complexId;
      await createVisitorPasses(branchId, count);
      await delay(PASS_DELAY_MS);
      const results = await getLatestPassesWithQr(branchId, count);
      if (results.length > 0) {
        for (let i = 0; i < results.length; i++) {
          if (i > 0) await delay(PASS_DELAY_MS);
          const { pass, qrBuffer } = results[i];
          await ctx.replyWithPhoto(new InputFile(qrBuffer, "pass-qr.png"), {
            caption: formatPassCaption(pass),
          });
        }
      }
      const branchName =
        branchId === 1
          ? "Файна Таун"
          : branchId === 2
            ? "Республіка"
            : `комплекс ${branchId}`;
      await ctx.reply(`Створено ${count} перепусток для ${branchName}.`);
    } catch (error: unknown) {
      console.log(error)
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Помилка створення перепусток: ${msg}`);
    }
  });
}
