// apps/api/src/routes/tenants.ts
// Tenant-scoped dashboard & profile endpoints.
// All routes here are protected by auth middleware.

import { FastifyInstance, FastifyRequest } from "fastify";
import { getTenantDashboard } from "../services/tenantService";

export default async function tenantsRoute(fastify: FastifyInstance) {
  const { db } = fastify as any; // From db plugin

  // GET /api/v1/tenants/me — Dashboard overview (protected)
  fastify.get(
    "/me",
    {
      preHandler: [fastify.authenticate], // ← Enforces auth + tenantId
    },
    async (request: FastifyRequest, reply) => {
      const tenantId = (request as any).tenantId;

      try {
        const dashboard = await getTenantDashboard(db, tenantId);
        return dashboard;
      } catch (err) {
        reply.code(500).send({ error: "Failed to load dashboard" });
      }
    },
  );

  // TODO: Add PATCH /me for profile updates, business hours, etc.
  // TODO: POST /login or provisioning callback to issue JWT with tenantId
}
