import { fileHelper } from "../../helpers/fileHelper.js";
import { fetchActiveCrmUsers } from "../../helpers/keycrmHelper.js";
import { normalizePhone } from "../../helpers/utils.js";
import { TelegramUserData } from "../../types/telegram.js";
import type { Contact } from "grammy/types";

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

export const isUserAuthenticated = (chatId: number): { isAuth: boolean; user?: TelegramUserData } => {
  const users = fileHelper.loadUsers();
  const user = users[chatId];
  return { isAuth: !!user?.isAuthenticated, user };
};

export const processAuthentication = async (
  chatId: number,
  username?: string,
  text?: string,
  contact?: Contact
): Promise<{ success: boolean; message: string }> => {
  const users = fileHelper.loadUsers();

  const phoneRaw = contact?.phone_number ?? text;
  const phoneToSearch = phoneRaw ? normalizePhone(phoneRaw) : null;
  const usernameToSearch = username?.trim() || undefined;
  const textToSearch = text?.trim() || undefined;

  if (!phoneToSearch && !usernameToSearch && !textToSearch) {
    return {
      success: false,
      message: "Доступ не надано. Введіть логін або відправте контакт.",
    };
  }

  try {
    const crmUsers = await fetchActiveCrmUsers();
    
    // Attempt logic matching
    const crmUser = crmUsers.find((u: any) => {
      const crmPhone = u.phone ? normalizePhone(u.phone) : null;
      
      if (crmPhone && phoneToSearch && crmPhone === phoneToSearch) return true;
      if (
        usernameToSearch &&
        u.username &&
        u.username.toLowerCase() === usernameToSearch.toLowerCase()
      )
        return true;
      if (
        textToSearch &&
        u.username &&
        u.username.toLowerCase() === textToSearch.toLowerCase()
      )
        return true;
      return false;
    });

    if (crmUser) {
      users[chatId] = {
        username: username,
        phone: phoneToSearch ?? undefined,
        added_at: new Date().toISOString(),
        crmUserId: crmUser.id,
        isAuthenticated: true,
        lastCheckedAt: Date.now(),
      };
      fileHelper.saveUsers(users);

      return { 
        success: true, 
        message: `Доступ надано! Привіт, ${crmUser.full_name || crmUser.username || "користувач"}.`
      };
    } else {
      return { success: false, message: "Доступ не надано." };
    }
  } catch (error) {
    console.error("Помилка під час спроби аутентифікації", error);
    // Be forgiving if CRM fails
    return { success: false, message: "Сервіс тимчасово недоступний. Спробуйте пізніше або зверніться до адміністратора." };
  }
};

export const verifyUserAccess = async (chatId: number): Promise<{ isValid: boolean }> => {
  const users = fileHelper.loadUsers();
  const user = users[chatId];

  if (!user || !user.isAuthenticated) {
    return { isValid: false };
  }

  const now = Date.now();
  if (now - user.lastCheckedAt > THREE_DAYS_MS) {
    const phoneToSearch = user.phone;
    const usernameToSearch = user.username;

    try {
      const crmUsers = await fetchActiveCrmUsers();
      const stillActive = crmUsers.some((u: any) => {
        const crmPhone = u.phone ? normalizePhone(u.phone) : null;
        if (crmPhone && phoneToSearch && crmPhone === phoneToSearch) return true;
        if (usernameToSearch && u.username && u.username.toLowerCase() === usernameToSearch.toLowerCase()) return true;
        return false;
      });

      if (!stillActive) {
        user.isAuthenticated = false;
        fileHelper.saveUsers(users);
        return { isValid: false };
      }

      user.lastCheckedAt = now;
      fileHelper.saveUsers(users);
    } catch (error) {
      // API call failed, fail open so user isn't blocked by downtime
      console.error("CRM unavailable while re-verifying", error);
    }
  }

  return { isValid: true };
};
