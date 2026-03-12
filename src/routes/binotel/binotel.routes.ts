import type { FastifyInstance } from "fastify";
import { catchLostCalls } from "../../controllers/binotel.controller.js";

import formbody from "@fastify/formbody";

const binotelRoutes = async (server: FastifyInstance) => {
  const webhookScope = async (subServer: FastifyInstance) => {
    await subServer.register(formbody);

    // Can be expanded by new routes in future
    subServer.post("/webhook", catchLostCalls);
  };

  server.register(webhookScope);
};

export default binotelRoutes;
