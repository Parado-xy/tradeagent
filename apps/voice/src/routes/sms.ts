// apps/voice/src/routes/sms.ts
//
// Handles inbound SMS from Twilio.
// When a customer texts the operator's TradeAgent number,
// we open a conversation and create a job just like a voice call.
// Twilio sends a POST with form-encoded body — not JSON.
// We use @fastify/formbody to parse it.

import { FastifyInstance } from "fastify";
import { findOrCreateContact } from "../services/contactService";
import { classifyTriage } from "../services/triageService";
import { createJobFromCall } from "../services/jobService";
import { Channel, ConversationStatus } from "../../../../db/generated/client";
import twilio from "twilio";

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

export default async function smsRoute(fastify: FastifyInstance) {
  // POST /webhooks/sms/inbound
  // Twilio posts here when a customer texts the TradeAgent number
  fastify.post("/sms/inbound", async (request, reply) => {
    const body = request.body as TwilioSmsBody;

    const tenant = await fastify.db.tenant.findUnique({
      where: { twilioNumber: body.To },
    });

    // Always reply 200 to Twilio — even on errors
    // Otherwise Twilio will keep retrying
    if (!tenant) {
      fastify.log.warn(
        { to: body.To },
        "SMS received for unknown tenant number",
      );
      return reply.status(200).send();
    }

    const contact = await findOrCreateContact(fastify.db, tenant.id, {
      phone: body.From,
    });

    // Open a conversation for this SMS thread
    const conversation = await fastify.db.conversation.create({
      data: {
        tenantId: tenant.id,
        contactId: contact.id,
        channel: Channel.SMS,
        status: ConversationStatus.ACTIVE,
      },
    });

    // Classify the SMS text directly — no audio transcription needed
    const triage = await classifyTriage(body.Body);

    // Update conversation with triage result
    await fastify.db.conversation.update({
      where: { id: conversation.id },
      data: {
        status: ConversationStatus.COMPLETED,
        triageTier: triage.tier,
        aiSummary: triage.summary,
        resolvedAt: new Date(),
      },
    });

    // Create a job if warranted
    if (triage.shouldCreateJob) {
      await createJobFromCall(fastify.db, {
        tenantId: tenant.id,
        contactId: contact.id,
        conversationId: conversation.id,
        triageTier: triage.tier,
        description: triage.summary,
        tradeType: triage.tradeType,
        address: contact.address ?? "",
      });
    }

    // Reply to the customer via SMS
    const replyMessage = triage.shouldCreateJob
      ? `Thanks for reaching out to ${tenant.name}. We've received your request and will be in touch shortly to confirm your appointment.`
      : `Thanks for contacting ${tenant.name}. A team member will follow up with you soon.`;

    await twilioClient.messages.create({
      to: body.From,
      from: body.To,
      body: replyMessage,
    });

    return reply.status(200).send();
  });
}

// ── Types ─────────────────────────────────────────────────────

interface TwilioSmsBody {
  From: string; // customer's phone number
  To: string; // our Twilio number (maps to tenant)
  Body: string; // the message text
  MessageSid: string;
}
