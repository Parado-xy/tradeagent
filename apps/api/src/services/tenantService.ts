import { PrismaClient } from "../../../../db/generated/client";

// Simple service layer (expand later)
export async function getTenantDashboard(db: PrismaClient, tenantId: string) {
  const [tenant, activeJobs, technicians, recentInvoices] = await Promise.all([
    db.tenant.findUnique({ where: { id: tenantId } }),
    db.job.count({
      where: { tenantId, status: { in: ["PENDING", "DISPATCHED"] } },
    }),
    db.technician.findMany({
      where: { tenantId, status: "AVAILABLE" },
      select: { id: true, name: true, status: true },
    }),
    db.invoice.findMany({
      where: { tenantId, status: "PAID" },
      orderBy: { paidAt: "desc" },
      take: 5,
      include: { job: true },
    }),
  ]);

  return {
    tenant: { id: tenant?.id, name: tenant?.name, plan: tenant?.plan },
    stats: {
      activeJobs,
      availableTechs: technicians.length,
      revenueThisMonth: 0, // TODO: calculate properly
    },
    technicians,
    recentActivity: recentInvoices,
  };
}
