// apps/api/src/services/authService.ts
import { PrismaClient } from "../../../../db/generated/client";
import bcrypt from "bcryptjs";

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  phoneNumber: string;
  dispatcherPhone: string;
}

export async function registerTenant(db: PrismaClient, input: RegisterInput) {
  const existing = await db.tenant.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new Error("Email already registered");
  }

  const hashedPassword = await bcrypt.hash(input.password, 12);

  const tenant = await db.tenant.create({
    data: {
      name: input.name,
      email: input.email,
      password: hashedPassword,
      phoneNumber: input.phoneNumber,
      dispatcherPhone: input.dispatcherPhone,
      plan: "ALPHA",
    },
  });

  return tenant;
}