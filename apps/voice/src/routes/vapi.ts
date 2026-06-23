// apps/voice/src/routes/vapi.ts
//
// VAPI sends all webhook events to a single Server URL as POST requests.
// Body shape is always: { message: { type: "<event-type>", call: {...}, ...fields } }
//
// The golden rule of webhook handlers:
// Respond 200 IMMEDIATELY for fire-and-forget events. Do the work after.
//
// Events that REQUIRE a response (VAPI waits synchronously):
//   "assistant-request"          → return assistantId or transient assistant config
//   "tool-calls"                 → return { results: [...] } with tool outputs
//   "transfer-destination-request" → return { destination: {...} }
//
// Fire-and-forget events (reply 200 immediately, process async):
//   "status-update"              → track call lifecycle (ringing, in-progress, ended)
//   "end-of-call-report"         → full transcript + recording URL available here
//   "hang"                       → call is stuck, surface to your team
//   "conversation-update"        → incremental conversation history

import { FastifyInstance } from "fastify";
import { findOrCreateContact } from "../services/contactService";
import { classifyTriage } from "../services/triageService";
import { createJobFromCall } from "../services/jobService";
import { Channel, ConversationStatus } from "../../../../db/generated/client";

export default async function vapiRoute(fastify: FastifyInstance) {
  // POST /webhooks/vapi/events
  // Single entry point — all VAPI events arrive here
  fastify.post("/vapi/events", async (request, reply) => {
    const body = request.body as VapiWebhookBody;
    const msg = body.message;

    // ── Synchronous events — VAPI waits for our response ──────────────────
    // These must reply with data, not { received: true }.

    if (msg.type === "assistant-request") {
      // VAPI is asking which assistant to use for this inbound call.
      // We reply with our saved assistant ID — fast, no DB call needed.
      // If we needed caller-specific context we'd build a transient assistant here.
      return reply.send({ assistantId: process.env.VAPI_ASSISTANT_ID });
    }

    if (msg.type === "tool-calls") {
      return reply.send(await handleToolCalls(fastify, msg));
    }

    // ── Fire-and-forget events — reply 200, process after ─────────────────
    reply.status(200).send({ received: true });

    try {
      if (msg.type === "status-update") {
        await handleStatusUpdate(fastify, msg);
      } else if (msg.type === "end-of-call-report") {
        await handleEndOfCallReport(fastify, msg);
      } else if (msg.type === "hang") {
        fastify.log.warn(
          { callId: msg.call?.id },
          "VAPI hang detected — call may be stuck",
        );
      }
    } catch (err) {
      fastify.log.error({ err, type: msg.type }, "Error processing VAPI event");
    }
  });
}

// ── Synchronous handlers ──────────────────────────────────────────────────

async function handleToolCalls(
  fastify: FastifyInstance,
  msg: VapiToolCallsMessage,
): Promise<VapiToolCallsResponse> {
  const toNumber = msg.call?.phoneNumber?.number ?? "";

  const tenant = await fastify.db.tenant.findUnique({
    where: { twilioNumber: toNumber },
  });

  if (!tenant) {
    // Return a graceful spoken error for each pending tool call
    return {
      results: msg.toolCallList.map((tc) => ({
        toolCallId: tc.id,
        result: "Sorry, I was unable to look that up right now.",
      })),
    };
  }

  const results = await Promise.all(
    msg.toolCallList.map(async (tc) => {
      if (tc.function.name === "checkAvailability") {
        const available = await fastify.db.technician.count({
          where: { tenantId: tenant.id, status: "AVAILABLE" },
        });
        return {
          toolCallId: tc.id,
          result: JSON.stringify({
            available: available > 0,
            message:
              available > 0
                ? "Yes, we have technicians available today."
                // TODO: Look into building a calendar. How are we sure we're free tomorrow?
                : "We are fully booked today but can schedule you for tomorrow.",
          }),
        };
      }

      if (tc.function.name === "lookupPrice") {
        const query = tc.function.arguments?.query ?? "";
        const items = await fastify.db.priceBookItem.findMany({
          where: {
            tenantId: tenant.id,
            active: true,
            description: { contains: query, mode: "insensitive" },
          },
          take: 1,
        });

        if (items.length === 0) {
          return {
            toolCallId: tc.id,
            result: JSON.stringify({
              found: false,
              message:
                "I don't have that price on hand but our technician will give you an exact quote on arrival.",
            }),
          };
        }

        return {
          toolCallId: tc.id,
          result: JSON.stringify({
            found: true,
            flatRate: items[0].flatRate,
            description: items[0].description,
            message: `That service is $${items[0].flatRate} flat rate, parts and labor included.`,
          }),
        };
      }

      return {
        toolCallId: tc.id,
        result: `Unknown tool: ${tc.function.name}`,
      };
    }),
  );

  return { results };
}

