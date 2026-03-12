import type { FastifyInstance } from "fastify";
import { printOrderInfo } from "../../controllers/print.controller.js";

const mainRoutes = async (server: FastifyInstance) => {
  server.get("/print/:id", printOrderInfo);
};

export default mainRoutes;
