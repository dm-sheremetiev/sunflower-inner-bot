export interface TelegramUserData {
  username?: string;
  phone?: string;
  added_at: string;
  crmUserId?: number;
  /** role_id користувача KeyCRM (для фільтрації списку замовлень флористів). */
  crmRoleId?: number;
  /** Кур'єр за роллю KeyCRM «Кур'єр»; кешується з CRM для швидких перевірок. */
  isCourier?: boolean;
  isAuthenticated: boolean;
  lastCheckedAt: number;
}

export type TelegramUserDatabase = Record<string, TelegramUserData>;
