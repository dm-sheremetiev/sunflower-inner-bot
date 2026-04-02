import type { FastifyInstance } from "fastify";
import {
  getEvent,
  sendWithoutPackageMessage,
  sendPackMeMessage,
  sendPackedMessage,
  sendWaitingForDeliveryMessage,
  processNewOrderWebhook,
  sendBareCompositionImageHandler,
  sendPackedCompositionImageHandler,
  validateStatusChangeHandler,
  validateAddressAndRevertHandler,
  checkPaymentsHandler,
} from "../../controllers/webhook.controller.js";

const webhookRoutes = async (server: FastifyInstance) => {
  server.post("/", getEvent);
  server.post("/new", processNewOrderWebhook);
  server.post("/prepared-without-package", sendWithoutPackageMessage);
  server.post("/pack-me", sendPackMeMessage);
  server.post("/packed", sendPackedMessage);
  server.post("/waiting-for-delivery", sendWaitingForDeliveryMessage);
  server.post("/file/bare-comp-message", sendBareCompositionImageHandler);
  server.post("/file/packed-comp-message", sendPackedCompositionImageHandler);
  server.post("/validate-status-change", validateStatusChangeHandler);
  server.post("/validate-address", validateAddressAndRevertHandler);
  server.post("/check-payments", checkPaymentsHandler);
};

export default webhookRoutes;
