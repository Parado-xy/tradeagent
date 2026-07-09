// apps/voice/src/routes/twilio.ts
//
// Handles inbound SMS replies from Twilio.
//
// Twilio posts to this route when someone replies to a message
// we sent from a tenant's twilioNumber. The payload is
// application/x-www-form-urlencoded (not JSON) — Fastify needs
// the @fastify/formbody plugin registered for req.body to work.
//
// Key fields in Twilio's payload:
//   From → the sender's phone number (customer or dispatcher)
//   To   → the tenant's twilioNumber (how we find the tenant)
//   Body → the reply text
//   MessageSid → Twilio's unique ID for this inbound message
//
// Flow:
//   1. Reply 200 immediately — Twilio will retry if we don't
//   2. Find tenant by To (twilioNumber)
//   3. Find open SmsThread by (From, tenantId, AWAITING_REPLY)
//   4. Route to handler based on thread.purpose
//   5. Handler updates DB + fires next SMS

import { FastifyInstance } from "fastify";
import {
  PrismaClient,
  SmsThreadStatus,
  SmsDirection,
  JobStatus,
} from "../../../../db/generated/client";
import { sendTechNotification } from "../services/smsService";

export default async function twilioRoute(fastify: FastifyInstance) {
  fastify.post("/twilio/sms", async (request, reply) => {
    // Twilio expects a 200 immediately — reply first, process after
    reply.status(200).send();

    const body = request.body as TwilioSmsPayload;

    const from = body.From; // who replied
    const to = body.To; // our twilioNumber → identifies the tenant
    const text = body.Body?.trim() ?? "";
    const twilioSid = body.MessageSid;

    if (!from || !to || !text) {
      fastify.log.warn({ from, to }, "Inbound SMS missing required fields");
      return;
    }

    try {
      // ── Find tenant by their twilioNumber ───────────────────────────
      const tenant = await fastify.db.tenant.findFirst({
        where: { twilioNumber: to },
      });

      if (!tenant) {
        fastify.log.warn({ to }, "Inbound SMS: no tenant found for number");
        return;
      }

      // ── Find the open thread waiting for this sender ────────────────
      //
      // Match on: recipient number (to = from in reverse), tenant,
      // and status AWAITING_REPLY.
      //
      // Why check both tenantId and to?
      // A phone number could theoretically text multiple tenants.
      // tenantId scopes the lookup so we don't accidentally route
      // a customer reply to the wrong business's thread.
      const thread = await fastify.db.smsThread.findFirst({
        where: {
          tenantId: tenant.id,
          to: from, // the thread's `to` is who we sent to = who's replying now
          status: SmsThreadStatus.AWAITING_REPLY,
        },
        include: {
          job: {
            include: { contact: true },
          },
        },
        orderBy: { createdAt: "desc" }, // most recent thread wins if duplicates exist
      });

      if (!thread) {
        fastify.log.info(
          { from, tenantId: tenant.id },
          "Inbound SMS: no open thread found for sender — ignoring",
        );
        return;
      }

      // Log the inbound message regardless of what we do with it
      await fastify.db.smsMessage.create({
        data: {
          threadId: thread.id,
          direction: SmsDirection.INBOUND,
          body: text,
          twilioSid,
        },
      });

      // ── Route by thread purpose ─────────────────────────────────────
      if (thread.purpose === "ADDRESS_CONFIRMATION") {
        await handleAddressConfirmation(
          fastify.db,
          thread,
          text,
          tenant,
          fastify,
        );
      } else if (thread.purpose === "DISPATCH_SELECTION") {
        await handleDispatchSelection(
          fastify.db,
          thread,
          text,
          tenant,
          fastify,
        );
      }
    } catch (err) {
      fastify.log.error({ err, from, to }, "Error processing inbound SMS");
    }
  });
}

// ── Address confirmation handler ──────────────────────────────────────────
//
// The customer replied to our address confirmation SMS.
// Two cases:
//   "YES" (or "yes", "y", "correct", "right") → address is fine, just close thread
//   Anything else → treat as the corrected address, update contact + job
//
// After updating, we send a confirmation back so the customer knows
// we got it. Keep it short — they don't need an essay.

