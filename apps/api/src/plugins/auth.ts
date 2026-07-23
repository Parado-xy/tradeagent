// apps/api/src/plugins/auth.ts
// Fixed version — proper type merging for Fastify JWT.

import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

// Here we add tenantId to the request across the app.
declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
}

// This tells the compiler that calling fastify.decorate("authenticate", ()=>)
// Permanently adds the .authenticate property to the FastifyInstance across the app.
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const authPlugin = async (fastify: FastifyInstance) => {
  await fastify.register(jwt, {
    secret: process.env.JWT_SECRET || "super-secret-change-in-prod",
    sign: { expiresIn: "7d" },
  });

  fastify.decorateRequest("tenantId", "");

  fastify.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
        const payload = request.user as any;
        request.tenantId = payload?.tenantId || "";

        if (!request.tenantId) {
          throw new Error("Missing tenantId in JWT");
        }
      } catch (err: any) {
        reply.code(401).send({ error: "Unauthorized", message: err.message });
        throw err;
      }
    },
  );
};

export default fp(authPlugin, {
  name: "auth",
});
