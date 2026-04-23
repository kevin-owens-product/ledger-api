import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { VendorStatus } from '@prisma/client';
import { z } from 'zod';
import { withTenantScope } from '../../middleware/auth.js';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { webhookQueue } from '../../lib/queue.js';

const vendorCreateSchema = z.object({
  name: z.string().min(1).max(200),
  legalName: z.string().min(1).max(200).optional(),
  taxId: z.string().min(1).max(50).optional(),
  address: z.record(z.string(), z.any()).optional(),
  contacts: z.array(z.object({
    name: z.string().min(1).max(200),
    email: z.string().email(),
    role: z.string().min(1).max(100),
  })).optional(),
  paymentPreferences: z.object({
    method: z.enum(['ach', 'virtual_card']),
    accountNumber: z.string().optional(),
    routingNumber: z.string().optional(),
    virtualCardEmail: z.string().email().optional(),
  }).optional(),
  status: z.nativeEnum(VendorStatus).optional(),
});

const vendorUpdateSchema = vendorCreateSchema.partial();

const inviteSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  legalName: z.string().min(1).max(200).optional(),
});

const onboardingSchema = z.object({
  taxId: z.string().min(1).max(50),
  address: z.record(z.string(), z.any()).optional(),
  paymentPreferences: z.object({
    method: z.enum(['ach', 'virtual_card']),
    accountNumber: z.string().optional(),
    routingNumber: z.string().optional(),
    virtualCardEmail: z.string().email().optional(),
  }),
  contacts: z.array(z.object({
    name: z.string().min(1).max(200),
    email: z.string().email(),
    role: z.string().min(1).max(100),
  })).optional(),
});

const paymentMethodsSchema = z.object({
  method: z.enum(['ach', 'virtual_card']),
  accountNumber: z.string().optional(),
  routingNumber: z.string().optional(),
  virtualCardEmail: z.string().email().optional(),
});

