-- CreateEnum
CREATE TYPE "SmsPurpose" AS ENUM ('ADDRESS_CONFIRMATION', 'DISPATCH_SELECTION');

-- CreateEnum
CREATE TYPE "SmsThreadStatus" AS ENUM ('AWAITING_REPLY', 'COMPLETED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "SmsDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "dispatcherPhone" TEXT;

-- CreateTable
CREATE TABLE "sms_threads" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "purpose" "SmsPurpose" NOT NULL,
    "status" "SmsThreadStatus" NOT NULL DEFAULT 'AWAITING_REPLY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "sms_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_messages" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "direction" "SmsDirection" NOT NULL,
    "body" TEXT NOT NULL,
    "twilioSid" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sms_threads_tenantId_idx" ON "sms_threads"("tenantId");

-- CreateIndex
CREATE INDEX "sms_threads_to_status_idx" ON "sms_threads"("to", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sms_threads_jobId_to_purpose_key" ON "sms_threads"("jobId", "to", "purpose");

-- CreateIndex
CREATE INDEX "sms_messages_threadId_idx" ON "sms_messages"("threadId");

-- AddForeignKey
ALTER TABLE "sms_threads" ADD CONSTRAINT "sms_threads_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_threads" ADD CONSTRAINT "sms_threads_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_threads" ADD CONSTRAINT "sms_threads_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "sms_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
