import type { FastifyInstance } from "fastify";
import {
  addVisitorPass,
  passHistory,
  latestPass,
  latestPassQr,
} from "../../controllers/faynatown.controller.js";

const faynatownRoutes = async (server: FastifyInstance) => {
  server.post("/add-visitor", addVisitorPass);
  server.post("/pass-history", passHistory);
  server.get("/latest-pass", latestPass);
  server.get("/latest-pass-qr", latestPassQr);
};

export default faynatownRoutes;
