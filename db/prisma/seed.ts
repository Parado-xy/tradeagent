// db/prisma/seed.ts
//
// This file populates your local development database with realistic
// data so you can run the app and see something meaningful immediately.
//
// It is NEVER run in production. It's a dev tool only.
//
// Run it with: npx prisma db seed
// (We'll configure that command in the root package.json later)

import { PrismaClient, TradeType, Plan } from "../generated/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding TradeAgent dev database...");

  // ── Tenant ─────────────────────────────────────────────────
  // upsert means: if this record already exists, update it.
  // If it doesn't, create it.
  // This makes the seed idempotent — you can run it multiple
  // times without getting duplicate data or errors.
  const tenant = await prisma.tenant.upsert({
    where: { twilioNumber: "+15040000001" },
    update: {},
    create: {
      name: "Mike's Plumbing & Drain",
      phoneNumber: "+15045550100", // Mike's real business number
      twilioNumber: "+15040000001", // the number we provision
      plan: Plan.ALPHA,
    },
  });
  console.log(`  ✓ Tenant: ${tenant.name} (${tenant.id})`);

  // ── Technician ─────────────────────────────────────────────
  const tech = await prisma.technician.upsert({
    where: { id: "seed-tech-001" },
    update: {},
    create: {
      id: "seed-tech-001",
      tenantId: tenant.id,
      name: "Carlos Reyes",
      phone: "+15045550199",
      skillTags: [TradeType.PLUMBING],
    },
  });
  console.log(`  ✓ Technician: ${tech.name}`);

  // ── Contact ────────────────────────────────────────────────
  // A sample homeowner who has called in before.
  const contact = await prisma.contact.upsert({
    where: {
      tenantId_phone: {
        tenantId: tenant.id,
        phone: "+15045550177",
      },
    },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Sandra Williams",
      phone: "+15045550177",
      address: "4821 Magazine St",
      city: "New Orleans",
      state: "LA",
      zip: "70115",
    },
  });
  console.log(`  ✓ Contact: ${contact.name}`);

  // ── Price book ─────────────────────────────────────────────
  // Real flat-rate plumbing prices. These are the items the
  // AI will match against when a tech dictates their work.
  // The IDs are hardcoded so the seed is idempotent.
  const priceBookItems = [
    {
      id: "seed-pb-001",
      code: "PLB-001",
      description: "Clear main line drain — standard access",
      category: "Drain Cleaning",
      tradeType: TradeType.PLUMBING,
      laborCost: 95,
      partsCost: 0,
      flatRate: 189,
    },
    {
      id: "seed-pb-002",
      code: "PLB-002",
      description: "Water heater replacement — 40 gal gas",
      category: "Water Heater",
      tradeType: TradeType.PLUMBING,
      laborCost: 250,
      partsCost: 480,
      flatRate: 1095,
    },
    {
      id: "seed-pb-003",
      code: "PLB-003",
      description: "Toilet rebuild — fill valve and flapper",
      category: "Toilet",
      tradeType: TradeType.PLUMBING,
      laborCost: 75,
      partsCost: 35,
      flatRate: 195,
    },
    {
      id: "seed-pb-004",
      code: "PLB-004",
      description: "Emergency leak stop — slab or wall",
      category: "Emergency",
      tradeType: TradeType.PLUMBING,
      laborCost: 195,
      partsCost: 50,
      flatRate: 395,
    },
    {
      id: "seed-pb-005",
      code: "PLB-005",
      description: "Garbage disposal replacement — standard",
      category: "Kitchen",
      tradeType: TradeType.PLUMBING,
      laborCost: 85,
      partsCost: 120,
      flatRate: 325,
    },
  ];

  for (const item of priceBookItems) {
    await prisma.priceBookItem.upsert({
      where: { id: item.id },
      update: {},
      create: { tenantId: tenant.id, ...item },
    });
  }
  console.log(`  ✓ Price book: ${priceBookItems.length} items`);

  console.log("\n✅ Seed complete.");
  console.log("   Run `npx prisma studio` to browse your data.");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
