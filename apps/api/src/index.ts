// apps/api/src/index.ts
//
// This is the entry point for the API server.
// It does three things:
//   1. Creates the Fastify instance
//   2. Registers plugins (db connection, cors)
//   3. Registers routes
// Then starts listening.
//
// Keep this file thin. No business logic here ever.

import Fastify from "fastify";
import cors from "@fastify/cors";
import dbPlugin from "./plugins/db";
import healthRoute from "./routes/health";
import contactsRoute from "./routes/contacts";
import jobsRoute from "./routes/jobs";
import invoicesRoute from "./routes/invoices";
import techniciansRoute from "./routes/technicians";

const server = Fastify({
  // Fastify has a built-in logger powered by pino.
  // In development this prints readable logs.
  // In production it prints JSON — easy to pipe into Datadog or Logtail.
  logger: {
    transport:
      process.env.NODE_ENV === "development"
        ? { target: "pino-pretty" }
        : undefined,
  },
});

async function start() {
  // ── Plugins ───────────────────────────────────────────────
  // Plugins in Fastify are just functions that add behaviour
  // to the server instance. Order matters — db must be
  // registered before any route tries to use it.
  await server.register(import('fastify-raw-body'))
  await server.register(cors, {
    // In production, lock this down to your dashboard domain
    origin: process.env.DASHBOARD_URL || "http://localhost:5173",
  });

  await server.register(dbPlugin);

  // ── Routes ────────────────────────────────────────────────
  // Every route is prefixed with /api/v1 so we have room
  // to introduce /api/v2 later without breaking existing clients.

  await server.register(healthRoute);
  await server.register(contactsRoute, { prefix: "/api/v1" });
  await server.register(jobsRoute, { prefix: "/api/v1" });
  await server.register(invoicesRoute, { prefix: "/api/v1" });
  await server.register(techniciansRoute, { prefix: "/api/v1" });

  // ── Start ─────────────────────────────────────────────────
  try {
    await server.listen({
      port: Number(process.env.API_PORT) || 3001,
      // '0.0.0.0' means accept connections from any network interface.
      // '127.0.0.1' (the default) only accepts connections from localhost —
      // which breaks Docker and deployment environments.
      host: "0.0.0.0",
    });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

start();
