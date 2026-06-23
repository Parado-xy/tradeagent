// apps/api/src/services/contactService.ts
//
// All business logic for contacts.
// Receives the db client as a parameter — never imports it directly.
// This makes every function independently testable without a real database.

import { PrismaClient } from "../../../../db/generated/client";

// ── Helpers ───────────────────────────────────────────────────
// Normalize any phone format to E.164: +15045550100
// Handles: (504) 555-0100 / 504-555-0100 / 5045550100
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

// ── findOrCreateContact ───────────────────────────────────────
// Called on every inbound call by the voice service.
// If the contact exists: merge in any new fields.
// If not: create them with whatever we have from the call.
// Phone + tenantId is the unique key — never email.
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

  // Only overwrite fields that are actually present in this call.
  // A second call without an address should not blank out the
  // address we captured on the first call.
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

// ── listContacts ──────────────────────────────────────────────
export async function listContacts(
  db: PrismaClient,
  options: { search?: string; limit?: number; offset?: number } = {},
) {
  const { search, limit = 50, offset = 0 } = options;

  const where: any = {};

  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { phone: { contains: search } },
      { address: { contains: search, mode: "insensitive" } },
    ];
  }

  const [contacts, total] = await db.$transaction([
    db.contact.findMany({
      where,
      include: {
        _count: { select: { jobs: true, conversations: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    db.contact.count({ where }),
  ]);

  return { contacts, total, limit, offset };
}

// ── getContact ────────────────────────────────────────────────
export async function getContact(db: PrismaClient, contactId: string) {
  return db.contact.findUnique({
    where: { id: contactId },
    include: {
      jobs: {
        orderBy: { createdAt: "desc" },
        take: 10,
        include: {
          technician: { select: { id: true, name: true } },
          invoice: { select: { id: true, status: true, total: true } },
        },
      },
      conversations: {
        orderBy: { startedAt: "desc" },
        take: 5,
      },
    },
  });
}

// ── updateContact ─────────────────────────────────────────────
export async function updateContact(
  db: PrismaClient,
  contactId: string,
  data: {
    name?: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
  },
) {
  const existing = await db.contact.findUnique({ where: { id: contactId } });
  if (!existing) return null;

  return db.contact.update({ where: { id: contactId }, data });
}

// ── deleteContact ─────────────────────────────────────────────
// Blocks deletion if the contact has jobs on record.
// You never want orphaned job history.
export async function deleteContact(db: PrismaClient, contactId: string) {
  const existing = await db.contact.findUnique({
    where: { id: contactId },
    include: { _count: { select: { jobs: true } } },
  });

  if (!existing) return null;

  if (existing._count.jobs > 0) {
    throw Object.assign(
      new Error(
        `Cannot delete contact with ${existing._count.jobs} job(s) on record`,
      ),
      { statusCode: 409 },
    );
  }

  return db.contact.delete({ where: { id: contactId } });
}
