// apps/voice/src/services/triageService.ts
//
// Takes a call transcript or SMS text and returns a structured
// triage decision. This is the most important AI call in the system.
// It determines whether a job gets created and how urgently.
//
// Uses Vercel AI SDK's generateObject + Zod schema instead of raw
// anthropic SDK + JSON.parse. This gives us:
//   - Automatic retries on malformed responses (no markdown fence hacks)
//   - Zod validation with full TypeScript inference
//   - Cleaner code — no manual extraction or casting needed
//
// Used by both the voice and SMS routes — same logic, different input.

import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { TriageTier, TradeType } from "../../../../db/generated/client";

const anthropic = createAnthropic();

// ── Zod schema ────────────────────────────────────────────────
// Single source of truth for the shape of a triage result.
// Zod infers the TypeScript type — no duplicate interface needed.

const TriageSchema = z.object({
  tier: z.enum(["EMERGENCY", "URGENT", "ROUTINE", "ESTIMATE"]),
  tradeType: z.enum(["PLUMBING", "HVAC", "ELECTRICAL", "GENERAL"]),
  summary: z
    .string()
    .describe("1-2 sentences describing the issue for the technician"),
  customerName: z
    .string()
    .describe("The name of the customer collected"),
  address: z
    .string()
    .describe("The address of the customer"),
  city: z.string().describe("The city as extracted from the given address"),
  state: z.string().describe("The state as extracted from the given address"),
  shouldCreateJob: z.boolean(),
  confidence: z.number().min(0).max(1),
});

// Inferred from the Zod schema — no manual interface to keep in sync
export type TriageResult = z.infer<typeof TriageSchema>;

export async function classifyTriage(input: string): Promise<TriageResult> {
  // Short input = caller hung up or sent a blank SMS
  if (!input || input.trim().length < 10) {
    return {
      tier: TriageTier.ROUTINE,
      tradeType: TradeType.GENERAL,
      summary: "No description provided.",
      address: "No address provided",
      customerName: "No name provided",
      shouldCreateJob: false,
      confidence: 1,
    };
  }

  try {
    const { object } = await generateObject({
      // TODO: Move model name to config
      model: anthropic("claude-haiku-4-5-20251001"),
      schema: TriageSchema,
      system: `You are a dispatcher for a residential trades company.
Analyze the input and classify the service request.

Triage rules:
EMERGENCY  — active water leak, sewage backup, gas smell, no heat with elderly/infant
URGENT     — significant leak, HVAC failure in extreme weather, only toilet not working
ROUTINE    — dripping faucet, slow drain, maintenance, minor issue
ESTIMATE   — customer wants a quote only, no active problem

shouldCreateJob = false ONLY when:
- caller hung up without describing a problem
- obvious spam or wrong number
- customer only wants a callback with no issue described`,
      prompt: input,
    });

    return object;
  } catch (err) {
    // Safe fallback — create a routine job so nothing is dropped silently
    console.error("[triageService] Classification failed:", err);
    return {
      tier: TriageTier.ROUTINE,
      tradeType: TradeType.PLUMBING,
      summary: "Triage classification failed — needs manual review.",
      address: "",
      customerName: "",
      shouldCreateJob: true,
      confidence: 0,
    };
  }
}
