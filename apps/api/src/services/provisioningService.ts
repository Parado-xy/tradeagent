// apps/api/src/services/provisioningService.ts
// Updated for two-step: register first → activate provisioning later.

import { PrismaClient, Plan } from "../../../../db/generated/client";
import twilio from "twilio";

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

const VAPI_API_BASE = "https://api.vapi.ai";

export interface ProvisionTenantInput {
  tenantId: string; // NEW: from registered tenant
  areaCode?: string;
}

export interface ProvisionResult {
  tenant: any; // Prisma Tenant
}

export async function activateProvisioning(
  db: PrismaClient,
  input: ProvisionTenantInput,
): Promise<ProvisionResult> {
  const tenant = await db.tenant.findUnique({ where: { id: input.tenantId } });
  if (!tenant) throw new Error("Tenant not found");

  // Step 1: Buy Twilio number
  const twilioNumber = await purchaseTwilioNumber(input.areaCode);

  let vapiPhoneNumberId: string;
  try {
    vapiPhoneNumberId = await importNumberToVapi(twilioNumber, tenant.name);
  } catch (err) {
    await releaseTwilioNumber(twilioNumber);
    throw err;
  }

  try {
    // Step 2: Update existing tenant
    const updatedTenant = await db.tenant.update({
      where: { id: input.tenantId },
      data: {
        twilioNumber,
        vapiPhoneNumberId,
      },
    });

    return { tenant: updatedTenant };
  } catch (err) {
    await releaseVapiNumber(vapiPhoneNumberId);
    await releaseTwilioNumber(twilioNumber);
    throw err;
  }
}

// ... (keep your existing purchaseTwilioNumber, releaseTwilioNumber, importNumberToVapi, releaseVapiNumber helpers)
// ─────────────────────────────────────────────────────────────
// Twilio
// ─────────────────────────────────────────────────────────────

async function purchaseTwilioNumber(areaCode?: string): Promise<string> {
  const available = await twilioClient.availablePhoneNumbers("US").local.list({
    areaCode: areaCode ? Number(areaCode) : undefined,
    voiceEnabled: true,
    smsEnabled: true,
    limit: 1,
  });

  if (available.length === 0) {
    throw new Error(
      `No available Twilio numbers found${areaCode ? ` for area code ${areaCode}` : ""}`,
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
  tenantName: string,
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

  const data = (await response.json()) as { id: string };
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
