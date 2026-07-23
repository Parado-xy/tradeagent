import { PrismaClient } from "../../../../db/generated/client";

export async function getTenantDashboard(db: PrismaClient, tenantId: string) {
  const [
    tenant,
    activeJobs,
    totalJobsThisMonth,
    availableTechs,
    recentInvoices,
    openSmsThreads,
  ] = await Promise.all([
    db.tenant.findUnique({ where: { id: tenantId } }),
    db.job.count({
      where: {
        tenantId,
        status: { in: ["PENDING", "DISPATCHED", "EN_ROUTE", "ON_SITE"] },
      },
    }),
    db.job.count({
      where: {
        tenantId,
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
    }),
    db.technician.count({ where: { tenantId, status: "AVAILABLE" } }),
    db.invoice.findMany({
      where: { tenantId, status: "PAID" },
      orderBy: { paidAt: "desc" },
      take: 5,
      include: { job: { include: { contact: true } } },
    }),
    db.smsThread.count({ where: { tenantId, status: "AWAITING_REPLY" } }),
  ]);

  return {
    tenant: {
      id: tenant?.id,
      name: tenant?.name,
      email: tenant?.email,
      plan: tenant?.plan,
    },
    stats: {
      activeJobs,
      jobsThisMonth: totalJobsThisMonth,
      availableTechs,
      openThreads: openSmsThreads,
      monthlyRevenue: 0, // TODO: sum from invoices
    },
    technicians: await db.technician.findMany({ where: { tenantId } }),
    recentInvoices,
  };
}