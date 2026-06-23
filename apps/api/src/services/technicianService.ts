// apps/api/src/services/technicianService.ts

import {
  PrismaClient,
  TechnicianStatus,
  TradeType,
} from "../../../../db/generated/client";

// ── listTechnicians ───────────────────────────────────────────
export async function listTechnicians(
  db: PrismaClient,
  options: { status?: string } = {},
) {
  const where: any = {};

  if (options.status) {
    where.status = options.status as TechnicianStatus;
  }

  return db.technician.findMany({
    where,
    include: {
      _count: { select: { jobs: true } },
    },
    orderBy: { name: "asc" },
  });
}

// ── getTechnician ─────────────────────────────────────────────
export async function getTechnician(db: PrismaClient, technicianId: string) {
  return db.technician.findUnique({
    where: { id: technicianId },
    include: {
      jobs: {
        where: {
          status: { in: ["PENDING", "DISPATCHED", "EN_ROUTE", "ON_SITE"] },
        },
        include: { contact: true },
        orderBy: { scheduledAt: "asc" },
      },
    },
  });
}

// ── createTechnician ──────────────────────────────────────────
export async function createTechnician(
  db: PrismaClient,
  data: {
    tenantId: string;
    name: string;
    phone: string;
    skillTags: string[];
  },
) {
  return db.technician.create({
    data: {
      tenantId: data.tenantId,
      name: data.name,
      phone: data.phone,
      skillTags: data.skillTags as TradeType[],
    },
  });
}

// ── updateTechnician ──────────────────────────────────────────
export async function updateTechnician(
  db: PrismaClient,
  technicianId: string,
  data: {
    name?: string;
    phone?: string;
    skillTags?: string[];
    status?: string;
  },
) {
  const existing = await db.technician.findUnique({
    where: { id: technicianId },
  });
  if (!existing) return null;

  return db.technician.update({
    where: { id: technicianId },
    data: {
      ...(data.name && { name: data.name }),
      ...(data.phone && { phone: data.phone }),
      ...(data.skillTags && { skillTags: data.skillTags as TradeType[] }),
      ...(data.status && { status: data.status as TechnicianStatus }),
    },
  });
}

// ── deleteTechnician ──────────────────────────────────────────
// Blocks deletion if the technician has active jobs.
export async function deleteTechnician(db: PrismaClient, technicianId: string) {
  const existing = await db.technician.findUnique({
    where: { id: technicianId },
    include: {
      _count: { select: { jobs: true } },
    },
  });

  if (!existing) return null;

  if (existing._count.jobs > 0) {
    throw Object.assign(
      new Error(
        `Cannot delete technician with ${existing._count.jobs} job(s) on record`,
      ),
      { statusCode: 409 },
    );
  }

  return db.technician.delete({ where: { id: technicianId } });
}
