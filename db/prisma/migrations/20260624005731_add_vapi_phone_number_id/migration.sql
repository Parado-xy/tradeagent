/*
  Warnings:

  - A unique constraint covering the columns `[vapiPhoneNumberId]` on the table `tenants` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "vapiPhoneNumberId" TEXT,
ALTER COLUMN "twilioNumber" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "tenants_vapiPhoneNumberId_key" ON "tenants"("vapiPhoneNumberId");