// ── Fire-and-forget handlers ──────────────────────────────────────────────

async function handleStatusUpdate(
  fastify: FastifyInstance,
  msg: VapiStatusUpdateMessage,
) {
  if (msg.status === "in-progress") {
    // Call connected — open a conversation record
    const toNumber = msg.call?.phoneNumber?.number ?? "";
    const fromNumber = msg.call?.customer?.number ?? "";
    const callerName = msg.call?.customer?.name;

    const tenant = await fastify.db.tenant.findUnique({
      where: { twilioNumber: toNumber },
    });
    if (!tenant) return;

    const contact = await findOrCreateContact(fastify.db, tenant.id, {
      phone: fromNumber,
      name: callerName,
    });

    await fastify.db.conversation.create({
      data: {
        tenantId: tenant.id,
        contactId: contact.id,
        channel: Channel.VOICE,
        status: ConversationStatus.ACTIVE,
        vapiCallId: msg.call?.id,
      },
    });

    fastify.log.info(
      { tenantId: tenant.id, fromNumber },
      "Call in-progress — conversation opened",
    );
  }
}

async function handleEndOfCallReport(
  fastify: FastifyInstance,
  msg: VapiEndOfCallReportMessage,
) {
  const toNumber = msg.call?.phoneNumber?.number ?? "";

  const tenant = await fastify.db.tenant.findUnique({
    where: { twilioNumber: toNumber },
  });
  if (!tenant) return;

  // Match the conversation we opened when the call went in-progress
  const conversation = await fastify.db.conversation.findFirst({
    where: {
      tenantId: tenant.id,
      channel: Channel.VOICE,
      status: ConversationStatus.ACTIVE,
      vapiCallId: msg.call?.id,
    },
    include: { contact: true },
  });

  if (!conversation) {
    fastify.log.warn(
      { callId: msg.call?.id },
      "end-of-call-report but no open conversation found",
    );
    return;
  }

  const transcript = msg.artifact?.transcript ?? "";

  // Caller hung up immediately with no real conversation
  if (transcript.trim().length < 20) {
    await fastify.db.conversation.update({
      where: { id: conversation.id },
      data: {
        status: ConversationStatus.ABANDONED,
        resolvedAt: new Date(),
      },
    });
    return;
  }

  // Classify the call using Claude
  const triage = await classifyTriage(transcript);

  await fastify.db.conversation.update({
    where: { id: conversation.id },
    data: {
      status: ConversationStatus.COMPLETED,
      triageTier: triage.tier,
      aiSummary: triage.summary,
      transcriptUrl: msg.artifact?.recording?.url,
      resolvedAt: new Date(),
    },
  });

  if (triage.shouldCreateJob) {
    await createJobFromCall(fastify.db, {
      tenantId: tenant.id,
      contactId: conversation.contactId,
      conversationId: conversation.id,
      triageTier: triage.tier,
      description: triage.summary,
      tradeType: triage.tradeType,
      address: conversation.contact.address ?? "",
      city: conversation.contact.city ?? undefined,
      state: conversation.contact.state ?? undefined,
      zip: conversation.contact.zip ?? undefined,
    });

    fastify.log.info(
      { tier: triage.tier, tenantId: tenant.id },
      "Job created from call",
    );
  }
}

// ── Types ─────────────────────────────────────────────────────────────────

interface VapiCall {
  id: string;
  phoneNumber?: { number: string };
  customer?: { number: string; name?: string };
}

interface VapiArtifact {
  transcript?: string;
  recording?: { url?: string };
}

// Discriminated union — add more event shapes as needed
type VapiMessage =
  | VapiAssistantRequestMessage
  | VapiToolCallsMessage
  | VapiStatusUpdateMessage
  | VapiEndOfCallReportMessage
  | VapiHangMessage;

interface VapiWebhookBody {
  message: VapiMessage;
}

interface VapiAssistantRequestMessage {
  type: "assistant-request";
  call: VapiCall;
}

interface VapiToolCallsMessage {
  type: "tool-calls";
  call: VapiCall;
  toolCallList: Array<{
    id: string;
    function: {
      name: string;
      arguments?: Record<string, string>;
    };
  }>;
}

interface VapiStatusUpdateMessage {
  type: "status-update";
  call: VapiCall;
  status:
    | "scheduled"
    | "queued"
    | "ringing"
    | "in-progress"
    | "forwarding"
    | "ended";
}

interface VapiEndOfCallReportMessage {
  type: "end-of-call-report";
  call: VapiCall;
  endedReason: string;
  artifact?: VapiArtifact;
}

interface VapiHangMessage {
  type: "hang";
  call: VapiCall;
}

interface VapiToolCallsResponse {
  results: Array<{
    toolCallId: string;
    result: string;
  }>;
}
