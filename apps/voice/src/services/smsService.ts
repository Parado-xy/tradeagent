// apps/voice/src/services/smsService.ts
//
// Handles all outbound SMS sent by TradeAgent after a call ends.
// Every SMS we send opens an SmsThread in the DB so we know what
// we're waiting for when a reply comes in via /twilio/sms.
//
// Four outbound messages per completed call:
//
//   1. sendCustomerAck         → immediate "we got your request" to the caller
//   2. sendAddressConfirmation → ask the customer to confirm their address
//   3. sendDispatchSelection   → tell the dispatcher who's available, ask them to pick
//   4. sendTechNotification    → fires after dispatcher replies, assigns the tech
//
// Messages 1 and 4 are fire-and-forget (no reply expected, no SmsThread).
// Messages 2 and 3 open SmsThreads and wait for a reply.
//
// Why send from the tenant's twilioNumber?
// The customer already has that number in their call history.
// Replying to the same number they called feels natural and reduces
// confusion. The dispatcher also knows the number belongs to their account.

import twilio from "twilio";
import {
  PrismaClient,
  Tenant,
  Contact,
  Job,
  Technician,
  SmsPurpose,
  SmsDirection,
  TriageTier,
} from "../../../../db/generated/client";

// ── Twilio client ─────────────────────────────────────────────────────────
//
// Instantiated once per module load. Credentials come from env — never
// hardcode these. The client is stateless so one instance is fine.

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!,
);

// ── Thread expiry ─────────────────────────────────────────────────────────
//
// How long we wait for a reply before the thread is considered stale.
// 30 minutes for address confirmation (customer might be driving).
// 60 minutes for dispatch selection (dispatcher might be in the field).

const EXPIRY_MINUTES = {
  ADDRESS_CONFIRMATION: 30,
  DISPATCH_SELECTION: 60,
} as const;

function expiresFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

// ── Types ─────────────────────────────────────────────────────────────────
//
// TriageResult mirrors what triageService.ts returns from generateObject.
// We only pull the fields smsService actually needs.

interface TriageResult {
  tier: TriageTier;
  summary: string;
  tradeType: string;
}

// ── 1. Customer acknowledgement ───────────────────────────────────────────
//
// Sent immediately after the call ends — before any DB writes complete.
// No SmsThread needed: we're not waiting for a reply to this one.
// The customer just needs to know their call was received.

export async function sendCustomerAck(
  contact: Contact,
  tenant: Tenant,
): Promise<void> {
  if (!tenant.twilioNumber) {
    throw new Error(`Tenant ${tenant.id} has no twilioNumber — cannot send SMS`);
  }

  const body =
    `Hi${contact.name ? ` ${contact.name}` : ""}, this is ${tenant.name}. ` +
    `We received your service request and are on it. ` +
    `You'll hear from us shortly.`;

  await twilioClient.messages.create({
    to: contact.phone,
    from: tenant.twilioNumber,
    body,
  });
}

// ── 2. Address confirmation ───────────────────────────────────────────────
//
// Sent to the customer asking them to confirm the address.
// Voice calls are noisy — the AI might mishear a street number or zip.
// Getting a text confirmation means the job record is reliable.
//
// Opens an ADDRESS_CONFIRMATION SmsThread so the inbound webhook
// knows what to do when the customer replies.
//
// The job.address at this point is whatever the AI captured from the call.
// We show it to the customer so they can correct it if it's wrong,
// rather than asking them to type it from scratch.

export async function sendAddressConfirmation(
  db: PrismaClient,
  tenant: Tenant,
  contact: Contact,
  job: Job,
  conversationId: string,
): Promise<void> {
  if (!tenant.twilioNumber) {
    throw new Error(`Tenant ${tenant.id} has no twilioNumber — cannot send SMS`);
  }

  const currentAddress = job.address?.trim()
    ? `We have your address as: ${job.address}${job.city ? `, ${job.city}` : ""}${job.state ? `, ${job.state}` : ""}. Is that correct?`
    : `Could you reply with your full service address so we can dispatch correctly?`;

  const body =
    `Hi${contact.name ? ` ${contact.name}` : ""}, ` +
    `this is ${tenant.name} confirming your service request. ` +
    currentAddress +
    ` Reply with your full address (or YES if correct).`;

  // Send the SMS first — if Twilio fails, we don't create a dangling thread
  const message = await twilioClient.messages.create({
    to: contact.phone,
    from: tenant.twilioNumber,
    body,
  });

  // Open the thread so the inbound webhook knows what to expect
  await db.smsThread.create({
    data: {
      tenantId: tenant.id,
      conversationId,
      jobId: job.id,
      to: contact.phone,
      purpose: SmsPurpose.ADDRESS_CONFIRMATION,
      expiresAt: expiresFromNow(EXPIRY_MINUTES.ADDRESS_CONFIRMATION),
      messages: {
        create: {
          direction: SmsDirection.OUTBOUND,
          body,
          twilioSid: message.sid,
        },
      },
    },
  });
}

