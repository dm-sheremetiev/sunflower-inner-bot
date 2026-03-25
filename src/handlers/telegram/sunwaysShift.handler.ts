import type { Context } from "grammy";
import { Bot, Api, RawApi } from "grammy";
import { isCourier } from "../../services/telegram/config.js";
import {
  cancelSunwaysShift,
  finishSunwaysShift,
  getSunwaysVehicles,
  getSunwaysConfigError,
  startSunwaysShift,
} from "../../services/sunways.service.js";

type ShiftFlowType = "start" | "finish";

type ShiftSession = {
  type: ShiftFlowType;
  vehicleId?: string;
  vehicleLabel?: string;
  odometerStart?: number;
  odometerEnd?: number;
  lat?: number;
  lng?: number;
  createdAt: number;
};

const SHIFT_SESSION_TTL_MS = 10 * 60 * 1000;

const SHIFT_PREFIX_START = "shift:start";
const SHIFT_PREFIX_FINISH = "shift:finish";
const SHIFT_PREFIX_VEHICLE = "shift:vehicle:";
const SHIFT_PREFIX_CONFIRM_START = "shift:confirm:start";
const SHIFT_PREFIX_CONFIRM_FINISH = "shift:confirm:finish";
const SHIFT_PREFIX_CANCEL_TODAY = "shift:cancel-today";
const SHIFT_PREFIX_CANCEL = "shift:cancel";

const shiftSessions = new Map<number, ShiftSession>();

function isSessionExpired(session: ShiftSession): boolean {
  return Date.now() - session.createdAt > SHIFT_SESSION_TTL_MS;
}

function formatKyivDateTime(iso?: string): string | null {
  if (!iso) return null;
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return null;
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(dt);
}

function buildStartFinishInlineKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Почати зміну", callback_data: SHIFT_PREFIX_START }],
      [{ text: "Завершити зміну", callback_data: SHIFT_PREFIX_FINISH }],
      [
        {
          text: "Скасувати сьогоднішю зміну",
          callback_data: SHIFT_PREFIX_CANCEL_TODAY,
        },
      ],
    ],
  };
}

function buildVehicleInlineKeyboardFromList(
  vehicles: Array<{ id: string; label: string }>,
) {
  const rows = vehicles.map((v) => [
    { text: v.label, callback_data: `${SHIFT_PREFIX_VEHICLE}${v.id}` },
  ]);
  rows.push([{ text: "Скасувати", callback_data: SHIFT_PREFIX_CANCEL }]);
  return { inline_keyboard: rows };
}

function buildConfirmStartInlineKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "Почати зміну",
          callback_data: SHIFT_PREFIX_CONFIRM_START,
        },
      ],
      [{ text: "Скасувати", callback_data: SHIFT_PREFIX_CANCEL }],
    ],
  };
}

function buildConfirmFinishInlineKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "Завершити зміну",
          callback_data: SHIFT_PREFIX_CONFIRM_FINISH,
        },
      ],
      [{ text: "Скасувати", callback_data: SHIFT_PREFIX_CANCEL }],
    ],
  };
}

function buildRequestLocationKeyboard() {
  return {
    keyboard: [[{ text: "Надіслати геолокацію", request_location: true }]],
    resize_keyboard: true as const,
    one_time_keyboard: true as const,
  };
}

async function rejectIfInvalidUser(ctx: Context): Promise<boolean> {
  if (!ctx.from?.username) {
    await ctx.reply(
      "Наш бот не бачить ваш nickname (ім'я користувача після @). Увімкніть username та спробуйте ще раз.",
    );
    return true;
  }
  if (!isCourier(ctx.from.username)) {
    await ctx.reply("Цей функціонал доступний тільки кур'єрам.");
    return true;
  }
  return false;
}

