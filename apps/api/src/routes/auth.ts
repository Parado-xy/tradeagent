// apps/api/src/routes/auth.ts
import { FastifyInstance, FastifyRequest } from "fastify";
import { registerTenant, RegisterInput } from "../services/authService";
import bcrypt from "bcryptjs";

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

  // /api/v1/auth/login
  fastify.post("/login", async (request: FastifyRequest, reply) => {
    const { email, password } = request.body as {
      email: string;
      password: string;
    };

    try {
      const tenant = await db.tenant.findUnique({ where: { email } });
      if (!tenant || !(await bcrypt.compare(password, tenant.password))) {
        reply.code(401).send({ error: "Invalid credentials" });
        return;
      }

      const token = fastify.jwt.sign({
        tenantId: tenant.id,
        email: tenant.email,
      });

      return {
        success: true,
        tenant: { id: tenant.id, name: tenant.name, email: tenant.email },
        token,
      };
    } catch (err) {
      reply.code(500).send({ error: "Login failed" });
    }
  });
}
