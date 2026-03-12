import axios from "axios";
import fs from "fs/promises";

import "dotenv/config";
import path from "path";
import { server } from "../server.js";

const apiKey = process?.env.KEYCRM_API_KEY || "";
const apiUrl = process?.env.KEYCRM_API_URL || "";
const KEYCRM_ADMIN_API_URL = process.env.KEYCRM_ADMIN_API_URL;
const KEYCRM_ADMIN_USERNAME = process.env.KEYCRM_ADMIN_USERNAME;
const KEYCRM_ADMIN_PASSWORD = process.env.KEYCRM_ADMIN_PASSWORD;
const TOKEN_PATH = path.join(process.cwd(), "data", "token.txt");

export const keycrmApiClient = axios.create({
  baseURL: apiUrl,
  headers: {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  },
});

const LOGIN_CREDENTIALS = {
  username: KEYCRM_ADMIN_USERNAME,
  password: KEYCRM_ADMIN_PASSWORD,
};

async function getToken() {
  try {
    return await fs.readFile(TOKEN_PATH, "utf8");
  } catch {
    return await refreshToken();
  }
}

async function refreshToken() {
  const { data } = await axios.post(
    `${KEYCRM_ADMIN_API_URL}/auth/login`,
    LOGIN_CREDENTIALS
  );
  const token = data.access_token;

  await fs.writeFile(TOKEN_PATH, token);
  return token;
}

export const keycrmAdminApiClient = axios.create({
  baseURL: KEYCRM_ADMIN_API_URL,
});

keycrmAdminApiClient.interceptors.request.use(async (config) => {
  const token = await getToken();

  config.headers.Authorization = `Bearer ${token}`;
  return config;
});

keycrmAdminApiClient.interceptors.response.use(null, async (error) => {
  if (error.response?.status === 401) {
    const token = await refreshToken();

    error.config.headers.Authorization = `Bearer ${token}`;

    return keycrmAdminApiClient.request(error.config);
  }

  return Promise.reject(error);
});

// Logging

keycrmAdminApiClient.interceptors.request.use((config) => {
  server.log.info({
    msg: `⬆️ [OUT] → ${config.method?.toUpperCase()} ${config.baseURL || ""}${config.url}`,
    request_body: config.data || null, // тело запроса, если есть
  });
  return config;
});

keycrmAdminApiClient.interceptors.response.use(
  (response) => {
    server.log.info({
      msg: `✅ [OUT] ← ${response.status} ${response.config.baseURL || ""}${response.config.url}`,
      // response_body: response.data, // тело ответа
    });
    return response;
  },
  (error) => {
    if (error.response) {
      server.log.error({
        msg: `❌ [OUT] ← ${error.response.status} ${error.config?.baseURL || ""}${error.config?.url}`,
        response_body: error.response.data, // тело ошибки от сервера
        request_body: error.config?.data || null, // тело запроса, которое привело к ошибке
      });
    } else {
      server.log.error({
        msg: `❌ [OUT] → Network error: ${error.message}`,
      });
    }
    return Promise.reject(error);
  }
);
