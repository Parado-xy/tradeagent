// apps/voice/src/plugins/db.ts
//
// Exact same pattern as the API db plugin.
// Each app manages its own connection to the database.
// They share the same schema — not the same connection.

import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { PrismaClient } from "../../../../db/generated/client";

// ── TypeScript Module Augmentation ────────────────────────────
// This tells the compiler that calling fastify.decorate("db", prisma)
// permanently adds the .db property to FastifyInstance across the app.
declare module "fastify" {
  interface FastifyInstance {
    db: PrismaClient;
  }
}
// ──────────────────────────────────────────────────────────────

const prisma = new PrismaClient();

async function dbPlugin(fastify: FastifyInstance) {
  await prisma.$connect();
  fastify.decorate("db", prisma);
  fastify.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
}

export default fp(dbPlugin);
