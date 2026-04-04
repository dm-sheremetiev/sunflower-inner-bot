import fs from "fs";
import path from "path";

import { TelegramUserDatabase } from "../types/telegram.js";

/** Шлях до users.json: абсолютний або від cwd. Без зміни — `users.json` у робочій директорії процесу. */
function getUsersFilePath(): string {
  const raw = process.env.USERS_JSON_PATH?.trim();
  if (raw) {
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  }
  return path.resolve(process.cwd(), "users.json");
}

// Функция для загрузки данных из файла
const loadUsers = () => {
  const filePath = getUsersFilePath();
  if (fs.existsSync(filePath)) {
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data);
  }
  return {};
};

// Функция для сохранения данных в файл
const saveUsers = (users: TelegramUserDatabase) => {
  const filePath = getUsersFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(users, null, 2), "utf-8");
};

export const fileHelper = {
  loadUsers,
  saveUsers,
};
