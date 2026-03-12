// biotime-cron.ts
import axios from "axios";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import cron from "node-cron";
import { Bot, Context, Api, RawApi } from "grammy";
import "dotenv/config";

dayjs.extend(utc);
dayjs.extend(timezone);
const tz = "Europe/Kyiv";

const BIOTIME_USERNAME = process.env.BIOTIME_USERNAME || "";
const BIOTIME_PASSWORD = process.env.BIOTIME_PASSWORD || "";
const BIOTIME_API_URL = process.env.BIOTIME_API_URL || "";

const CHAT_IDS: Record<string, string | undefined> = {
  файна: process.env.SUNFLOWER_FAYNA_NOTIFICATIONS_CHAT_ID,
  француз: process.env.SUNFLOWER_FRENCH_NOTIFICATIONS_CHAT_ID,
  офіс: process.env.SUNFLOWER_OFFICE_NOTIFICATIONS_CHAT_ID,
  севен: process.env.SUNFLOWER_SEVEN_NOTIFICATIONS_CHAT_ID,
};

interface TransactionsResponse {
  count: number;
  next: null;
  previous: null;
  msg: string;
  code: number;
  data: Transaction[];
}

interface Transaction {
  id: number;
  emp: number;
  emp_code: string;
  first_name: string;
  last_name: string;
  department: string;
  position: null;
  punch_time: string;
  punch_state: string;
  punch_state_display: string;
  verify_type: number;
  verify_type_display: string;
  work_code: string;
  gps_location: null;
  area_alias: string;
  terminal_sn: string;
  temperature: string;
  is_mask: string;
  terminal_alias: "string";
  upload_time: string;
}

interface GroupedEntry {
  name: string;
  morningTime: dayjs.Dayjs;
  morningTimeStr: string;
  eveningTime: dayjs.Dayjs;
  eveningTimeStr: string;
}

async function getBiotimeToken(): Promise<string> {
  const res = await axios.post(`${BIOTIME_API_URL}/api-token-auth/`, {
    username: BIOTIME_USERNAME,
    password: BIOTIME_PASSWORD,
  });
  return res.data.token;
}

async function fetchTransactions(
  token: string,
  startTime: string,
  endTime: string
): Promise<Transaction[]> {
  const url = `${BIOTIME_API_URL}/iclock/api/transactions/?start_time=${startTime}&end_time=${endTime}&page_size=300`;
  const res = await axios.get<TransactionsResponse>(url, {
    headers: { Authorization: `Token ${token}` },
  });

  return res.data.data;
}

