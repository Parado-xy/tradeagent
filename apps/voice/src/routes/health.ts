// apps/voice/src/routes/health.ts

import { FastifyInstance } from "fastify";

export default async function healthRoute(fastify: FastifyInstance) {
  fastify.get("/health", async () => ({
    status: "ok",
    service: "tradeagent-voice",
    ts: new Date().toISOString(),
  }));
}
