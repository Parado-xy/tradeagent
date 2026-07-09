// apps/api/src/services/transcriptionService.ts
//
// Pipeline: audio URL → Whisper transcript → Claude extracts
// line items → fuzzy match against tenant price book → InvoiceLineItem[]
//
// This is its own file because it has two external dependencies
// (OpenAI Whisper + Claude) and needs to be independently testable.
// When you swap Whisper for a faster model, you change this file only.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { PrismaClient } from "../../../../db/generated/client";

const anthropic = new Anthropic();
const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});


export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
  priceBookItemId?: string; // set if we matched to a known item
  matchConfidence?: number; // 0-1, flags low confidence for operator review
}

// ── Main pipeline ─────────────────────────────────────────────
export async function transcribeAndBuildLineItems(
  db: PrismaClient,
  tenantId: string,
  audioUrl: string,
): Promise<{
  transcript: string;
  lineItems: InvoiceLineItem[];
  needsReview: boolean;
}> {
  const transcript = await transcribeAudio(audioUrl);

  const priceBook = await db.priceBookItem.findMany({
    where: { tenantId, active: true },
    select: { id: true, description: true, category: true, flatRate: true },
  });

  const lineItems = await extractLineItems(transcript, priceBook);

  // Flag for operator review if any match is uncertain
  const needsReview = lineItems.some(
    (item) => (item.matchConfidence ?? 1) < 0.7,
  );

  return { transcript, lineItems, needsReview };
}

// ── Whisper transcription ─────────────────────────────────────
async function transcribeAudio(audioUrl: string): Promise<string> {
  const audioResponse = await fetch(audioUrl);

  if (!audioResponse.ok) {
    throw Object.assign(new Error(`Failed to fetch audio from ${audioUrl}`), {
      statusCode: 502,
    });
  }

  const audioBuffer = await audioResponse.arrayBuffer();
  const audioFile = new File([audioBuffer], "recording.mp3", {
    type: "audio/mpeg",
  });

  const response = await openai.audio.transcriptions.create({
    file: audioFile,
    model: "whisper-1",
    language: "en",
    // Priming Whisper with trades vocabulary reduces transcription errors
    // on words like "flapper", "P-trap", "wax ring", "sump pump"
    prompt:
      "Plumbing service call. Terms: fill valve, flapper, P-trap, " +
      "shutoff valve, water heater, drain snake, auger, wax ring, sump pump.",
  });

  return response.text;
}

// ── Line item extraction ──────────────────────────────────────
async function extractLineItems(
  transcript: string,
  priceBook: Array<{
    id: string;
    description: string;
    category: string | null;
    flatRate: number;
  }>,
): Promise<InvoiceLineItem[]> {
  const priceBookContext = priceBook
    .map((item) => `ID:${item.id} | "${item.description}" | $${item.flatRate}`)
    .join("\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: `You are a trades invoice assistant. Extract billable work items
from a technician's voice recording and match them to the price book.
Return ONLY a JSON array, no explanation, no markdown.

PRICE BOOK:
${priceBookContext}

Rules:
- Match each work item to the closest price book entry
- If no match exists, set unitPrice to 0 and priceBookItemId to null
- quantity is 1 unless the tech explicitly states otherwise
- matchConfidence: 1.0 = exact, 0.7 = close, 0.0 = no match
- Always recalculate total as quantity * unitPrice

Return format:
[{ "description": "", "quantity": 1, "unitPrice": 0, "total": 0, "priceBookItemId": null, "matchConfidence": 0 }]`,
    messages: [{ role: "user", content: `Transcript: "${transcript}"` }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "[]";

  try {
    const items = JSON.parse(text.trim()) as InvoiceLineItem[];
    // Recalculate totals server-side — never trust LLM arithmetic
    return items.map((item) => ({
      ...item,
      total: Math.round(item.quantity * item.unitPrice * 100) / 100,
    }));
  } catch {
    console.error("[transcriptionService] Failed to parse response:", text);
    return [];
  }
}
