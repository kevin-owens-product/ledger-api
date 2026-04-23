import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { env } from './config/env.js';
import { AppError, errorPayload } from './lib/errors.js';
import { prisma } from './lib/prisma.js';
import { authenticateRequest } from './middleware/auth.js';
import { loggingPlugin } from './plugins/logging.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerInvoiceRoutes } from './routes/v1/invoices.js';
import { registerLineItemRoutes } from './routes/v1/line-items.js';
import { registerGLCodingRoutes } from './routes/v1/gl-coding.js';
import { registerApprovalPoliciesRoutes } from './routes/v1/approval-policies.js';
import { registerApprovalRoutes } from './routes/v1/approval.js';
import { registerVendorRoutes } from './routes/v1/vendors.js';

const app = Fastify({
  logger: {
    level: env.LOG_LEVEL,
  },
});

await app.register(sensible);
await app.register(cors);
await app.register(helmet);
await app.register(loggingPlugin);

await registerHealthRoutes(app);

app.register(async (protectedRoutes) => {
  protectedRoutes.addHook('onRequest', authenticateRequest);
  await registerInvoiceRoutes(protectedRoutes);
  await registerLineItemRoutes(protectedRoutes);
  await registerGLCodingRoutes(protectedRoutes);
  await registerApprovalPoliciesRoutes(protectedRoutes);
  await registerApprovalRoutes(protectedRoutes);
  await registerVendorRoutes(protectedRoutes);
});

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof AppError) {
    reply.status(error.statusCode).send(errorPayload(error.code, error.message, error.details));
    return;
  }

  if ('issues' in (error as object)) {
    reply.status(400).send(errorPayload('VALIDATION_ERROR', 'Request validation failed', (error as { issues: unknown }).issues));
    return;
  }

  app.log.error({ err: error }, 'unhandled_error');
  reply.status(500).send(errorPayload('INTERNAL_SERVER_ERROR', 'Internal server error'));
});

const shutdownSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
for (const signal of shutdownSignals) {
  process.on(signal, async () => {
    app.log.info({ signal }, 'shutdown_signal_received');
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

const address = await app.listen({ port: env.PORT, host: '0.0.0.0' });
app.log.info({ address }, 'ledger_api_started');