function classifyAndFormat(
  transactions: Transaction[],
  session: "morning" | "evening",
  bot: Bot<Context, Api<RawApi>>,
  branchesFilter?: string[]
) {
  try {
    const isMorning = session === "morning";
    const isEvening = session === "evening";
    const grouped: Record<string, GroupedEntry[]> = {
      файна: [],
      француз: [],
      севен: [],
      офіс: [],
    };

    const alerts: Record<string, GroupedEntry[]> = {
      файна: [],
      француз: [],
      севен: [],
      офіс: [],
    };

    const perPersonPerBranch: Record<
      string,
      Record<string, Transaction[]>
    > = {};

    for (const t of transactions) {
      if (t.verify_type_display !== "Відбиток пальця" || t.verify_type !== 1)
        continue;

      const name = `${t.first_name} ${t.last_name}`;
      const branch = t.terminal_alias.toLowerCase().includes("франц")
        ? "француз"
        : t.terminal_alias.toLowerCase().includes("файна")
          ? "файна"
          : t.terminal_alias.toLowerCase().includes("офіс")
            ? "офіс"
            : t.terminal_alias.toLowerCase().includes("севен")
              ? "севен"
              : null;

      if (!branch || (branchesFilter && !branchesFilter.includes(branch))) {
        continue;
      }

      if (!perPersonPerBranch[branch]) perPersonPerBranch[branch] = {};
      if (!perPersonPerBranch[branch][name])
        perPersonPerBranch[branch][name] = [];

      perPersonPerBranch[branch][name].push(t);
    }

    for (const branch of Object.keys(perPersonPerBranch)) {
      const people = perPersonPerBranch[branch];

      for (const name of Object.keys(people)) {
        const records = people[name];
        // const selectedTransaction = records
        //   .map((t) => ({
        //     ...t,
        //     parsedTime: dayjs.tz(t.punch_time, tz),
        //   }))
        //   .sort((a, b) =>
        //     session === "morning"
        //       ? a.parsedTime.valueOf() - b.parsedTime.valueOf()
        //       : b.parsedTime.valueOf() - a.parsedTime.valueOf()
        //   )[0];

        const selectedTransaction = records
          .map((t) => ({
            ...t,
            parsedTime: dayjs.tz(t.punch_time, tz),
          }))
          .sort((a, b) => a.parsedTime.valueOf() - b.parsedTime.valueOf());
        const [firstTransaction, lastTransaction] = [
          selectedTransaction[0],
          selectedTransaction[selectedTransaction?.length - 1],
        ];

        const morningPunchTime = firstTransaction.parsedTime;
        const morningTimeStr = morningPunchTime.format("HH:mm");
        const morningH = morningPunchTime.hour();
        const morningM = morningPunchTime.minute();

        const eveningPunchTime = lastTransaction.parsedTime;
        const eveningTimeStr = eveningPunchTime.format("HH:mm");
        const eveningH = eveningPunchTime.hour();
        const eveningM = eveningPunchTime.minute();
        const eveningHm = eveningPunchTime.format("HH:mm");

        grouped[branch].push({
          name,
          morningTime: morningPunchTime,
          morningTimeStr: morningTimeStr,
          eveningTime: eveningPunchTime,
          eveningTimeStr: eveningTimeStr,
        });

        const isDiff = eveningPunchTime.diff(morningPunchTime) !== 0;

        if (isDiff) {
          if (isMorning) {
            if (branch === "офіс") {
              if (
                (morningH === 13 && morningM >= 30 && morningM <= 33) ||
                morningH > 13
              ) {
                alerts[branch].push({
                  name,
                  morningTime: morningPunchTime,
                  morningTimeStr: morningTimeStr,
                  eveningTime: eveningPunchTime,
                  eveningTimeStr: eveningTimeStr,
                });
              }
            } else {
              if (
                (morningH === 8 && morningM >= 3 && morningM <= 40) ||
                (morningH === 9 && morningM >= 3) ||
                morningH >= 10
              ) {
                alerts[branch].push({
                  name,
                  morningTime: morningPunchTime,
                  morningTimeStr: morningTimeStr,
                  eveningTime: eveningPunchTime,
                  eveningTimeStr: eveningTimeStr,
                });
              }
            }
          } else {
            if (branch === "офіс") {
              const earlyOfficeExitTimes = [
                "15:50",
                "15:51",
                "15:52",
                "15:53",
                "15:54",
                "15:55",
                "21:20",
                "21:21",
                "21:22",
                "21:23",
                "21:24",
                "21:25",
              ];
              if (earlyOfficeExitTimes.includes(eveningHm)) {
                alerts[branch].push({
                  name,
                  morningTime: morningPunchTime,
                  morningTimeStr: morningTimeStr,
                  eveningTime: eveningPunchTime,
                  eveningTimeStr: eveningTimeStr,
                });
              }
            } else {
              if (
                eveningH < 19 ||
                (eveningH === 19 && eveningM <= 55) ||
                (eveningH === 20 && eveningM <= 55)
              ) {
                alerts[branch].push({
                  name,
                  morningTime: morningPunchTime,
                  morningTimeStr: morningTimeStr,
                  eveningTime: eveningPunchTime,
                  eveningTimeStr: eveningTimeStr,
                });
              } else if (
                [
                  "19:50",
                  "19:51",
                  "19:52",
                  "19:53",
                  "19:54",
                  "19:55",
                  "20:50",
                  "20:51",
                  "20:52",
                  "20:53",
                  "20:54",
                  "20:55",
                ].includes(eveningHm)
              ) {
                alerts[branch].push({
                  name,
                  morningTime: morningPunchTime,
                  morningTimeStr: morningTimeStr,
                  eveningTime: eveningPunchTime,
                  eveningTimeStr: eveningTimeStr,
                });
              }
            }
          }
        }
      }
    }

    for (const branch of Object.keys(grouped)) {
      if (branchesFilter && !branchesFilter.includes(branch)) {
        continue;
      }

      const entries = grouped[branch];
      if (!entries.length) {
        continue;
      }

      // entries.sort((a, b) => a.time.valueOf() - b.time.valueOf());

      let message = "";

      if (isMorning) {
        message = `*Відвідування філії ${dayjs().tz(tz).format("DD.MM.YYYY")}*\n\n`;

        for (const { name, morningTimeStr } of entries) {
          message += `_${name}_ - ${morningTimeStr}\n`;
        }
      }

      if (isEvening) {
        message = `*Вихід з філії ${dayjs().tz(tz).format("DD.MM.YYYY")}*\n\n`;

        for (const {
          name,
          eveningTimeStr,
          eveningTime,
          morningTime,
        } of entries) {
          const diff = eveningTime.diff(morningTime, "minutes");
          const hours = Math.floor(diff / 60);
          const minutes = diff % 60;
          const formattedMinutes = minutes.toString().padStart(2, "0");
          const diffStr = `${hours}:${formattedMinutes}`;

          message += `_${name}_ - ${eveningTimeStr}. Відпрацьовано - ${diff > 0 ? `_${diffStr}_` : `*?*`}\n`;
        }
      }

      // if (alerts[branch].length > 0) {
      //   message += isMorning
      //     ? `\n*УВАГА - Можливе запізнення*\n`
      //     : `\n*УВАГА - Можливий ранній вихід*\n`;

      //   for (const {
      //     name,
      //     eveningTimeStr,
      //     morningTimeStr,
      //     eveningTime,
      //     morningTime,
      //   } of alerts[branch]) {
      //     const diff = eveningTime.diff(morningTime, "minutes");

      //     if (diff !== 0) {
      //       message += `_${name}_ - ${isMorning ? morningTimeStr : eveningTimeStr}\n`;
      //     }
      //   }
      // }

      const chatId = CHAT_IDS[branch];
      if (chatId) {
        bot.api.sendMessage(chatId, message, { parse_mode: "Markdown" });
      }
    }
  } catch (error) {
    console.log(error);
  }
}

