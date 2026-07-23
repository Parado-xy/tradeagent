// apps/api/src/routes/provisioning.ts
import { FastifyInstance, FastifyRequest } from "fastify";
import { activateProvisioning } from "../services/provisioningService";

export default async function provisioningRoute(fastify: FastifyInstance) {
  const { db } = fastify as any;

  // POST /api/v1/provisioning/activate  (protected)
  fastify.post(
    "/activate",
    {
      preHandler: [fastify.authenticate],
    },
    async (request: FastifyRequest, reply) => {
      const tenantId = (request as any).tenantId;
      const body = request.body as { areaCode?: string };

      try {
        const result = await activateProvisioning(db, {
          tenantId,
          areaCode: body.areaCode,
        });
        return { success: true, tenant: result.tenant };
      } catch (err: any) {
        reply.code(400).send({ error: err.message });
      }
    },
  );
}
