// apps/voice/src/routes/vapi.ts
//
// VAPI sends all webhook events to a single Server URL as POST requests.
// Body shape is always: { message: { type: "<event-type>", call: {...}, ...fields } }
//
// The golden rule of webhook handlers:
// Respond 200 IMMEDIATELY for fire-and-forget events. Do the work after.
//
// Events that REQUIRE a response (VAPI waits synchronously):
//   "assistant-request"            → return assistantId or transient assistant config
//   "tool-calls"                   → return { results: [...] } with tool outputs
//   "transfer-destination-request" → return { destination: {...} }
//
// Fire-and-forget events (reply 200 immediately, process async):
//   "status-update"        → track call lifecycle (ringing, in-progress, ended)
//   "end-of-call-report"   → full transcript + recording URL available here
//   "hang"                 → call is stuck, surface to your team

import { FastifyInstance } from "fastify";
import { findOrCreateContact } from "../services/contactService";
import { classifyTriage } from "../services/triageService";
import { createJobFromCall } from "../services/jobService";
import {
  Channel,
  ConversationStatus,
  PrismaClient,
} from "../../../../db/generated/client";
import {
  sendCustomerAck,
  sendAddressConfirmation,
  sendDispatchSelection,
} from "../services/smsService";

export default async function vapiRoute(fastify: FastifyInstance) {
  fastify.post("/vapi/events", async (request, reply) => {
    const body = request.body as VapiWebhookBody;
    const msg = body.message;

    // ── Synchronous events — VAPI waits for our response ──────────────────

    if (msg.type === "assistant-request") {
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

// ── Tenant lookup ─────────────────────────────────────────────────────────
//
// Primary:  vapiPhoneNumberId — set during onboarding when we provision or
//           import a number via VAPI's API. Works for both VAPI-provisioned
//           and Twilio-imported numbers since VAPI assigns an ID to all of them.
//
// Fallback: SIP URI extraction — the called number is embedded in the SIP URI
//           as the user portion: sip:3502029684@host:port
//           We strip the +1 prefix from our stored twilioNumber to match.
//           This covers the case where vapiPhoneNumberId was never stored
//           (e.g. manually provisioned numbers, legacy tenants).

async function findTenant(db: PrismaClient, call: VapiCall) {
  // Primary: match by VAPI's phoneNumberId
  if (call.phoneNumberId) {
    const tenant = await db.tenant.findUnique({
      where: { vapiPhoneNumberId: call.phoneNumberId },
    });
    if (tenant) return tenant;
  }

  // Fallback: extract number from SIP URI
  // e.g. sip:3502029684@172.30.13.20:5060 → "3502029684"
  const sipUri = call.phoneCallProviderDetails?.sip?.uri ?? "";
  const sipMatch = sipUri.match(/^sip:(\d+)@/);
  if (sipMatch) {
    const rawNumber = sipMatch[1]; // e.g. "3502029684"
    // Our twilioNumber is stored as +13502029684 — strip the country code to compare
    const tenant = await db.tenant.findFirst({
      where: {
        twilioNumber: { endsWith: rawNumber },
      },
    });
    if (tenant) return tenant;
  }

  return null;
}

// ── Synchronous handlers ──────────────────────────────────────────────────

async function handleToolCalls(
  fastify: FastifyInstance,
  msg: VapiToolCallsMessage,
): Promise<VapiToolCallsResponse> {
  const tenant = await findTenant(fastify.db, msg.call);

  if (!tenant) {
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
  if (msg.status !== "in-progress") return;

  const tenant = await findTenant(fastify.db, msg.call);
  if (!tenant) {
    fastify.log.warn(
      { callId: msg.call?.id },
      "status-update: no tenant found",
    );
    return;
  }

  const fromNumber = msg.call?.customer?.number ?? "";
  const callerName = msg.call?.customer?.name;

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


async function handleEndOfCallReport(
  fastify: FastifyInstance,
  msg: VapiEndOfCallReportMessage,
) {
  const tenant = await findTenant(fastify.db, msg.call);
  if (!tenant) {
    fastify.log.warn(
      { callId: msg.call?.id },
      "end-of-call-report: no tenant found",
    );
    return;
  }

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
      "end-of-call-report: no open conversation found",
    );
    return;
  }

  const transcript = msg.artifact?.transcript ?? "";

  if (transcript.trim().length < 20) {
    await fastify.db.conversation.update({
      where: { id: conversation.id },
      data: { status: ConversationStatus.ABANDONED, resolvedAt: new Date() },
    });
    return;
  }

  const triage = await classifyTriage(transcript);

  await fastify.db.conversation.update({
    where: { id: conversation.id },
    data: {
      status: ConversationStatus.COMPLETED,
      triageTier: triage.tier,
      aiSummary: triage.summary,
      transcriptUrl: msg.artifact?.recording?.url,
      resolvedAt: new Date(),
      contact: {
        name: triage.customerName,
        address: triage.address,
        city: triage.city,
        state: triage.state,
      }
    },
  });

  // ── SMS: customer acknowledgement ───────────────────────────────────────
  //
  // Fire immediately — customer knows their call was received.
  // Non-blocking: if this fails we log and continue. A failed ack
  // shouldn't block job creation or dispatch.
  if (tenant.twilioNumber) {
    sendCustomerAck(conversation.contact, tenant).catch((err) =>
      fastify.log.error(
        { err, contactId: conversation.contactId },
        "Failed to send customer ack",
      ),
    );
  } else {
    fastify.log.warn(
      { tenantId: tenant.id },
      "Skipping customer ack — tenant has no twilioNumber",
    );
  }

  if (!triage.shouldCreateJob) {
    // No job warranted (ESTIMATE tier or similar) — nothing left to do
    fastify.log.info(
      { tier: triage.tier, tenantId: tenant.id },
      "Triage complete — no job created",
    );
    return;
  }

  // ── Job creation ────────────────────────────────────────────────────────
  const job = await createJobFromCall(fastify.db, {
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
    { tier: triage.tier, tenantId: tenant.id, jobId: job.id },
    "Job created from call",
  );

  // ── SMS: address confirmation + dispatch selection ──────────────────────
  //
  // Both run concurrently — they're independent of each other.
  // Address confirmation goes to the customer.
  // Dispatch selection goes to the dispatcher.
  //
  // We await both so errors surface in this handler's catch block
  // rather than silently failing. Job is already created at this point
  // so a failed SMS doesn't roll anything back — we log and move on.
  //
  // Why not fire-and-forget like the ack?
  // The ack is a courtesy message. These two open SmsThreads that drive
  // the rest of the dispatch flow — we want to know if they fail.

  const smsResults = await Promise.allSettled([
    sendAddressConfirmation(
      fastify.db,
      tenant,
      conversation.contact,
      job,
      conversation.id,
    ),
    sendDispatchSelection(fastify.db, tenant, job, triage, conversation.id),
  ]);

  // Log any failures without throwing — the job exists, dispatch can
  // still happen manually if SMS fails
  smsResults.forEach((result, i) => {
    if (result.status === "rejected") {
      const label =
        i === 0 ? "sendAddressConfirmation" : "sendDispatchSelection";
      fastify.log.error(
        { err: result.reason, jobId: job.id, tenantId: tenant.id },
        `${label} failed`,
      );
    }
  });
}
 
// ── Types ─────────────────────────────────────────────────────────────────

interface SipDetails {
  uri?: string;
}

interface VapiCall {
  id: string;
  phoneNumberId?: string;
  phoneCallProviderDetails?: { sip?: SipDetails };
  customer?: { number: string; name?: string };
}

interface VapiArtifact {
  transcript?: string;
  recording?: { url?: string };
}

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
