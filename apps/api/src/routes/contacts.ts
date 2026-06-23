// apps/api/src/routes/contacts.ts
//
// HTTP layer only. Validates input, calls the service, returns the result.
// Zero business logic in this file — that lives in contactService.ts.
//
// Routes:
//   GET    /api/v1/contacts
//   GET    /api/v1/contacts/:id
//   PATCH  /api/v1/contacts/:id
//   DELETE /api/v1/contacts/:id

import { FastifyInstance } from "fastify";
import {
  listContacts,
  getContact,
  updateContact,
  deleteContact,
} from "../services/contactService";

export default async function contactsRoute(fastify: FastifyInstance) {
  // GET /api/v1/contacts?search=mike&limit=20&offset=0
  fastify.get("/contacts", async (request, reply) => {
    const { search, limit, offset } = request.query as {
      search?: string;
      limit?: string;
      offset?: string;
    };

    const result = await listContacts(fastify.db, {
      search,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });

    return result;
  });

  // GET /api/v1/contacts/:id
  fastify.get("/contacts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const contact = await getContact(fastify.db, id);

    if (!contact) {
      return reply.status(404).send({ error: "Contact not found" });
    }

    return contact;
  });

  // PATCH /api/v1/contacts/:id
  fastify.patch("/contacts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      name?: string;
      address?: string;
      city?: string;
      state?: string;
      zip?: string;
    };

    const contact = await updateContact(fastify.db, id, body);

    if (!contact) {
      return reply.status(404).send({ error: "Contact not found" });
    }

    return contact;
  });

  // DELETE /api/v1/contacts/:id
  fastify.delete("/contacts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      await deleteContact(fastify.db, id);
      return reply.status(204).send();
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({ error: err.message });
    }
  });
}
