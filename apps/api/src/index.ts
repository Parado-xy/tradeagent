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
import authPlugin from "./plugins/auth";
import errorHandlerPlugin from "./plugins/error";
import healthRoute from "./routes/health";
import contactsRoute from "./routes/contacts";
import jobsRoute from "./routes/jobs";
import invoicesRoute from "./routes/invoices";
import techniciansRoute from "./routes/technicians";
import provisioningRoute from "./routes/provisioning"
import tenantsRoutes from "./routes/tenants";
import authRoute from "./routes/auth"; 
import dotenv from "dotenv";

// Condigure dotenv
dotenv.config();

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
  await server.register(authPlugin); 
  await server.register(errorHandlerPlugin);

  // ── Routes ────────────────────────────────────────────────
  // Every route is prefixed with /api/v1 so we have room
  // to introduce /api/v2 later without breaking existing clients.
  const version = "v1"; // Define the version. 
  await server.register(healthRoute);
  await server.register(contactsRoute, { prefix: `/api/${version}` });
  await server.register(jobsRoute, { prefix: `/api/${version}` });
  await server.register(invoicesRoute, { prefix: `/api/${version}` });
  await server.register(techniciansRoute, { prefix: `/api/${version}` });
  await server.register(provisioningRoute, {prefix: `/api/${version}`});
  await server.register(tenantsRoutes, {prefix: `/api/${version}`});
  await server.register(authRoute, {prefix: `/api/${version}`});

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