// ── 3. Dispatch selection ─────────────────────────────────────────────────
//
// Sent to the dispatcher (tenant.dispatcherPhone) listing all available
// technicians with matching skillTags for this job's tradeType.
//
// Why query techs here instead of passing them in?
// The caller (handleEndOfCallReport) doesn't know which techs are
// available — that's smsService's concern. Keeps the webhook handler clean.
//
// We number the techs (1, 2, 3...) so the dispatcher can reply with
// just a digit. The inbound handler maps the digit back to a technicianId.
//
// The tech list is stored as JSON in the SmsThread... wait, we don't
// have a metadata column on SmsThread. Instead we store the ordered list
// in the outbound SmsMessage body and re-parse it on reply — fragile.
//
// TODO:
// Better: we store the serialized tech order in a `meta` Json column.
// We'll add that to the schema. For now, we store it in the message body
// and the inbound handler re-queries available techs in the same order.
// (See note in twilio.ts about ordering consistency.)

export async function sendDispatchSelection(
  db: PrismaClient,
  tenant: Tenant,
  job: Job,
  triage: TriageResult,
  conversationId: string,
): Promise<{ technicianCount: number }> {
  if (!tenant.dispatcherPhone) {
    throw new Error(
      `Tenant ${tenant.id} has no dispatcherPhone — cannot send dispatch SMS`,
    );
  }

  if (!tenant.twilioNumber) {
    throw new Error(`Tenant ${tenant.id} has no twilioNumber — cannot send SMS`);
  }

  // Find available techs with the right skill for this trade type
  const availableTechs = await db.technician.findMany({
    where: {
      tenantId: tenant.id,
      status: "AVAILABLE",
      skillTags: { has: job.tradeType },
    },
    orderBy: { name: "asc" }, // deterministic order — inbound handler must match
  });

  const tierLabel: Record<TriageTier, string> = {
    EMERGENCY: "🚨 EMERGENCY",
    URGENT: "⚠️  URGENT",
    ROUTINE: "📋 ROUTINE",
    ESTIMATE: "💬 ESTIMATE",
  };

  // Build the tech selection list
  const techLines =
    availableTechs.length > 0
      ? availableTechs
          .map((t, i) => `${i + 1}. ${t.name} (${t.skillTags.join(", ")})`)
          .join("\n")
      : "No techs available right now.";

  const body = [
    `${tierLabel[triage.tier]} — ${tenant.name}`,
    ``,
    `Customer: ${job.address}`,
    `Issue: ${triage.summary}`,
    ``,
    `Available techs:`,
    techLines,
    ``,
    availableTechs.length > 0
      ? `Reply with the number (1–${availableTechs.length}) to dispatch.`
      : `Reply MANUAL to handle dispatch yourself.`,
  ].join("\n");

  const message = await twilioClient.messages.create({
    to: tenant.dispatcherPhone,
    from: tenant.twilioNumber,
    body,
  });

  await db.smsThread.create({
    data: {
      tenantId: tenant.id,
      conversationId,
      jobId: job.id,
      to: tenant.dispatcherPhone,
      purpose: SmsPurpose.DISPATCH_SELECTION,
      expiresAt: expiresFromNow(EXPIRY_MINUTES.DISPATCH_SELECTION),
      messages: {
        create: {
          direction: SmsDirection.OUTBOUND,
          body,
          twilioSid: message.sid,
        },
      },
    },
  });

  return { technicianCount: availableTechs.length };
}

// ── 4. Tech notification ──────────────────────────────────────────────────
//
// Fired after the dispatcher replies and we've assigned the tech.
// No SmsThread — we're not waiting for the tech to reply (yet).
// Phase 2 can add a tech acknowledgement thread if needed.
//
// The tech gets: job address, issue summary, and customer phone.
// Everything they need to show up and get started.

export async function sendTechNotification(
  tenant: Tenant,
  tech: Technician,
  job: Job,
  contact: Contact,
): Promise<void> {
  if (!tenant.twilioNumber) {
    throw new Error(`Tenant ${tenant.id} has no twilioNumber — cannot send SMS`);
  }

  const body = [
    `New job assigned — ${tenant.name}`,
    ``,
    `Address: ${job.address}${job.city ? `, ${job.city}` : ""}`,
    `Issue: ${job.description}`,
    `Customer: ${contact.name ?? "Unknown"} — ${contact.phone}`,
  ].join("\n");

  await twilioClient.messages.create({
    to: tech.phone,
    from: tenant.twilioNumber,
    body,
  });
}