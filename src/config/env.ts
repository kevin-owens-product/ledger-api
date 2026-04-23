import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  API_JWT_SECRET: z.string().min(16),
  ANTHROPIC_API_KEY: z.string().min(1),
  WEBHOOK_RETRY_LIMIT: z.coerce.number().int().positive().default(3),
  APPROVAL_ESCALATION_TIMEOUT_HOURS: z.coerce.number().int().positive().default(48),
  PAPERCLIP_API_URL: z.string().optional(),
  PAPERCLIP_API_KEY: z.string().optional(),
  PAPERCLIP_COMPANY_ID: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

export const env = parsed.data;
