import type { FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { jwtVerify } from 'jose';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { runWithTenantScope } from '../lib/tenant-context.js';
import type { AuthContext } from '../types.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const authHeaderRegex = /^Bearer\s+(.+)$/i;

export async function authenticateRequest(request: FastifyRequest): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader) {
    throw new AppError('AUTH_REQUIRED', 'Authorization header is required', 401);
  }

  const match = authHeader.match(authHeaderRegex);
  if (!match) {
    throw new AppError('AUTH_INVALID', 'Authorization must be Bearer token', 401);
  }

  const credential = match[1];

  const tenant = await resolveTenantByApiKey(credential);
  if (tenant) {
    request.auth = { tenant, authType: 'api_key' };
    return;
  }

  const jwtTenantId = await resolveTenantByJwt(credential);
  if (!jwtTenantId) {
    throw new AppError('AUTH_INVALID', 'Invalid API key or bearer token', 401);
  }

  const jwtTenant = await prisma.tenant.findUnique({
    where: { id: jwtTenantId },
    select: { id: true, name: true, webhookUrl: true, webhookSecret: true },
  });

  if (!jwtTenant) {
    throw new AppError('AUTH_INVALID', 'Tenant in bearer token does not exist', 401);
  }

  request.auth = { tenant: jwtTenant, authType: 'bearer_token' };
}

export async function withTenantScope<T>(request: FastifyRequest, callback: () => Promise<T>): Promise<T> {
  if (!request.auth?.tenant.id) {
    throw new AppError('TENANT_CONTEXT_MISSING', 'Tenant context is not available', 500);
  }

  return runWithTenantScope(request.auth.tenant.id, callback);
}

async function resolveTenantByApiKey(apiKey: string): Promise<AuthContext['tenant'] | null> {
  const tenants = await prisma.tenant.findMany({
    select: { id: true, name: true, webhookUrl: true, webhookSecret: true, apiKeyHash: true },
  });

  for (const tenant of tenants) {
    const matches = await bcrypt.compare(apiKey, tenant.apiKeyHash);
    if (matches) {
      return {
        id: tenant.id,
        name: tenant.name,
        webhookUrl: tenant.webhookUrl,
        webhookSecret: tenant.webhookSecret,
      };
    }
  }

  return null;
}

async function resolveTenantByJwt(token: string): Promise<string | null> {
  try {
    const secret = new TextEncoder().encode(env.API_JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);
    const tenantId = payload.tenantId;
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      return null;
    }
    return tenantId;
  } catch {
    return null;
  }
}
