// apps/voice/src/services/contactService.ts
//
// Thin re-export of the contact upsert logic.
// Identical behaviour to the API contact service —
// kept separate so the voice app has no dependency on the API app.

import { PrismaClient } from "../../../../db/generated/client";

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export async function findOrCreateContact(
  db: PrismaClient,
  tenantId: string,
  input: {
    phone: string;
    name?: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
  },
) {
  const phone = normalizePhone(input.phone);

  const updateData: Record<string, string> = {};
  if (input.name) updateData.name = input.name;
  if (input.address) updateData.address = input.address;
  if (input.city) updateData.city = input.city;
  if (input.state) updateData.state = input.state;
  if (input.zip) updateData.zip = input.zip;

  return db.contact.upsert({
    where: { tenantId_phone: { tenantId, phone } },
    update: updateData,
    create: { ...input, tenantId, phone },
  });
}
