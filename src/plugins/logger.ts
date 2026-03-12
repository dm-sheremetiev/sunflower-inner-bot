import fp from "fastify-plugin";

const logger = fp(async (server) => {
  server.addHook("onRequest", async (request) => {
    console.log(`Incoming request: ${request.method} ${request.url}`);
  });
});

export default logger;
