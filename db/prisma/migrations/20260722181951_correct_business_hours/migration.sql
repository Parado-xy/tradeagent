/*
  Warnings:

  - You are about to drop the column `businessHourStart` on the `tenants` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "tenants" DROP COLUMN "businessHourStart",
ADD COLUMN     "businessHoursStart" INTEGER;
