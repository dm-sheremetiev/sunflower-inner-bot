import fs from "fs";

import { TelegramUserDatabase } from "../types/telegram.js";

const filePath = "users.json";

// Функция для загрузки данных из файла
const loadUsers = () => {
  if (fs.existsSync(filePath)) {
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data);
  }
  return {};
};

// Функция для сохранения данных в файл
const saveUsers = (users: TelegramUserDatabase) => {
  fs.writeFileSync(filePath, JSON.stringify(users, null, 2), "utf-8");
};

export const fileHelper = {
  loadUsers,
  saveUsers,
};
