import Fastify from "fastify";

import "dotenv/config";

import routes from "./routes/index.js";
import { initializeBot } from "./services/telegram.service.js";
import { scheduleBiotimeCronJobs } from "./controllers/biotime.controller.js";
import cors from "@fastify/cors";
import { scheduleWorkloadResetCronJobs } from "./controllers/workload.controller.js";
import { scheduleReserveCronJobs } from "./controllers/reserve.controller.js";

export const server = Fastify({
  logger: {
    transport: {
      target: "pino-pretty",
      options: {
        translateTime: "HH:MM:ss Z",
        colorize: true,
      },
    },
  },
});

server.register(cors, {
  origin: "*",
});

// await fastify.register(cors, {
//   origin: ["http://localhost:3000", "http://192.168.50.89:3000"],
// });

server.register(routes);

const start = async () => {
  try {
    const port = +(process?.env?.PORT || 4000);
    const host = "0.0.0.0";

    await server.listen({ port, host });
  } catch (err) {
    server.log.error({ err }, "Server error");

    // Wait for 15 seconds before restart
    setTimeout(start, 15000);
  }
};

start();

const bot = initializeBot();

bot.start();

scheduleBiotimeCronJobs(bot);
scheduleWorkloadResetCronJobs();
scheduleReserveCronJobs(); // закоментуй цей рядок щоб вимкнути крону резерву
