import type { FastifyInstance } from "fastify";
import { syncReserve } from "../../controllers/reserve.controller.js";

const reserveRoutes = async (server: FastifyInstance) => {
  server.get("/sync", syncReserve);
};

export default reserveRoutes;
