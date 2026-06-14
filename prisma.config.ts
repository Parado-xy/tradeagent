// prisma.config.ts
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "db/prisma/schema.prisma",
  migrations: {
    path: "db/prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
    // Neon requires directUrl for migrations — pooled connections
    // cause Prisma's migration engine to hang indefinitely
    // directUrl: process.env.DIRECT_URL,
  },
});
