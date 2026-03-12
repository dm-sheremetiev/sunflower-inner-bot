import { FastifyReply, FastifyRequest } from "fastify";
import { generalSafetyWrapper } from "../helpers/safety.js";
import { handleCompletedCallAction } from "../services/binotel.services.js";
import { CallCompletedBody } from "../types/binotel.js";
import qs from "qs";

export const catchLostCalls = async (
  request: FastifyRequest<{ Body: CallCompletedBody }>,
  reply: FastifyReply
) => {
  return generalSafetyWrapper(request, reply, async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = qs.parse(request?.body as any) as unknown as CallCompletedBody;

    if (body && body.requestType === "apiCallCompleted" && body.callDetails) {
      const res = await handleCompletedCallAction(body.callDetails);

      return reply.send(res);
    }

    return reply.send({
      status: "success",
    });
  });
};
