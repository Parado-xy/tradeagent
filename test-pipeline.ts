import { PrismaClient } from "./db/generated/client";
import { transcribeAndBuildLineItems } from "./apps/api/src/services/transcriptionService";
import dotenv from "dotenv";

dotenv.config();

const db = new PrismaClient();

async function run() {
  console.log("🚀 Testing transcription and price book matching pipeline...");
  
  // Find the seeded tenant
  const tenant = await db.tenant.findFirst({
    where: { name: "Mike's Plumbing & Drain" }
  });
  
  if (!tenant) {
    console.error("❌ Seeded tenant not found. Make sure to run 'npm run db:seed' first.");
    process.exit(1);
  }
  
  console.log(`Found Tenant: ${tenant.name} (${tenant.id})`);
  
  // A standard audio sample containing human speech or audio (w3schools horse sound)
  const audioUrl = "https://www.w3schools.com/html/horse.mp3";
  console.log(`Sending audio URL: ${audioUrl}`);
  
  try {
    const result = await transcribeAndBuildLineItems(db, tenant.id, audioUrl);
    console.log("\n✅ Pipeline executed successfully!");
    console.log("\n--- Transcript ---");
    console.log(result.transcript);
    console.log("\n--- Extracted & Matched Line Items ---");
    console.log(JSON.stringify(result.lineItems, null, 2));
    console.log(`\nNeeds Review: ${result.needsReview}`);
  } catch (error) {
    console.error("❌ Pipeline failed with error:", error);
  } finally {
    await db.$disconnect();
  }
}

run();
