import { FastifyReply, FastifyRequest } from "fastify";

export const generalSafetyWrapper = async (
  request: FastifyRequest,
  reply: FastifyReply,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callback: (...args: any) => Promise<any>,
  options?: { handleResponse?: boolean }
) => {
  try {
    const result = await callback();

    if (options?.handleResponse) {
        return reply.status(200).send(result);
    }

    return result;
  } catch (error) {
    request.log.error({ error });

    return reply.status(501).send({ message: "Internal Server Error", error });
  }
};
