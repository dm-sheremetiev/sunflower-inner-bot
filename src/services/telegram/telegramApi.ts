import axios from "axios";
import { fileHelper } from "../../helpers/fileHelper.js";
import { sunflowerUsername, managerChanelChatId, botToken } from "./config.js";

export async function sendTelegramMessage(
  chatId: string,
  text: string,
  parseMode?: "Markdown" | "HTML" | "MarkdownV2",
): Promise<unknown> {
  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        chat_id: chatId,
        text: text || "empty",
        ...(parseMode ? { parse_mode: parseMode } : {}),
      },
    );
    return response.data;
  } catch (error) {
    console.error("Telegram send error:", error);
  }
}

export async function sendTelegramMessageToMainAccount(
  text: string,
): Promise<unknown> {
  try {
    const users = fileHelper.loadUsers();
    let chatId = "";
    for (const id in users) {
      if (users[id].username === sunflowerUsername) {
        chatId = id;
        break;
      }
    }
    return await sendTelegramMessage(chatId, text);
  } catch (error) {
    console.log("Error", error);
  }
}

export async function sendTelegramMessageToNotificationsChanel(
  text: string,
): Promise<unknown> {
  try {
    return await sendTelegramMessage(managerChanelChatId, text);
  } catch (error) {
    console.log("Error", error);
  }
}
