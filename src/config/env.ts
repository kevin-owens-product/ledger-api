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
  ANTHROPIC_API_KEY: z.string().optional(),
  WEBHOOK_RETRY_LIMIT: z.coerce.number().int().positive().default(3),
  APPROVAL_ESCALATION_TIMEOUT_HOURS: z.coerce.number().int().positive().default(48),
  MODERN_TREASURY_API_KEY: z.string().optional(),
  STRIPE_API_KEY: z.string().optional(),
  PAYMENTS_FORCE_FAIL_PROVIDER: z.enum(['modern_treasury', 'stripe']).optional(),
  ERP_SYNC_INTERVAL_HOURS: z.coerce.number().int().positive().default(4),
  QUICKBOOKS_CLIENT_ID: z.string().optional(),
  QUICKBOOKS_CLIENT_SECRET: z.string().optional(),
  XERO_CLIENT_ID: z.string().optional(),
  XERO_CLIENT_SECRET: z.string().optional(),
  NETSUITE_CLIENT_ID: z.string().optional(),
  NETSUITE_CLIENT_SECRET: z.string().optional(),
  SAGE_INTACCT_CLIENT_ID: z.string().optional(),
  SAGE_INTACCT_CLIENT_SECRET: z.string().optional(),
  PAPERCLIP_API_URL: z.string().optional(),
  PAPERCLIP_API_KEY: z.string().optional(),
  PAPERCLIP_COMPANY_ID: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

export const env = parsed.data;