async function handleAddressConfirmation(
  db: PrismaClient,
  thread: ThreadWithJob,
  text: string,
  tenant: { twilioNumber: string | null; name: string },
  fastify: FastifyInstance,
) {
  const job = thread.job;
  const contact = job.contact;

  const isConfirmation = /^(yes|y|correct|right|yep|yup|ok|okay)$/i.test(
    text.trim(),
  );

  if (!isConfirmation) {
    // Customer provided a corrected address — update both contact and job
    // We store the raw reply as the address. A geocoding pass in Phase 3
    // will normalize it. For now raw is fine — the tech can read it.
    await db.$transaction([
      db.contact.update({
        where: { id: contact.id },
        data: { address: text },
      }),
      db.job.update({
        where: { id: job.id },
        data: { address: text },
      }),
    ]);

    fastify.log.info(
      { jobId: job.id, address: text },
      "Address updated from customer reply",
    );
  }

  // Close the thread regardless of confirmation or correction
  await db.smsThread.update({
    where: { id: thread.id },
    data: {
      status: SmsThreadStatus.COMPLETED,
      resolvedAt: new Date(),
    },
  });

  // Send a brief confirmation back to the customer
  if (tenant.twilioNumber) {
    const twilio = await import("twilio");
    const client = twilio.default(
      process.env.TWILIO_ACCOUNT_SID!,
      process.env.TWILIO_AUTH_TOKEN!,
    );

    const replyBody = isConfirmation
      ? `Got it — address confirmed. A technician will be in touch shortly.`
      : `Got it — we've updated your address. A technician will be in touch shortly.`;

    await client.messages.create({
      to: contact.phone,
      from: tenant.twilioNumber,
      body: replyBody,
    });
  }
}

// ── Dispatch selection handler ────────────────────────────────────────────
//
// The dispatcher replied with a digit selecting a technician.
// We re-query available techs in the same deterministic order
// (name asc, same filter) used in sendDispatchSelection so the
// numbering matches.
//
// NOTE: this is the ordering-consistency dependency flagged in smsService.ts.
// When we add the `meta` column to SmsThread, this re-query goes away
// and we just read thread.meta to map digit → technicianId directly.
//
// Valid replies: "1", "2", "3" etc.
// Invalid replies: anything else → log and ignore (thread stays open)
//
// On valid selection:
//   - assign tech to job (job.technicianId, job.status → DISPATCHED)
//   - update tech status → DISPATCHED
//   - close the thread
//   - SMS the tech via sendTechNotification

async function handleDispatchSelection(
  db: PrismaClient,
  thread: ThreadWithJob,
  text: string,
  tenant: {
    id: string;
    twilioNumber: string | null;
    name: string;
    dispatcherPhone: string | null;
  },
  fastify: FastifyInstance,
) {
  const selection = parseInt(text.trim(), 10);

  if (isNaN(selection) || selection < 1) {
    fastify.log.warn(
      { threadId: thread.id, text },
      "Dispatch selection: invalid reply — ignoring",
    );
    return;
  }

  const job = thread.job;

  // Re-query in the same order as sendDispatchSelection
  const availableTechs = await db.technician.findMany({
    where: {
      tenantId: tenant.id,
      status: "AVAILABLE",
      skillTags: { has: job.tradeType },
    },
    orderBy: { name: "asc" },
  });

  const selectedTech = availableTechs[selection - 1]; // convert 1-indexed to 0-indexed

  if (!selectedTech) {
    fastify.log.warn(
      { threadId: thread.id, selection, available: availableTechs.length },
      "Dispatch selection: number out of range — ignoring",
    );
    return;
  }

  // Assign tech to job and mark both as dispatched — atomic transaction
  await db.$transaction([
    db.job.update({
      where: { id: job.id },
      data: {
        technicianId: selectedTech.id,
        status: JobStatus.DISPATCHED,
      },
    }),
    db.technician.update({
      where: { id: selectedTech.id },
      data: { status: "DISPATCHED" },
    }),
    db.smsThread.update({
      where: { id: thread.id },
      data: {
        status: SmsThreadStatus.COMPLETED,
        resolvedAt: new Date(),
      },
    }),
  ]);

  fastify.log.info(
    { jobId: job.id, techId: selectedTech.id, techName: selectedTech.name },
    "Tech dispatched",
  );

  // Notify the tech — fetch full tenant for twilioNumber
  const fullTenant = await db.tenant.findUniqueOrThrow({
    where: { id: tenant.id },
  });

  await sendTechNotification(fullTenant, selectedTech, job, job.contact);
}

// ── Types ─────────────────────────────────────────────────────────────────

interface TwilioSmsPayload {
  From: string;
  To: string;
  Body: string;
  MessageSid: string;
}

// Thread as returned by the findFirst query with job + contact included
type ThreadWithJob = {
  id: string;
  purpose: "ADDRESS_CONFIRMATION" | "DISPATCH_SELECTION";
  job: {
    id: string;
    address: string;
    tradeType: any;
    description: string;
    contact: {
      id: string;
      phone: string;
      name: string | null;
      address: string | null;
      city: string | null;
      state: string | null;
      zip: string | null;
    };
  };
};
