import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';

const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const APPROVAL_ESCALATION_QUEUE_NAME = 'approval-escalation';

export const approvalEscalationQueue = new Queue(APPROVAL_ESCALATION_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});
