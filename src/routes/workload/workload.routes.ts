import type { FastifyInstance } from "fastify";
import { getWorkloadInfo } from "../../controllers/workload.controller.js";

const workloadRoutes = async (server: FastifyInstance) => {
  server.get("/", getWorkloadInfo);
};

export default workloadRoutes;
