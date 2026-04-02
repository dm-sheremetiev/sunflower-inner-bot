import axios from "axios";

import "dotenv/config";

const POSTER_API_URL =
  process.env.POSTER_API_URL || "https://joinposter.com/api";
export const POSTER_API_TOKEN =
  process.env.POSTER_API_TOKEN;

export const posterApiClient = axios.create({
  baseURL: POSTER_API_URL,
  params: { token: POSTER_API_TOKEN },
});
