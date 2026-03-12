import type { FastifyInstance } from "fastify";
import webhookRoutes from "./webhook/webhook.routes.js";
import mainRoutes from "./main/main.routes.js";
import binotelRoutes from "./binotel/binotel.routes.js";
import workloadRoutes from "./workload/workload.routes.js";
import reserveRoutes from "./reserve/reserve.routes.js";
import faynatownRoutes from "./faynatown/faynatown.routes.js";

const routes = async (server: FastifyInstance) => {
  server.register(mainRoutes, { prefix: "/" });
  server.register(webhookRoutes, { prefix: "/webhook" });
  server.register(binotelRoutes, { prefix: "/binotel" });
  server.register(workloadRoutes, { prefix: "/workload" });
  server.register(reserveRoutes, { prefix: "/reserve" });
  server.register(faynatownRoutes, { prefix: "/faynatown" });
};

export default routes;
