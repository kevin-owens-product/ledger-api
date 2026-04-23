import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { getQueueDepth } from '../lib/queue.js';

export async function registerHealthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/health', async () => ({ status: 'ok' }));

  fastify.get('/v1/status', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      const queueDepth = await getQueueDepth();

      return {
        status: 'ready',
        checks: {
          db: 'ok',
          queueDepth,
        },
      };
    } catch (error) {
      reply.status(503);
      return {
        status: 'not_ready',
        checks: {
          db: 'error',
        },
        error: error instanceof Error ? error.message : 'unknown_error',
      };
    }
  });
}
