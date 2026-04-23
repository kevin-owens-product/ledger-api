import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { VendorStatus } from '@prisma/client';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { WEBHOOK_QUEUE_NAME, webhookQueue } from './lib/queue.js';
import { APPROVAL_ESCALATION_QUEUE_NAME } from './lib/approval-queue.js';
import { signWebhookPayload } from './lib/webhook.js';
import { handleEscalation } from './services/approval-workflow.js';

const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

const worker = new Worker(
  WEBHOOK_QUEUE_NAME,
  async (job) => {
    if (job.name === 'verify-tin') {
      const vendorId = job.data.vendorId as string;
      const tenantId = job.data.tenantId as string;
      const taxId = (job.data.taxId as string | undefined) ?? '';

      const vendor = await prisma.vendor.findUnique({
        where: { id: vendorId },
        select: { id: true, tenantId: true },
      });

      if (!vendor || vendor.tenantId !== tenantId) {
        return;
      }

      const tinVerified = /^[0-9]{9}$/.test(taxId);

      await prisma.vendor.update({
        where: { id: vendorId },
        data: {
          status: tinVerified ? VendorStatus.active : VendorStatus.suspended,
        },
      });

      const event = await prisma.webhookEvent.create({
        data: {
          tenantId,
          eventType: tinVerified ? 'vendor.tin_verified' : 'vendor.tin_failed',
          payload: {
            vendorId,
            tinVerified,
          },
        },
      });

      await webhookQueue.add('deliver', { webhookEventId: event.id, tenantId });
      return;
    }

    const webhookEventId = job.data.webhookEventId as string;

    const event = await prisma.webhookEvent.findUnique({
      where: { id: webhookEventId },
      include: {
        tenant: {
          select: {
            webhookUrl: true,
            webhookSecret: true,
          },
        },
      },
    });

    if (!event) {
      return;
    }

    const attempts = event.attempts + 1;

    if (!event.tenant.webhookUrl || !event.tenant.webhookSecret) {
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: { attempts },
      });
      return;
    }

    const payloadJson = JSON.stringify({
      id: event.id,
      eventType: event.eventType,
      payload: event.payload,
      tenantId: event.tenantId,
      createdAt: event.createdAt,
    });

    const signature = signWebhookPayload(event.tenant.webhookSecret, payloadJson);

    try {
      const response = await fetch(event.tenant.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ledger-signature': signature,
        },
        body: payloadJson,
      });

      if (!response.ok) {
        throw new Error(`Webhook failed with status ${response.status}`);
      }

      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: {
          attempts,
          deliveredAt: new Date(),
        },
      });
    } catch (error) {
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: {
          attempts,
        },
      });

      if (attempts >= env.WEBHOOK_RETRY_LIMIT) {
        return;
      }

      throw error;
    }
  },
  {
    connection,
    concurrency: 4,
  },
);

worker.on('completed', (job) => {
  console.log(`Webhook job completed: ${job.id}`);
});

worker.on('failed', (job, error) => {
  console.error(`Webhook job failed: ${job?.id}`, error);
});

const escalationConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

const escalationWorker = new Worker(
  APPROVAL_ESCALATION_QUEUE_NAME,
  async (job) => {
    const { approvalId, stageIndex, tenantId, invoiceId } = job.data as {
      approvalId: string;
      stageIndex: number;
      tenantId: string;
      invoiceId: string;
    };
    await handleEscalation({ approvalId, stageIndex, tenantId, invoiceId });
  },
  {
    connection: escalationConnection,
    concurrency: 2,
  },
);

escalationWorker.on('completed', (job) => {
  console.log(`Escalation job completed: ${job.id}`);
});

escalationWorker.on('failed', (job, error) => {
  console.error(`Escalation job failed: ${job?.id}`, error);
});

const shutdownSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
for (const signal of shutdownSignals) {
  process.on(signal, async () => {
    await worker.close();
    await escalationWorker.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

console.log('Webhook and escalation workers started');
