// apps/api/src/routes/health.ts
//
// A single GET /health endpoint.
// Used by deployment platforms to check if the server is alive.
// No auth, no db — just a fast response.

import { FastifyInstance } from "fastify";

export default async function healthRoute(fastify: FastifyInstance) {
  fastify.get("/health", async () => {
    return {
      status: "ok",
      service: "tradeagent-api",
      ts: new Date().toISOString(),
    };
  });
}
