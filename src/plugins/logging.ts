import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

export const loggingPlugin = fp(async (fastify: FastifyInstance) => {
  fastify.addHook('onRequest', async (request) => {
    request.headers['x-request-start'] = Date.now().toString();
  });

  fastify.addHook('onResponse', async (request, reply) => {
    const startedAtRaw = request.headers['x-request-start'];
    const startedAt = typeof startedAtRaw === 'string' ? Number.parseInt(startedAtRaw, 10) : Date.now();
    const latencyMs = Date.now() - startedAt;

    fastify.log.info(
      {
        method: request.method,
        url: request.url,
        tenantId: request.auth?.tenant.id ?? null,
        statusCode: reply.statusCode,
        latencyMs,
      },
      'request_completed',
    );
  });
});
