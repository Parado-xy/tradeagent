// apps/voice/src/plugins/db.d.ts

import { PrismaClient } from "../../../db/generated/client";

declare module "fastify" {
  interface FastifyInstance {
    db: PrismaClient;
  }
}
