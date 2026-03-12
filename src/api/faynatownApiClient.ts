import axios, { type InternalAxiosRequestConfig } from "axios";

import "dotenv/config";

const baseURL =
  process.env.FAYNATOWN_API_URL || "https://webapi.faynatown.com.ua";
const phoneNumber = process.env.FAYNATOWN_PHONE_NUMBER || "";
const password = process.env.FAYNATOWN_PASSWORD || "";
const staticToken = process.env.FAYNATOWN_BEARER_TOKEN || "";

let cachedToken: string | null = null;

const defaultHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  Accept: "*/*",
  "Accept-Language": "ru",
  version: "41",
  "User-Agent": "KAN/3.0.33 CFNetwork/3860.400.51 Darwin/25.3.0",
};

/**
 * Запит логіну та отримання токена.
 * Тіло: { PhoneNumber, Password, GenerateToken: true }.
 */
async function fetchToken(): Promise<string> {
  const { data } = await axios.post<unknown>(
    `${baseURL}/api/auth/login`,
    {
      PhoneNumber: phoneNumber,
      Password: password,
      GenerateToken: true,
    },
    { headers: defaultHeaders }
  );

  if (typeof data === "string" && data.length > 0) return data;

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const token =
      obj.Token ?? obj.token ?? obj.access_token ?? obj.accessToken;
    if (typeof token === "string" && token.length > 0) return token;
    const nested = obj.data as Record<string, unknown> | undefined;
    if (nested && typeof nested === "object") {
      const t =
        nested.Token ?? nested.token ?? nested.access_token ?? nested.accessToken;
      if (typeof t === "string" && t.length > 0) return t;
    }
    const result = obj.result as Record<string, unknown> | undefined;
    if (result && typeof result === "object") {
      const t =
        result.Token ?? result.token ?? result.access_token ?? result.accessToken;
      if (typeof t === "string" && t.length > 0) return t;
    }
    const keys = Object.keys(obj).join(", ");
    throw new Error(
      `Faynatown login: у відповіді немає токена. Отримані ключі: ${keys || "(порожній об'єкт)"}. Перевірте формат відповіді API.`
    );
  }

  throw new Error(
    "Faynatown login: відповідь не є об'єктом або рядком з токеном."
  );
}

async function getToken(): Promise<string> {
  if (phoneNumber && password) {
    if (cachedToken) return cachedToken;
    cachedToken = await fetchToken();
    return cachedToken;
  }
  if (staticToken) {
    return staticToken.startsWith("Bearer ") ? staticToken.slice(7) : staticToken;
  }
  throw new Error("Задайте FAYNATOWN_PHONE_NUMBER та FAYNATOWN_PASSWORD або FAYNATOWN_BEARER_TOKEN у .env");
}

function clearToken(): void {
  cachedToken = null;
}

export const faynatownApiClient = axios.create({
  baseURL,
  headers: defaultHeaders,
});

faynatownApiClient.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    const token = await getToken();
    config.headers.Authorization = `Bearer ${token}`;
    return config;
  }
);

faynatownApiClient.interceptors.response.use(undefined, async (error) => {
  if (error.response?.status === 401 && phoneNumber && password) {
    clearToken();
    const token = await fetchToken();
    cachedToken = token;
    if (error.config) {
      error.config.headers.Authorization = `Bearer ${token}`;
      return faynatownApiClient.request(error.config);
    }
  }
  return Promise.reject(error);
});
