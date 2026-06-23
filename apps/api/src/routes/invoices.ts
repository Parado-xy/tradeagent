// apps/api/src/routes/invoices.ts
//
// Routes:
//   GET  /api/v1/invoices
//   GET  /api/v1/invoices/:id
//   POST /api/v1/invoices/from-voice
//   POST /api/v1/invoices
//   PATCH /api/v1/invoices/:id/line-items
//   POST /api/v1/invoices/:id/send
//   POST /api/v1/invoices/:id/void
//   POST /api/v1/invoices/stripe/webhook

import { FastifyInstance } from "fastify";
import {
  listInvoices,
  getInvoice,
  createInvoiceFromVoice,
  createInvoiceManually,
  updateInvoiceLineItems,
  sendInvoice,
  voidInvoice,
  handleStripeWebhook,
} from "../services/invoiceService";
import { InvoiceStatus } from "../../../../db/generated/client";

export default async function invoicesRoute(fastify: FastifyInstance) {
  // GET /api/v1/invoices?status=DRAFT
  fastify.get("/invoices", async (request) => {
    const { status, limit, offset } = request.query as {
      status?: string;
      limit?: string;
      offset?: string;
    };

    return listInvoices(fastify.db, {
      status: status as InvoiceStatus,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  });

  // GET /api/v1/invoices/:id
  fastify.get("/invoices/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const invoice = await getInvoice(fastify.db, id);

    if (!invoice) {
      return reply.status(404).send({ error: "Invoice not found" });
    }

    return invoice;
  });

  // POST /api/v1/invoices/from-voice
  // The primary path — tech records voice note, we build the invoice.
  // Body: { jobId, audioUrl }
  fastify.post("/invoices/from-voice", async (request, reply) => {
    const { jobId, audioUrl } = request.body as {
      jobId: string;
      audioUrl: string;
    };

    if (!jobId || !audioUrl) {
      return reply
        .status(400)
        .send({ error: "jobId and audioUrl are required" });
    }

    try {
      const result = await createInvoiceFromVoice(fastify.db, jobId, audioUrl);
      return reply.status(201).send(result);
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({ error: err.message });
    }
  });

  // POST /api/v1/invoices
  // Manual invoice creation from the dashboard.
  // Body: { jobId, lineItems: [...] }
  fastify.post("/invoices", async (request, reply) => {
    const { jobId, lineItems } = request.body as {
      jobId: string;
      lineItems: any[];
    };

    if (!jobId || !lineItems?.length) {
      return reply
        .status(400)
        .send({ error: "jobId and at least one lineItem are required" });
    }

    try {
      const invoice = await createInvoiceManually(fastify.db, jobId, lineItems);
      return reply.status(201).send(invoice);
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({ error: err.message });
    }
  });

  // PATCH /api/v1/invoices/:id/line-items
  // Operator corrects AI-generated line items before sending.
  fastify.patch("/invoices/:id/line-items", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { lineItems } = request.body as { lineItems: any[] };

    if (!lineItems?.length) {
      return reply.status(400).send({ error: "lineItems array is required" });
    }

    try {
      const invoice = await updateInvoiceLineItems(fastify.db, id, lineItems);
      return invoice;
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({ error: err.message });
    }
  });

  // POST /api/v1/invoices/:id/send
  // Generates Stripe payment link and texts it to the customer.
  // Moves invoice DRAFT → SENT.
  fastify.post("/invoices/:id/send", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const invoice = await sendInvoice(fastify.db, id);
      return invoice;
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({ error: err.message });
    }
  });

  // POST /api/v1/invoices/:id/void
  fastify.post("/invoices/:id/void", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const invoice = await voidInvoice(fastify.db, id);
      return invoice;
    } catch (err: any) {
      return reply.status(err.statusCode || 500).send({ error: err.message });
    }
  });

  // POST /api/v1/invoices/stripe/webhook
  // Stripe calls this when a payment succeeds.
  // IMPORTANT: Stripe requires the raw request body to verify
  // the webhook signature. We add rawBody support in the plugin.
  fastify.post(
    "/invoices/stripe/webhook",
    {
      config: { rawBody: true },
    },
    async (request, reply) => {
      const signature = request.headers["stripe-signature"] as string;

      if (!signature) {
        return reply.status(400).send({ error: "Missing Stripe signature" });
      }

      try {
        const result = await handleStripeWebhook(
          fastify.db,
          // rawBody is added by the rawBody plugin we register in index.ts
          (request as any).rawBody,
          signature,
        );
        return result;
      } catch (err: any) {
        return reply.status(err.statusCode || 500).send({ error: err.message });
      }
    },
  );
}
