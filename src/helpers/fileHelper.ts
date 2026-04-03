import fs from "fs";
import path from "path";

import { TelegramUserDatabase } from "../types/telegram.js";

const legacyFilePath = path.resolve(process.cwd(), "users.json");
/** Персистентный каталог — корень ФС контейнера/хоста (не /app). Переопределение: USERS_DB_PATH */
const usersDbPath = process.env.USERS_DB_PATH || "/users.json";

const ensureUsersDbDir = () => {
  const dirPath = path.dirname(usersDbPath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

// Функция для загрузки данных из файла
const loadUsers = () => {
  if (fs.existsSync(usersDbPath)) {
    const data = fs.readFileSync(usersDbPath, "utf-8");
    return JSON.parse(data);
  }
  // Дополнительный fallback для локального запуска вне контейнера.
  const localDataPath = path.resolve(process.cwd(), "data/users.json");
  if (fs.existsSync(localDataPath)) {
    const data = fs.readFileSync(localDataPath, "utf-8");
    return JSON.parse(data);
  }
  // Мягкая миграция для старого расположения в корне проекта.
  if (fs.existsSync(legacyFilePath)) {
    const data = fs.readFileSync(legacyFilePath, "utf-8");
    return JSON.parse(data);
  }
  return {};
};

// Функция для сохранения данных в файл
const saveUsers = (users: TelegramUserDatabase) => {
  ensureUsersDbDir();
  fs.writeFileSync(usersDbPath, JSON.stringify(users, null, 2), "utf-8");
};

export const fileHelper = {
  loadUsers,
  saveUsers,
};
