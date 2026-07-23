// apps/api/src/routes/auth.ts
import { FastifyInstance, FastifyRequest } from "fastify";
import { registerTenant, RegisterInput } from "../services/authService";

export default async function authRoute(fastify: FastifyInstance) {
  const { db } = fastify as any;

  // POST /api/v1/auth/register
  fastify.post("/register", async (request: FastifyRequest, reply) => {
    const body = request.body as RegisterInput;

    try {
      const tenant = await registerTenant(db, body);

      // Issue JWT
      const token = fastify.jwt.sign({
        tenantId: tenant.id,
        email: tenant.email,
      });

      return {
        success: true,
        tenant: {
          id: tenant.id,
          name: tenant.name,
          email: tenant.email,
        },
        token,
      };
    } catch (err: any) {
      reply.code(400).send({ error: err.message });
    }
  });
}
