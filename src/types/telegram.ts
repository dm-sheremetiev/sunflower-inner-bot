export interface TelegramUserData {
  username?: string;
  phone?: string;
  added_at: string;
  crmUserId?: number;
  isAuthenticated: boolean;
  lastCheckedAt: number;
}

export type TelegramUserDatabase = Record<string, TelegramUserData>;