export async function processSession(
  session: "morning" | "evening",
  bot: Bot<Context, Api<RawApi>>,
  branchesFilter?: string[]
): Promise<void> {
  try {
    const token = await getBiotimeToken();
    const today = dayjs().tz(tz);
    // const start =
    //   session === "morning"
    //     ? now.hour(6).minute(0).second(0)
    //     : now.hour(16).minute(0).second(0);
    // const end =
    //   session === "morning"
    //     ? now.hour(12).minute(0).second(0)
    //     : now.hour(23).minute(59).second(0);

    const start = today.hour(0);
    const end = today.hour(24);

    const startStr = encodeURIComponent(start.format("YYYY-MM-DD HH:mm:ss"));
    const endStr = encodeURIComponent(end.format("YYYY-MM-DD HH:mm:ss"));

    const data = await fetchTransactions(token, startStr, endStr);
    classifyAndFormat(data, session, bot, branchesFilter);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    console.error("Error in BioTime worker:", e?.message || "unknown");
  }
}

export function scheduleBiotimeCronJobs(bot: Bot<Context, Api<RawApi>>) {
  cron.schedule(
    "0 12 * * *",
    () => processSession("morning", bot, ["файна", "француз", "севен"]),
    {
      timezone: tz,
    }
  );

  cron.schedule("0 14 * * *", () => processSession("morning", bot, ["офіс"]), {
    timezone: tz,
  });

  cron.schedule("0 23 * * *", () => processSession("evening", bot), {
    timezone: tz,
  });

  console.log("BioTime cron jobs scheduled.");
}
