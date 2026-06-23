// apps/api/src/services/jobService.ts

import {
  PrismaClient,
  JobStatus,
  TradeType,
} from "../../../../db/generated/client";

// ── listJobs ──────────────────────────────────────────────────
export async function listJobs(
  db: PrismaClient,
  options: {
    status?: string;
    technicianId?: string;
    date?: string;
  } = {},
) {
  const where: any = {};

  if (options.status) {
    where.status = options.status as JobStatus;
  }

  if (options.technicianId) {
    where.technicianId = options.technicianId;
  }

  if (options.date) {
    const start = new Date(options.date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(options.date);
    end.setHours(23, 59, 59, 999);
    where.scheduledAt = { gte: start, lte: end };
  }

  return db.job.findMany({
    where,
    include: {
      contact: true,
      technician: {
        select: { id: true, name: true, phone: true, status: true },
      },
      invoice: {
        select: { id: true, status: true, total: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

// ── getJob ────────────────────────────────────────────────────
export async function getJob(db: PrismaClient, jobId: string) {
  return db.job.findUnique({
    where: { id: jobId },
    include: {
      contact: true,
      conversation: true,
      technician: true,
      invoice: true,
    },
  });
}

// ── createJob ─────────────────────────────────────────────────
export async function createJob(
  db: PrismaClient,
  data: {
    tenantId: string;
    contactId: string;
    tradeType: string;
    description: string;
    address: string;
    city?: string;
    state?: string;
    zip?: string;
    scheduledAt?: string;
    conversationId?: string;
  },
) {
  return db.job.create({
    data: {
      tenantId: data.tenantId,
      contactId: data.contactId,
      tradeType: data.tradeType as TradeType,
      description: data.description,
      address: data.address,
      city: data.city,
      state: data.state,
      zip: data.zip,
      scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : undefined,
      conversationId: data.conversationId,
      status: JobStatus.PENDING,
    },
    include: { contact: true },
  });
}

// ── updateJob ─────────────────────────────────────────────────
export async function updateJob(
  db: PrismaClient,
  jobId: string,
  data: {
    status?: string;
    technicianId?: string;
    scheduledAt?: string;
    description?: string;
    completedAt?: string;
  },
) {
  const existing = await db.job.findUnique({ where: { id: jobId } });
  if (!existing) return null;

  return db.job.update({
    where: { id: jobId },
    data: {
      ...(data.status && { status: data.status as JobStatus }),
      ...(data.technicianId && { technicianId: data.technicianId }),
      ...(data.description && { description: data.description }),
      ...(data.scheduledAt && { scheduledAt: new Date(data.scheduledAt) }),
      ...(data.completedAt && { completedAt: new Date(data.completedAt) }),
    },
    include: { contact: true, technician: true },
  });
}

// ── dispatchJob ───────────────────────────────────────────────
// Assigns a technician and flips both the job and technician status.
// Wrapped in a transaction so both updates succeed or both fail.
// You never want a job marked DISPATCHED with no technician attached,
// or a technician marked DISPATCHED with no job.
export async function dispatchJob(
  db: PrismaClient,
  jobId: string,
  technicianId?: string,
) {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) {
    throw Object.assign(new Error("Job not found"), { statusCode: 404 });
  }

  if (job.status !== JobStatus.PENDING) {
    throw Object.assign(
      new Error(`Job is already ${job.status} — cannot dispatch again`),
      { statusCode: 409 },
    );
  }

  // If no technicianId provided, find first available tech with the right skill
  const assignedTechId =
    technicianId ?? (await findAvailableTech(db, job.tenantId, job.tradeType));

  if (!assignedTechId) {
    throw Object.assign(
      new Error("No available technician for this trade type"),
      { statusCode: 409 },
    );
  }

  // Transaction: update job + technician atomically
  const [updatedJob] = await db.$transaction([
    db.job.update({
      where: { id: jobId },
      data: { status: JobStatus.DISPATCHED, technicianId: assignedTechId },
      include: { contact: true, technician: true },
    }),
    db.technician.update({
      where: { id: assignedTechId },
      data: { status: "DISPATCHED" },
    }),
  ]);

  return updatedJob;
}

// ── findAvailableTech ─────────────────────────────────────────
// Phase 1: first available technician with the right skill tag.
// Phase 3: this gets replaced with proximity-based routing
// using currentLat/currentLng from the telematics worker.
async function findAvailableTech(
  db: PrismaClient,
  tenantId: string,
  tradeType: TradeType,
) {
  const tech = await db.technician.findFirst({
    where: {
      tenantId,
      status: "AVAILABLE",
      skillTags: { has: tradeType },
    },
  });

  return tech?.id ?? null;
}
