// apps/api/src/plugins/db.d.ts
//
// TypeScript doesn't know we added 'db' to the Fastify instance —
// we did it at runtime via fastify.decorate(). This file tells
// TypeScript about it so you get autocomplete on fastify.db everywhere.

import { PrismaClient } from "../../../../db/generated/client";

declare module "fastify" {
  interface FastifyInstance {
    db: PrismaClient;
  }
}
