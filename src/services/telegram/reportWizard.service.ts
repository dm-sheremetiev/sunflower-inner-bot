import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { tz } from "./config.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export type ReportType = "x" | "z";

export interface ReportSession {
  reportType: ReportType;
  stepIndex: number;
  data: Record<string, string>;
  photoFileIds: string[];
  messageIdsToDelete: number[];
  botMessageIdsToDelete: number[];
  username: string;
  chatId: string;
  createdAt: number;
}

export type ReportStepInput = "text" | "photo" | "choice";

export interface ReportStepConfig {
  id: string;
  question: string;
  input: ReportStepInput;
  choices?: [string, string][];
  dataKey?: string;
  default?: string;
}

const REPORT_SALONS: [string, string][] = [
  ["Файна", "Файна"],
  ["Француз", "Француз"],
  ["Севен", "Севен"],
  ["Республіка", "Республіка"],
];

const X_REPORT_STEPS: ReportStepConfig[] = [
  { id: "x_date", question: "📆 Дата (наприклад 03.03.2026)", input: "text", dataKey: "date" },
  { id: "x_admin", question: "👤 Адміністратор (ваш нік або ПІБ)", input: "text", dataKey: "administrator" },
  { id: "x_salon", question: "🏪 Салон", input: "choice", choices: REPORT_SALONS, dataKey: "salon" },
  { id: "x_cash", question: "💵 Готівка в касі", input: "text", dataKey: "cash" },
  { id: "x_photo", question: "📷 Надішліть фото звіту (одне або альбом)", input: "photo" },
];

const Z_REPORT_STEPS: ReportStepConfig[] = [
  { id: "z_date", question: "📆 Дата (наприклад 03.03.2026)", input: "text", dataKey: "date" },
  { id: "z_salon", question: "🏪 Салон", input: "choice", choices: REPORT_SALONS, dataKey: "salon" },
  { id: "z_cash_day", question: "🖥 Каса за день", input: "text", dataKey: "cash_day" },
  { id: "z_delivery", question: "🚙 Доставка", input: "text", dataKey: "delivery" },
  { id: "z_pass_through", question: "🚶🏻‍♂️‍➡️ Прохідні", input: "text", dataKey: "pass_through" },
  { id: "z_write_off", question: "✅ Списання внесено", input: "choice", choices: [["Так", "Так"], ["Ні", "Ні"]], dataKey: "write_off_done" },
  { id: "z_cash", question: "💵 Готівка в касі", input: "text", dataKey: "cash" },
  { id: "z_comment", question: "💬 Коментар (або напишіть —)", input: "text", dataKey: "comment" },
  { id: "z_admin", question: "👤 Адміністратор (ваш нік або ПІБ)", input: "text", dataKey: "administrator" },
  { id: "z_photo", question: "📷 Надішліть фото звіту (одне або альбом)", input: "photo" },
];

export const reportSessions = new Map<string, ReportSession>();
export const pendingReportStartMessageIds = new Map<string, number>();
export const pendingReportStartBotMessageIds = new Map<string, number>();

export function getReportSteps(type: ReportType): ReportStepConfig[] {
  return type === "x" ? X_REPORT_STEPS : Z_REPORT_STEPS;
}

export function cleanupExpiredReportSessions(): void {
  const nowKyiv = dayjs().tz(tz);
  for (const [chatId, session] of reportSessions.entries()) {
    const createdKyiv = dayjs(session.createdAt).tz(tz);
    if (nowKyiv.diff(createdKyiv, "hour") >= 48) {
      reportSessions.delete(chatId);
    }
  }
}

export function buildReportSummaryText(session: ReportSession): string {
  const { reportType, data } = session;
  if (reportType === "x") {
    return (
      `🧾 Тип звіту: X-звіт\n` +
      `📆 Дата: ${data.date ?? "—"}\n` +
      `👤 Адміністратор: ${data.administrator ?? "—"}\n` +
      `🏪 Салон: ${data.salon ?? "—"}\n` +
      `💵 Готівка в касі: ${data.cash ?? "—"}`
    );
  }
  return (
    `Z\n\n` +
    `📆 Дата: ${data.date ?? "—"}\n\n` +
    `🏪 Салон: ${data.salon ?? "—"}\n\n` +
    `🖥 Каса за день: ${data.cash_day ?? "—"}\n\n` +
    `🚙 Доставка: ${data.delivery ?? "—"}\n\n` +
    `🚶🏻‍♂️‍➡️ Прохідні: ${data.pass_through ?? "—"}\n\n` +
    `✅ Списання внесено: ${data.write_off_done ?? "—"}\n\n` +
    `💵 Готівка в касі: ${data.cash ?? "—"}\n\n` +
    `Коментар: ${data.comment ?? "—"}\n\n` +
    `👤 Адміністратор: ${data.administrator ?? "—"}`
  );
}

export function getCurrentStep(session: ReportSession): ReportStepConfig | null {
  const steps = getReportSteps(session.reportType);
  return steps[session.stepIndex] ?? null;
}

export function createReportSession(
  chatId: string,
  username: string,
  reportType: ReportType,
  initialPhotoFileIds: string[] = [],
  initialMessageIds: number[] = [],
  initialBotMessageIds: number[] = [],
): ReportSession {
  const session: ReportSession = {
    reportType,
    stepIndex: 0,
    data: { administrator: username },
    photoFileIds: [...initialPhotoFileIds],
    messageIdsToDelete: [...initialMessageIds],
    botMessageIdsToDelete: [...initialBotMessageIds],
    username,
    chatId,
    createdAt: Date.now(),
  };
  reportSessions.set(chatId, session);
  return session;
}

export function applyTextStep(session: ReportSession, text: string): void {
  const step = getCurrentStep(session);
  if (step?.input === "text" && step.dataKey) {
    session.data[step.dataKey] = text;
    session.stepIndex += 1;
  }
}

export function applyChoiceStep(
  session: ReportSession,
  stepId: string,
  choiceIndex: number,
): boolean {
  const steps = getReportSteps(session.reportType);
  const step = steps.find((s) => s.id === stepId);
  if (!step?.choices?.[choiceIndex] || !step.dataKey) return false;
  session.data[step.dataKey] = step.choices[choiceIndex][1];
  session.stepIndex += 1;
  return true;
}

export function goToNextStep(session: ReportSession): void {
  session.stepIndex += 1;
}
