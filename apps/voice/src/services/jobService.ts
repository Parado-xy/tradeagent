// apps/voice/src/services/jobService.ts
//
// Creates a job from a completed call or SMS.
// Called after triage classification confirms a job is warranted.

import { PrismaClient, JobStatus, TradeType, TriageTier } from '../../../../db/generated/client'

export async function createJobFromCall(
  db: PrismaClient,
  data: {
    tenantId: string
    contactId: string
    conversationId: string
    triageTier: TriageTier
    description: string
    tradeType: TradeType
    address: string
    city?: string
    state?: string
    zip?: string
  }
) {
  // Emergency jobs get scheduled immediately (now).
  // Everything else goes into the queue without a scheduled time
  // so the operator can place it on the dispatch board manually.
  const scheduledAt =
    data.triageTier === TriageTier.EMERGENCY ? new Date() : undefined

  return db.job.create({
    data: {
      tenantId: data.tenantId,
      contactId: data.contactId,
      conversationId: data.conversationId,
      tradeType: data.tradeType,
      description: data.description,
      address: data.address,
      city: data.city,
      state: data.state,
      zip: data.zip,
      status: JobStatus.PENDING,
      scheduledAt,
    },
    include: { contact: true },
  })
}