// apps/api/src/plugins/db.ts
//
// Attaches the Prisma client to the Fastify instance once at startup.
// Every route file accesses the db via fastify.db — no direct imports.
// One connection, shared across the entire app.

import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { PrismaClient } from "../../../../db/generated/client";

declare module "fastify" {
  interface FastifyInstance {
    db: PrismaClient;
  }
}

const prisma = new PrismaClient();

async function dbPlugin(fastify: FastifyInstance) {
  await prisma.$connect();

  // Decorating the fastify instance means every route handler
  // can access the db via fastify.db without importing Prisma directly
  fastify.decorate("db", prisma);

  // When the server shuts down, close the db connection cleanly
  fastify.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
}

// fp() (fastify-plugin) unwraps the plugin from Fastify's encapsulation.
// Without fp(), the decorator would only be visible inside this plugin's scope.
// With fp(), it's visible to the entire server — all routes can use fastify.db.
export default fp(dbPlugin);
