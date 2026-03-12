import type { FastifyReply, FastifyRequest } from "fastify";
import {
  addVisitorPass as addVisitorPassService,
  getPassHistory,
  getLatestPass,
  getLatestPassWithQr,
  parseFaynatownBranch,
} from "../services/faynatown.service.js";
import type { AddVisitorPassBody, PassHistoryQueryBody } from "../types/faynatown.js";

/**
 * POST /faynatown/add-visitor — додати посетителя.
 * Якщо visitor_name не передано — використовується "Відвідувач" + випадкове 3-значне число.
 */
export const addVisitorPass = async (
  request: FastifyRequest<{ Body: AddVisitorPassBody }>,
  reply: FastifyReply
) => {
  try {
    const body = { ...request.body };
    if (!body.visitor_name?.trim()) {
      body.visitor_name = `Відвідувач ${100 + Math.floor(Math.random() * 900)}`;
    }
    const data = await addVisitorPassService(body);
    return reply.status(200).send(data);
  } catch (error: unknown) {
    request.log.error({ error });
    return reply.status(500).send({ error: "Faynatown addVisitorPass failed" });
  }
};

/**
 * POST /faynatown/pass-history — історія проходок (query).
 */
export const passHistory = async (
  request: FastifyRequest<{ Body: PassHistoryQueryBody }>,
  reply: FastifyReply
) => {
  try {
    const body = request.body;
    const list = await getPassHistory(body);
    return reply.status(200).send(list);
  } catch (error: unknown) {
    request.log.error({ error });
    return reply.status(500).send({ error: "Faynatown passHistory failed" });
  }
};

/**
 * GET /faynatown/latest-pass — остання проходка. Query: ?branch=файна|республіка (опційно).
 */
export const latestPass = async (
  request: FastifyRequest<{ Querystring: { branch?: string } }>,
  reply: FastifyReply
) => {
  try {
    const branch = request.query?.branch;
    const complexId = branch ? parseFaynatownBranch(branch) : undefined;
    const pass = await getLatestPass(complexId);
    if (!pass) return reply.status(404).send({ error: "No pass found" });
    return reply.status(200).send(pass);
  } catch (error: unknown) {
    request.log.error({ error });
    return reply.status(500).send({ error: "Faynatown getLatestPass failed" });
  }
};

/**
 * GET /faynatown/latest-pass-qr — остання проходка + QR (PNG). Query: ?branch=файна|республіка (опційно).
 */
export const latestPassQr = async (
  request: FastifyRequest<{ Querystring: { branch?: string } }>,
  reply: FastifyReply
) => {
  try {
    const branch = request.query?.branch;
    const complexId = branch ? parseFaynatownBranch(branch) : undefined;
    const result = await getLatestPassWithQr(complexId);
    if (!result) {
      return reply.status(404).send({ error: "No pass found" });
    }
    return reply
      .status(200)
      .header("Content-Type", "image/png")
      .send(result.qrBuffer);
  } catch (error: unknown) {
    request.log.error({ error });
    return reply.status(500).send({ error: "Faynatown getLatestPassWithQr failed" });
  }
};
