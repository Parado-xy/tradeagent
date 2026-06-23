// apps/voice/src/services/triageService.ts
//
// Takes a call transcript or SMS text and returns a structured
// triage decision. This is the most important AI call in the system.
// It determines whether a job gets created and how urgently.
//
// Used by both the voice and SMS routes — same logic, different input.

import Anthropic from "@anthropic-ai/sdk";
import { TriageTier, TradeType } from "../../../../db/generated/client";

const anthropic = new Anthropic();

export interface TriageResult {
  tier: TriageTier;
  tradeType: TradeType;
  summary: string; // 1-2 sentences for the job card
  shouldCreateJob: boolean;
  confidence: number; // 0-1, logged for future model improvement
}

export async function classifyTriage(input: string): Promise<TriageResult> {
  // Short input = caller hung up or sent a blank SMS
  if (!input || input.trim().length < 10) {
    return {
      tier: TriageTier.ROUTINE,
      tradeType: TradeType.GENERAL,
      summary: "No description provided.",
      shouldCreateJob: false,
      confidence: 1,
    };
  }

  try {
    const response = await anthropic.messages.create({
        // TODO: Remove the model name from being hard coded
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      system: `You are a dispatcher for a residential trades company.
Analyze the input and return ONLY valid JSON — no explanation, no markdown.

{
  "tier": "EMERGENCY" | "URGENT" | "ROUTINE" | "ESTIMATE",
  "tradeType": "PLUMBING" | "HVAC" | "ELECTRICAL" | "GENERAL",
  "summary": "1-2 sentences describing the issue for the technician",
  "shouldCreateJob": true | false,
  "confidence": 0.0-1.0
}

Triage rules:
EMERGENCY  — active water leak, sewage backup, gas smell, no heat with elderly/infant
URGENT     — significant leak, HVAC failure in extreme weather, only toilet not working
ROUTINE    — dripping faucet, slow drain, maintenance, minor issue
ESTIMATE   — customer wants a quote only, no active problem

shouldCreateJob = false ONLY when:
- caller hung up without describing a problem
- obvious spam or wrong number
- customer only wants a callback with no issue described`,
      messages: [{ role: "user", content: input }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    return JSON.parse(text.trim()) as TriageResult;
  } catch (err) {
    // Safe fallback — create a routine job so nothing is dropped silently
    console.error("[triageService] Classification failed:", err);
    return {
      tier: TriageTier.ROUTINE,
      tradeType: TradeType.PLUMBING,
      summary: "Triage classification failed — needs manual review.",
      shouldCreateJob: true,
      confidence: 0,
    };
  }
}
