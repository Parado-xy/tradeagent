// apps/api/src/routes/jobs.ts
//
// Routes:
//   GET    /api/v1/jobs
//   GET    /api/v1/jobs/:id
//   POST   /api/v1/jobs
//   PATCH  /api/v1/jobs/:id
//   POST   /api/v1/jobs/:id/dispatch

import { FastifyInstance } from "fastify";
import {
  listJobs,
  getJob,
  createJob,
  updateJob,
  dispatchJob,
} from "../services/jobService";

export default async function jobsRoute(fastify: FastifyInstance) {
  // GET /api/v1/jobs?status=PENDING&technicianId=xxx&date=2024-01-15
  fastify.get("/jobs", async (request, reply) => {
    const { status, technicianId, date } = request.query as {
      status?: string;
      technicianId?: string;
      date?: string;
    };

    return listJobs(fastify.db, { status, technicianId, date });
  });

  // GET /api/v1/jobs/:id
  fastify.get("/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await getJob(fastify.db, id);

    if (!job) {
      return reply.status(404).send({ error: "Job not found" });
    }

    return job;
  });

  // POST /api/v1/jobs
  fastify.post("/jobs", async (request, reply) => {
    const body = request.body as {
      tenantId: string;
      contactId: string;
      tradeType: string;
      description: string;
      address: string;
      city?: string;
      state?: string;
      zip?: string;
      scheduledAt?: string;
      conversationId?: string;
    };

    const job = await createJob(fastify.db, body);
    return reply.status(201).send(job);
  });

  // PATCH /api/v1/jobs/:id
  fastify.patch("/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      status?: string;
      technicianId?: string;
      scheduledAt?: string;
      description?: string;
      completedAt?: string;
    };

    const job = await updateJob(fastify.db, id, body);

    if (!job) {
      return reply.status(404).send({ error: "Job not found" });
    }

    return job;
  });

  // POST /api/v1/jobs/:id/dispatch
  // Assigns a technician and moves the job to DISPATCHED.
  // Body: { technicianId? } — if omitted we find the first available tech.
  fastify.post("/jobs/:id/dispatch", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { technicianId } = (request.body as { technicianId?: string }) || {};

    try {
      const job = await dispatchJob(fastify.db, id, technicianId);
      return job;
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({ error: err.message });
    }
  });
}