export function registerSunwaysShiftHandlers(
  bot: Bot<Context, Api<RawApi>>,
): void {
  bot.hears(/^зміна\s+водія$/i, async (ctx) => {
    if (await rejectIfInvalidUser(ctx)) return;

    const configError = getSunwaysConfigError();
    if (configError) {
      await ctx.reply(configError);
      return;
    }

    shiftSessions.set(ctx.from!.id, {
      type: "start",
      createdAt: Date.now(),
    });

    await ctx.reply("Оберіть дію для зміни:", {
      reply_markup: buildStartFinishInlineKeyboard(),
    });
  });

  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from?.id;
    if (!userId) return next();

    if (
      !data.startsWith("shift:") &&
      data !== SHIFT_PREFIX_START &&
      data !== SHIFT_PREFIX_FINISH
    ) {
      return next();
    }

    if (await rejectIfInvalidUser(ctx)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const session = shiftSessions.get(userId);
    if (!session || isSessionExpired(session)) {
      shiftSessions.delete(userId);
      await ctx.answerCallbackQuery({
        text: "Сесію не знайдено або вона застаріла. Почніть заново.",
      });
      return;
    }

    if (data === SHIFT_PREFIX_CANCEL) {
      shiftSessions.delete(userId);
      await ctx.answerCallbackQuery();
      await ctx.reply("Скасовано.", {
        reply_markup: { remove_keyboard: true },
      });
      return;
    }

    if (data === SHIFT_PREFIX_CANCEL_TODAY) {
      await ctx.answerCallbackQuery();
      await ctx.reply("Скасовую сьогоднішю зміну...");
      const result = await cancelSunwaysShift(ctx.from.username!);
      if (!result.ok) {
        await ctx.reply(`Не вдалося скасувати зміну: ${result.message}`);
        return;
      }
      shiftSessions.delete(userId);
      await ctx.reply("Сьогоднішю зміну скасовано.");
      return;
    }

    if (data === SHIFT_PREFIX_START) {
      shiftSessions.set(userId, {
        type: "start",
        createdAt: Date.now(),
      });
      const vehiclesRes = await getSunwaysVehicles();
      if (!vehiclesRes.ok) {
        await ctx.answerCallbackQuery();
        await ctx.reply(`Не вдалося отримати список авто: ${vehiclesRes.message}`);
        return;
      }
      if (vehiclesRes.data.length === 0) {
        await ctx.answerCallbackQuery();
        await ctx.reply("Немає доступних авто для початку зміни.");
        return;
      }
      await ctx.answerCallbackQuery();
      await ctx.reply("Оберіть авто:", {
        reply_markup: buildVehicleInlineKeyboardFromList(vehiclesRes.data),
      });
      return;
    }

    if (data === SHIFT_PREFIX_FINISH) {
      shiftSessions.set(userId, {
        type: "finish",
        createdAt: Date.now(),
      });
      await ctx.answerCallbackQuery();
      await ctx.reply("Вкажіть фінальний пробіг (лише число, км).");
      return;
    }

    if (data.startsWith(SHIFT_PREFIX_VEHICLE)) {
      const vehicleId = data.slice(SHIFT_PREFIX_VEHICLE.length);
      const vehiclesRes = await getSunwaysVehicles();
      if (!vehiclesRes.ok) {
        await ctx.answerCallbackQuery();
        await ctx.reply(`Не вдалося отримати список авто: ${vehiclesRes.message}`);
        return;
      }
      const vehicle = vehiclesRes.data.find((v) => v.id === vehicleId);
      if (!vehicle) {
        await ctx.answerCallbackQuery({ text: "Авто не знайдено." });
        return;
      }

      shiftSessions.set(userId, {
        type: "start",
        vehicleId: vehicle.id,
        vehicleLabel: vehicle.label,
        createdAt: Date.now(),
      });

      await ctx.answerCallbackQuery();
      await ctx.reply(
        `Обрано авто: ${vehicle.label}. Вкажіть стартовий пробіг (лише число, км).`,
      );
      return;
    }

    if (data === SHIFT_PREFIX_CONFIRM_START) {
      const current = shiftSessions.get(userId);
      if (
        !current ||
        current.type !== "start" ||
        !current.vehicleId ||
        current.odometerStart == null ||
        current.lat == null ||
        current.lng == null
      ) {
        await ctx.answerCallbackQuery({ text: "Недостатньо даних для старту." });
        return;
      }

      await ctx.answerCallbackQuery();
      await ctx.reply("Запускаю зміну...");
      const result = await startSunwaysShift({
        telegramUsername: ctx.from.username!,
        vehicleId: current.vehicleId,
        odometerStart: current.odometerStart,
        lat: current.lat,
        lng: current.lng,
      });

      if (!result.ok) {
        await ctx.reply(`Не вдалося запустити зміну: ${result.message}`, {
          reply_markup: { remove_keyboard: true },
        });
        return;
      }

      shiftSessions.delete(userId);
      const formattedEndedAt = formatKyivDateTime(result.endedAt);
      await ctx.reply(
        `Зміну розпочато успішно.${formattedEndedAt ? ` Планове завершення: ${formattedEndedAt}` : ""}`,
        { reply_markup: { remove_keyboard: true } },
      );
      return;
    }

    if (data === SHIFT_PREFIX_CONFIRM_FINISH) {
      await ctx.answerCallbackQuery();
      const current = shiftSessions.get(userId);
      if (!current || current.type !== "finish" || current.odometerEnd == null) {
        await ctx.reply("Недостатньо даних для завершення. Вкажіть фінальний пробіг.");
        return;
      }
      await ctx.reply("Завершую зміну...");
      const result = await finishSunwaysShift(ctx.from.username!, current.odometerEnd);
      if (!result.ok) {
        await ctx.reply(`Не вдалося завершити зміну: ${result.message}`);
        return;
      }
      shiftSessions.delete(userId);
      await ctx.reply("Зміну завершено.");
      return;
    }

    return next();
  });

  bot.on("message:text", async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();

    const session = shiftSessions.get(userId);
    if (!session) return next();
    if (isSessionExpired(session)) {
      shiftSessions.delete(userId);
      await ctx.reply("Сесія застаріла. Почніть заново командою `зміна водія`.", {
        parse_mode: "Markdown",
        reply_markup: { remove_keyboard: true },
      });
      return;
    }

    const text = (ctx.message?.text ?? "").trim();
    if (!text.length) return next();

    const value = Number(text.replace(",", "."));
    const isValidOdometer = Number.isFinite(value) && value >= 0;

    if (session.type === "start" && session.vehicleId && session.odometerStart == null) {
      if (!isValidOdometer) {
        await ctx.reply("Пробіг має бути числом. Вкажіть стартовий пробіг ще раз.");
        return;
      }
      shiftSessions.set(userId, {
        ...session,
        odometerStart: value,
        createdAt: Date.now(),
      });
      await ctx.reply("Надішліть геолокацію для старту зміни.", {
        reply_markup: buildRequestLocationKeyboard(),
      });
      return;
    }

    if (session.type === "finish" && session.odometerEnd == null) {
      if (!isValidOdometer) {
        await ctx.reply("Пробіг має бути числом. Вкажіть фінальний пробіг ще раз.");
        return;
      }
      shiftSessions.set(userId, {
        ...session,
        odometerEnd: value,
        createdAt: Date.now(),
      });
      await ctx.reply("Підтвердьте завершення зміни:", {
        reply_markup: buildConfirmFinishInlineKeyboard(),
      });
      return;
    }

    return next();
  });

  bot.on("message:location", async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();

    const session = shiftSessions.get(userId);
    if (!session || session.type !== "start") return next();
    if (isSessionExpired(session)) {
      shiftSessions.delete(userId);
      await ctx.reply("Сесія застаріла. Почніть заново командою `зміна водія`.", {
        parse_mode: "Markdown",
        reply_markup: { remove_keyboard: true },
      });
      return;
    }

    if (session.odometerStart == null) {
      await ctx.reply("Спочатку вкажіть стартовий пробіг (числом).");
      return;
    }

    const lat = ctx.message?.location?.latitude;
    const lng = ctx.message?.location?.longitude;
    if (lat == null || lng == null) return next();

    shiftSessions.set(userId, {
      ...session,
      lat,
      lng,
      createdAt: Date.now(),
    });

    await ctx.reply(
      `Геолокацію отримано.\nАвто: ${session.vehicleLabel || "—"}\nШирота: ${lat.toFixed(5)}\nДовгота: ${lng.toFixed(5)}\n\nПідтвердіть старт зміни.`,
      {
        reply_markup: buildConfirmStartInlineKeyboard(),
      },
    );
  });
}
