import { google } from "googleapis";
import fs from "fs/promises";
import path from "path";

import "dotenv/config";

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || "";
const CREDENTIALS_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS;
const CREDENTIALS_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  path.join(process.cwd(), "src", "keys", "sunflower-routes-7110b01c7a57.json");

const SHEET_MAIN = "Головна";
const SHEET_COPY_1 = "Копія 1 годину назад";
const SHEET_COPY_2 = "Копія 2 години назад";

async function loadCredentials(): Promise<{
  client_email?: string;
  private_key?: string;
}> {
  try {
    const content = await fs.readFile(CREDENTIALS_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    // fallback to JSON string if file not found
  }

  if (CREDENTIALS_JSON) {
    try {
      return JSON.parse(CREDENTIALS_JSON);
    } catch {
      throw new Error(
        "GOOGLE_SERVICE_ACCOUNT_CREDENTIALS must be valid JSON"
      );
    }
  }

  throw new Error(
    `Credentials file not found at ${CREDENTIALS_PATH}. Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_CREDENTIALS`
  );
}

async function getAuthClient() {
  if (!SPREADSHEET_ID) {
    throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID env is required");
  }

  const credentials = await loadCredentials();
  

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return auth;
}

export async function ensureSheetsExist() {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: "v4", auth });

  const { data } = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
  });

  const sheetTitles = (data.sheets || []).map(
    (s) => s.properties?.title || ""
  );

  const toCreate = [SHEET_MAIN, SHEET_COPY_1, SHEET_COPY_2].filter(
    (t) => !sheetTitles.includes(t)
  );

  if (toCreate.length === 0) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: toCreate.map((title) => ({
        addSheet: {
          properties: { title },
        },
      })),
    },
  });
}

export async function getSheetData(
  sheetTitle: string
): Promise<string[][] | null> {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: "v4", auth });

  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetTitle}'`,
    });
    return (data.values || null) as string[][];
  } catch {
    return null;
  }
}

export async function setSheetData(sheetTitle: string, rows: string[][]) {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetTitle}'`,
  });

  if (rows.length === 0) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetTitle}'!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });
}

const COLUMN_COUNT = 19;
const MIN_COLUMN_WIDTH_PX = 180;

export async function setSheetFormatting(sheetTitle: string) {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: "v4", auth });

  const { data } = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
  });

  const sheet = (data.sheets || []).find(
    (s) => s.properties?.title === sheetTitle
  );
  const sheetId = sheet?.properties?.sheetId;
  if (sheetId == null) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: {
                frozenRowCount: 1,
                frozenColumnCount: 1,
              },
            },
            fields:
              "gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
          },
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId,
              dimension: "COLUMNS",
              startIndex: 0,
              endIndex: COLUMN_COUNT,
            },
            properties: {
              pixelSize: MIN_COLUMN_WIDTH_PX,
            },
            fields: "pixelSize",
          },
        },
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 0,
              endRowIndex: 1,
              startColumnIndex: 0,
              endColumnIndex: COLUMN_COUNT,
            },
            cell: {
              userEnteredFormat: {
                textFormat: {
                  bold: true,
                },
              },
            },
            fields: "userEnteredFormat.textFormat.bold",
          },
        },
      ],
    },
  });
}

export async function syncReserveSheets(
  copy1ToCopy2: string[][],
  mainToCopy1: string[][],
  newMainData: string[][]
) {
  await setSheetData(SHEET_COPY_2, copy1ToCopy2);
  await setSheetData(SHEET_COPY_1, mainToCopy1);
  await setSheetData(SHEET_MAIN, newMainData);

  for (const title of [SHEET_MAIN, SHEET_COPY_1, SHEET_COPY_2]) {
    await setSheetFormatting(title);
  }
}

export const sheetNames = {
  main: SHEET_MAIN,
  copy1: SHEET_COPY_1,
  copy2: SHEET_COPY_2,
};
