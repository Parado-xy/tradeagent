// apps/api/src/routes/provisioning.ts
//
// POST /api/v1/tenants/provision
//
// HTTP layer only, matching contactsRoute conventions — validation
// here, orchestration in provisioningService.

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { provisionTenant } from "../services/provisioningService";

const provisionSchema = z.object({
  name: z.string().min(1),
  phoneNumber: z.string().min(10),
  dispatcherPhone: z.string().min(10),
  areaCode: z.string().length(3).optional(),
  plan: z.enum(["ALPHA", "STARTER", "GROWTH", "ENTERPRISE"]).optional(),
});

export default async function provisioningRoute(fastify: FastifyInstance) {
  fastify.post("/tenants/provision", async (request, reply) => {
    const parsed = provisionSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    try {
      const result = await provisionTenant(fastify.db, parsed.data);
      return reply.status(201).send(result.tenant);
    } catch (err: any) {
      request.log.error(err, "Tenant provisioning failed");
      return reply.status(502).send({ error: err.message });
    }
  });
}
