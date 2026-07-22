// apps/api/src/services/provisioningService.ts
//
// Orchestrates tenant creation: buys a Twilio number, imports it into
// VAPI, links it to the shared assistant, then persists the Tenant row.
//
// Order matters and is NOT atomic across external services — Twilio
// and VAPI don't participate in our Postgres transaction. If a later
// step fails, we roll back the earlier external side effects (release
// the Twilio number) rather than leaving orphaned billable resources.

import {PrismaClient, Plan} from "../../../../db/generated/client";
import twilio from "twilio";

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const VAPI_API_BASE = "https://api.vapi.ai";

interface ProvisionTenantInput {
  name: string;
  phoneNumber: string; // their real business number
  dispatcherPhone: string;
  areaCode?: string; // optional preference for the new Twilio number
  plan?: Plan;
}

interface ProvisionResult {
  tenant: Awaited<ReturnType<PrismaClient["tenant"]["create"]>>;
}

export async function provisionTenant(
  db: PrismaClient,
  input: ProvisionTenantInput
): Promise<ProvisionResult> {
  // ── Step 1: Buy a Twilio number ─────────────────────────
  const twilioNumber = await purchaseTwilioNumber(input.areaCode);

  let vapiPhoneNumberId: string;
  try {
    // ── Step 2: Import it into VAPI + attach the assistant ──
    vapiPhoneNumberId = await importNumberToVapi(twilioNumber, input.name);
  } catch (err) {
    // Roll back the Twilio purchase so we're not paying for an
    // orphaned number nobody can use.
    await releaseTwilioNumber(twilioNumber);
    throw err;
  }

  try {
    // ── Step 3: Persist the Tenant ───────────────────────────
    const tenant = await db.tenant.create({
      data: {
        name: input.name,
        phoneNumber: input.phoneNumber,
        dispatcherPhone: input.dispatcherPhone,
        twilioNumber,
        vapiPhoneNumberId,
        plan: input.plan ?? Plan.ALPHA,
      },
    });

    return { tenant };
  } catch (err) {
    // DB write failed after both external resources were created —
    // roll back both so we don't leak a live, unassigned phone number.
    await releaseVapiNumber(vapiPhoneNumberId);
    await releaseTwilioNumber(twilioNumber);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// Twilio
// ─────────────────────────────────────────────────────────────

async function purchaseTwilioNumber(areaCode?: string): Promise<string> {
  const available = await twilioClient
    .availablePhoneNumbers("US")
    .local.list({
      areaCode: areaCode ? Number(areaCode) : undefined,
      voiceEnabled: true,
      smsEnabled: true,
      limit: 1,
    });

  if (available.length === 0) {
    throw new Error(
      `No available Twilio numbers found${areaCode ? ` for area code ${areaCode}` : ""}`
    );
  }

  const purchased = await twilioClient.incomingPhoneNumbers.create({
    phoneNumber: available[0].phoneNumber,
  });

  return purchased.phoneNumber;
}

async function releaseTwilioNumber(phoneNumber: string): Promise<void> {
  try {
    const numbers = await twilioClient.incomingPhoneNumbers.list({
      phoneNumber,
      limit: 1,
    });
    if (numbers[0]) {
      await twilioClient.incomingPhoneNumbers(numbers[0].sid).remove();
    }
  } catch (err) {
    // Log and swallow — rollback best-effort, don't mask the original error
    console.error(`Failed to release Twilio number ${phoneNumber}:`, err);
  }
}

// ─────────────────────────────────────────────────────────────
// VAPI
// ─────────────────────────────────────────────────────────────


async function importNumberToVapi(
  twilioNumber: string,
  tenantName: string
): Promise<string> {
  const response = await fetch(`${VAPI_API_BASE}/phone-number`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      provider: "twilio",
      number: twilioNumber,
      twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
      twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
      // NO assistantId here — leaving it unset forces VAPI to send an
      // assistant-request webhook to our serverUrl on every inbound call,
      // which is required for per-call customer recognition, business-hours
      // branching, and the transfer/fallback logic to work at all.
      // (See handleAssistantRequest in vapi.ts.)
      name: tenantName.slice(0, 40),
      smsEnabled: false,
    }),
  });

  // TODO: Twilio provisioned numbers may take a second to dully be available. 
  // Should we look into a backoff and retry strategy for this? 
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`VAPI number import failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {id: string};
  return data.id as string;
}

async function releaseVapiNumber(vapiPhoneNumberId: string): Promise<void> {
  try {
    await fetch(`${VAPI_API_BASE}/phone-number/${vapiPhoneNumberId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
    });
  } catch (err) {
    console.error(`Failed to release VAPI number ${vapiPhoneNumberId}:`, err);
  }
}