-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "businessHourStart" INTEGER,
ADD COLUMN     "businessHoursEnd" INTEGER,
ADD COLUMN     "timezone" TEXT;
