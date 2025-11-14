import { PrismaClient } from '@prisma/client';

const prismaGlobal = globalThis as unknown as { prisma?: PrismaClient };

const enableQueryLog = process.env.PRISMA_LOG_QUERIES === '1';
const clientOptions: any = enableQueryLog
  ? { log: [{ emit: 'event', level: 'query' as const }, { emit: 'event', level: 'error' as const }] }
  : {};

export const db = prismaGlobal.prisma ?? new PrismaClient(clientOptions);

if (enableQueryLog) {
  (db as any).$on('query', (e: any) => {
    // e.duration is in ms
    console.log(`[prisma] ${e.duration}ms`, e.query);
  });
  (db as any).$on('error', (e: any) => {
    console.error('[prisma:error]', e);
  });
}

if (process.env.NODE_ENV !== 'production') {
  prismaGlobal.prisma = db;
}