export async function registerVendorRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/v1/vendors', async (request) => {
    const query = z.object({ q: z.string().optional() }).parse(request.query);

    return withTenantScope(request, async () => {
      const vendors = await prisma.vendor.findMany({
        where: query.q
          ? {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' } },
                { legalName: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : undefined,
        orderBy: { createdAt: 'desc' },
      });

      return { data: vendors };
    });
  });

  fastify.post('/v1/vendors', async (request, reply) => {
    const body = vendorCreateSchema.parse(request.body);

    const vendor = await withTenantScope(request, async () => {
      return prisma.vendor.create({
        data: {
          tenantId: request.auth!.tenant.id,
          name: body.name,
          legalName: body.legalName,
          taxId: body.taxId,
          address: body.address,
          contacts: body.contacts,
          paymentPreferences: body.paymentPreferences,
          status: body.status ?? VendorStatus.active,
        },
      });
    });

    reply.status(201);
    return { data: vendor };
  });

  fastify.get('/v1/vendors/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);

    return withTenantScope(request, async () => {
      const vendor = await prisma.vendor.findFirst({
        where: { id: params.id },
      });

      if (!vendor) {
        throw new AppError('VENDOR_NOT_FOUND', 'Vendor not found', 404);
      }

      return { data: vendor };
    });
  });

  fastify.patch('/v1/vendors/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = vendorUpdateSchema.parse(request.body);

    return withTenantScope(request, async () => {
      const existing = await prisma.vendor.findFirst({ where: { id: params.id } });
      if (!existing) {
        throw new AppError('VENDOR_NOT_FOUND', 'Vendor not found', 404);
      }

      const updated = await prisma.vendor.update({
        where: { id: params.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.legalName !== undefined ? { legalName: body.legalName } : {}),
          ...(body.taxId !== undefined ? { taxId: body.taxId } : {}),
          ...(body.address !== undefined ? { address: body.address } : {}),
          ...(body.contacts !== undefined ? { contacts: body.contacts } : {}),
          ...(body.paymentPreferences !== undefined ? { paymentPreferences: body.paymentPreferences } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
        },
      });

      return { data: updated };
    });
  });

  fastify.delete('/v1/vendors/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);

    await withTenantScope(request, async () => {
      const existing = await prisma.vendor.findFirst({ where: { id: params.id } });
      if (!existing) {
        throw new AppError('VENDOR_NOT_FOUND', 'Vendor not found', 404);
      }

      await prisma.vendor.delete({ where: { id: params.id } });
    });

    reply.status(204);
    return null;
  });

  fastify.post('/v1/vendors/invite', async (request, reply) => {
    const body = inviteSchema.parse(request.body);

    const vendor = await withTenantScope(request, async () => {
      const onboardingToken = crypto.randomBytes(24).toString('hex');
      const tokenExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 72);

      const created = await prisma.vendor.create({
        data: {
          tenantId: request.auth!.tenant.id,
          name: body.name,
          legalName: body.legalName,
          inviteEmail: body.email,
          status: VendorStatus.invited,
          onboardingToken,
          tokenExpiresAt,
        },
      });

      await enqueueWebhookEvent(request, 'vendor.invite_sent', {
        vendorId: created.id,
        email: body.email,
        onboardingToken,
        onboardingUrl: `/vendor-onboarding/${onboardingToken}`,
      });

      return created;
    });

    reply.status(201);
    return {
      data: {
        id: vendor.id,
        status: vendor.status,
        inviteEmail: vendor.inviteEmail,
      },
    };
  });

  fastify.post('/v1/vendors/:id/onboarding', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = onboardingSchema.parse(request.body);

    return withTenantScope(request, async () => {
      const vendor = await prisma.vendor.findFirst({ where: { id: params.id } });
      if (!vendor) {
        throw new AppError('VENDOR_NOT_FOUND', 'Vendor not found', 404);
      }

      const updated = await prisma.vendor.update({
        where: { id: params.id },
        data: {
          taxId: body.taxId,
          address: body.address,
          paymentPreferences: body.paymentPreferences,
          contacts: body.contacts,
          status: VendorStatus.pending_verification,
        },
      });

      await webhookQueue.add('verify-tin', {
        vendorId: updated.id,
        tenantId: request.auth!.tenant.id,
        taxId: body.taxId,
      });

      await enqueueWebhookEvent(request, 'vendor.verification_started', {
        vendorId: updated.id,
      });

      return { data: updated };
    });
  });

  fastify.get('/v1/vendors/:id/invoices', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);

    return withTenantScope(request, async () => {
      const vendor = await prisma.vendor.findFirst({ where: { id: params.id } });
      if (!vendor) {
        throw new AppError('VENDOR_NOT_FOUND', 'Vendor not found', 404);
      }

      const invoices = await prisma.invoice.findMany({
        where: {
          matchedVendorId: params.id,
          deletedAt: null,
        },
        orderBy: { createdAt: 'desc' },
      });

      return { data: invoices };
    });
  });

  fastify.post('/v1/vendors/:id/payment-methods', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = paymentMethodsSchema.parse(request.body);

    return withTenantScope(request, async () => {
      const vendor = await prisma.vendor.findFirst({ where: { id: params.id } });
      if (!vendor) {
        throw new AppError('VENDOR_NOT_FOUND', 'Vendor not found', 404);
      }

      const updated = await prisma.vendor.update({
        where: { id: params.id },
        data: {
          paymentPreferences: {
            method: body.method,
            accountNumber: body.accountNumber,
            routingNumber: body.routingNumber,
            virtualCardEmail: body.virtualCardEmail,
          },
        },
      });

      return { data: updated };
    });
  });
}

async function enqueueWebhookEvent(
  request: FastifyRequest,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const tenantId = request.auth?.tenant.id;
  if (!tenantId) {
    throw new AppError('TENANT_CONTEXT_MISSING', 'Tenant context is not available', 500);
  }

  const event = await prisma.webhookEvent.create({
    data: {
      tenantId,
      eventType,
      payload,
    },
  });

  await webhookQueue.add('deliver', {
    webhookEventId: event.id,
    tenantId,
  });
}
