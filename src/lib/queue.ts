import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';

const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const WEBHOOK_QUEUE_NAME = 'webhook-delivery';

export const webhookQueue = new Queue(WEBHOOK_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: env.WEBHOOK_RETRY_LIMIT,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});

export async function getQueueDepth(): Promise<number> {
  const counts = await webhookQueue.getJobCounts('waiting', 'delayed', 'active');
  return counts.waiting + counts.delayed + counts.active;
}
