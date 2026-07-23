// apps/api/src/plugins/auth.ts
// Fastify plugin for JWT-based tenant-scoped authentication.
// Every protected route will have req.tenantId available.
// This enforces the "strict multi-tenancy" principle from the North Star doc.

import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;   // Populated after verification
    user?: any;         // Extend later for roles
  }
}

async function authPlugin(fastify: FastifyInstance) {
  // Register JWT plugin
  await fastify.register(jwt, {
    //TODO: Set a JWT secret in .env
    secret: process.env.JWT_SECRET || 'super-secret-change-in-prod', // Use strong secret in .env
    sign: { expiresIn: '7d' }, // Adjust as needed
  });

  // Decorator to protect routes
  fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      // Assuming payload has tenantId (set during login)
      request.tenantId = (request.user as any).tenantId;
      
      if (!request.tenantId) {
        throw new Error('Missing tenantId in token');
      }
    } catch (err) {
      reply.code(401).send({ error: 'Unauthorized' });
      throw err;
    }
  });
}


export default fp(authPlugin, {
  name: "auth",
  dependencies: ["db"], // Optional: ensure DB is ready
});