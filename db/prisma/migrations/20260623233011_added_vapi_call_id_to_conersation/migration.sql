-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "vapiCallId" TEXT;

-- CreateIndex
CREATE INDEX "conversations_vapiCallId_idx" ON "conversations"("vapiCallId");
