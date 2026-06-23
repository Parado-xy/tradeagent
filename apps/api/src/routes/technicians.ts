// apps/api/src/routes/technicians.ts
//
// Routes:
//   GET    /api/v1/technicians
//   GET    /api/v1/technicians/:id
//   POST   /api/v1/technicians
//   PATCH  /api/v1/technicians/:id
//   DELETE /api/v1/technicians/:id

import { FastifyInstance } from "fastify";
import {
  listTechnicians,
  getTechnician,
  createTechnician,
  updateTechnician,
  deleteTechnician,
} from "../services/technicianService";

export default async function techniciansRoute(fastify: FastifyInstance) {
  // GET /api/v1/technicians?status=AVAILABLE
  fastify.get("/technicians", async (request) => {
    const { status } = request.query as { status?: string };
    return listTechnicians(fastify.db, { status });
  });

  // GET /api/v1/technicians/:id
  fastify.get("/technicians/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tech = await getTechnician(fastify.db, id);

    if (!tech) {
      return reply.status(404).send({ error: "Technician not found" });
    }

    return tech;
  });

  // POST /api/v1/technicians
  fastify.post("/technicians", async (request, reply) => {
    const body = request.body as {
      tenantId: string;
      name: string;
      phone: string;
      skillTags: string[];
    };

    const tech = await createTechnician(fastify.db, body);
    return reply.status(201).send(tech);
  });

  // PATCH /api/v1/technicians/:id
  fastify.patch("/technicians/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      name?: string;
      phone?: string;
      skillTags?: string[];
      status?: string;
    };

    const tech = await updateTechnician(fastify.db, id, body);

    if (!tech) {
      return reply.status(404).send({ error: "Technician not found" });
    }

    return tech;
  });

  // DELETE /api/v1/technicians/:id
  fastify.delete("/technicians/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      await deleteTechnician(fastify.db, id);
      return reply.status(204).send();
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({ error: err.message });
    }
  });
}
