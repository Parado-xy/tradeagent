// apps/voice/src/index.ts
//
// Entry point for the voice webhook server.
// This is a separate app from the API for one reason:
// VAPI and Twilio expect webhook responses in under 200ms.
// If this server is slow, VAPI retries — and you get duplicate jobs.
// Keeping it separate means it stays lean, focused, and fast.
// No CORS needed here — this server never talks to a browser.

import Fastify from "fastify";
import  dbPlugin  from "./plugins/db";
import healthRoute from "./routes/health";
import vapiRoute from "./routes/vapi";
import smsRoute from "./routes/sms";

const server = Fastify({
  logger: {
    transport:
      process.env.NODE_ENV === "development"
        ? { target: "pino-pretty" }
        : undefined,
  },
});

async function start() {
  // ── Plugins ───────────────────────────────────────────────
  await server.register(dbPlugin);

  // ── Routes ────────────────────────────────────────────────
  await server.register(healthRoute);
  await server.register(vapiRoute, { prefix: "/webhooks" });
  await server.register(smsRoute, { prefix: "/webhooks" });

  // ── Start ─────────────────────────────────────────────────
  try {
    await server.listen({
      port: Number(process.env.VOICE_PORT) || 3002,
      host: "0.0.0.0",
    });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

start();
