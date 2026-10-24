import { PrismaClient } from "@prisma/client";

// Singleton so Next.js dev-mode hot reloads don't exhaust SQLite connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}

export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
