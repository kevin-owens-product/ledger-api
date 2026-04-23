import type { FastifyInstance, FastifyRequest } from 'fastify';
import { InvoiceStatus, TransitionActorType, VendorStatus } from '@prisma/client';
import { z } from 'zod';
import { withTenantScope } from '../../middleware/auth.js';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { webhookQueue } from '../../lib/queue.js';
import { initiateApproval } from '../../services/approval-workflow.js';

const createInvoiceSchema = z.object({
  externalRef: z.string().min(1).max(128).optional(),
  amountCents: z.number().int().positive(),
  currency: z.string().length(3),
  metadata: z.record(z.string(), z.any()).optional(),
  matchedVendorId: z.string().optional(),
  vendorName: z.string().min(1).max(200).optional(),
  vendorAddress: z.record(z.string(), z.any()).optional(),
});

const listInvoicesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(25),
  status: z.nativeEnum(InvoiceStatus).optional(),
});

const patchInvoiceSchema = z.object({
  status: z.nativeEnum(InvoiceStatus),
  reason: z.string().min(1).max(2000).optional(),
  actorId: z.string().min(1).optional(),
  actorType: z.nativeEnum(TransitionActorType).optional(),
});

export const statusTransitions: Record<InvoiceStatus, InvoiceStatus[]> = {
  draft: [InvoiceStatus.submitted, InvoiceStatus.voided],
  submitted: [InvoiceStatus.gl_coded, InvoiceStatus.rejected, InvoiceStatus.voided],
  gl_coded: [InvoiceStatus.approval_pending, InvoiceStatus.rejected, InvoiceStatus.voided],
  approval_pending: [InvoiceStatus.approved, InvoiceStatus.rejected, InvoiceStatus.voided],
  approved: [InvoiceStatus.payment_pending, InvoiceStatus.voided],
  payment_pending: [InvoiceStatus.paid, InvoiceStatus.voided],
  paid: [],
  rejected: [InvoiceStatus.voided],
  voided: [],
};

const vendorSuspensionBlockedStatuses = new Set<InvoiceStatus>([
  InvoiceStatus.gl_coded,
  InvoiceStatus.approval_pending,
  InvoiceStatus.approved,
  InvoiceStatus.payment_pending,
  InvoiceStatus.paid,
]);

export async function registerInvoiceRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/v1/invoices', async (request, reply) => {
    const body = createInvoiceSchema.parse(request.body);

    const invoice = await withTenantScope(request, async () => {
      const tenantId = request.auth!.tenant.id;
      const matchedVendorId = await resolveMatchedVendorId({
        tenantId,
        explicitVendorId: body.matchedVendorId,
        vendorName: body.vendorName,
        vendorAddress: body.vendorAddress,
      });

      const created = await prisma.invoice.create({
        data: {
          tenantId,
          externalRef: body.externalRef,
          amountCents: body.amountCents,
          currency: body.currency.toUpperCase(),
          status: InvoiceStatus.draft,
          metadata: body.metadata,
          matchedVendorId,
        },
      });

      await recordTransition({
        request,
        invoiceId: created.id,
        fromState: null,
        toState: InvoiceStatus.draft,
        actorType: TransitionActorType.system,
        actorId: 'system',
        reason: 'Invoice created',
      });

      await enqueueWebhookEvent(request, 'invoice.created', {
        invoiceId: created.id,
        status: created.status,
      });

      return created;
    });

    reply.status(201);
    return { data: invoice };
  });

  fastify.get('/v1/invoices', async (request) => {
    const query = listInvoicesQuerySchema.parse(request.query);

    return withTenantScope(request, async () => {
      const invoices = await prisma.invoice.findMany({
        where: {
          status: query.status,
          deletedAt: null,
        },
        orderBy: { createdAt: 'desc' },
        ...(query.cursor
          ? {
              cursor: { id: query.cursor },
              skip: 1,
            }
          : {}),
        take: query.limit + 1,
      });

      const hasNextPage = invoices.length > query.limit;
      const data = hasNextPage ? invoices.slice(0, query.limit) : invoices;
      const nextCursor = hasNextPage ? data[data.length - 1]?.id : null;

      return {
        data,
        pageInfo: {
          hasNextPage,
          nextCursor,
        },
      };
    });
  });

  fastify.get('/v1/invoices/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);

    return withTenantScope(request, async () => {
      const invoice = await prisma.invoice.findFirst({
        where: {
          id: params.id,
          deletedAt: null,
        },
      });

      if (!invoice) {
        throw new AppError('INVOICE_NOT_FOUND', 'Invoice not found', 404);
      }

      return { data: invoice };
    });
  });

  fastify.get('/v1/invoices/:id/history', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const tenantId = request.auth!.tenant.id;

    return withTenantScope(request, async () => {
      const invoice = await prisma.invoice.findFirst({
        where: { id: params.id, tenantId, deletedAt: null },
        select: { id: true },
      });

      if (!invoice) {
        throw new AppError('INVOICE_NOT_FOUND', 'Invoice not found', 404);
      }

      const transitions = await prisma.invoiceTransition.findMany({
        where: { invoiceId: params.id, tenantId },
        orderBy: { timestamp: 'asc' },
      });

      return { data: transitions };
    });
  });

  fastify.patch('/v1/invoices/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = patchInvoiceSchema.parse(request.body);

    return withTenantScope(request, async () => {
      const invoice = await prisma.invoice.findFirst({
        where: {
          id: params.id,
          deletedAt: null,
        },
      });

      if (!invoice) {
        throw new AppError('INVOICE_NOT_FOUND', 'Invoice not found', 404);
      }

      if (!statusTransitions[invoice.status].includes(body.status)) {
        throw new AppError('INVALID_STATUS_TRANSITION', `Cannot transition invoice from ${invoice.status} to ${body.status}`, 422, {
          allowedTransitions: statusTransitions[invoice.status],
          reason: 'Transition is not permitted by invoice lifecycle rules',
        });
      }

      if (invoice.status === InvoiceStatus.approved && body.status !== InvoiceStatus.payment_pending && body.status !== InvoiceStatus.voided) {
        throw new AppError('INVALID_STATUS_TRANSITION', 'Approved invoices may only transition to payment_pending or voided', 422);
      }

      if (invoice.status === InvoiceStatus.paid || invoice.status === InvoiceStatus.voided) {
        throw new AppError('INVALID_STATUS_TRANSITION', `${invoice.status} is a terminal state`, 422);
      }

      if (vendorSuspensionBlockedStatuses.has(body.status) && invoice.matchedVendorId) {
        const vendor = await prisma.vendor.findFirst({
          where: { id: invoice.matchedVendorId },
          select: { status: true },
        });
        if (vendor?.status === VendorStatus.suspended) {
          throw new AppError('VENDOR_SUSPENDED', 'Invoices for suspended vendors cannot proceed past submitted', 422);
        }
      }

      const updated = await prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: body.status },
      });

      const actorType = body.actorType ?? TransitionActorType.system;
      const actorId = body.actorId ?? request.auth?.tenant.id ?? 'system';

      await recordTransition({
        request,
        invoiceId: invoice.id,
        fromState: invoice.status,
        toState: body.status,
        actorType,
        actorId,
        reason: body.reason,
      });

      await enqueueWebhookEvent(request, `invoice.${body.status}`, {
        invoiceId: updated.id,
        fromStatus: invoice.status,
        toStatus: updated.status,
        actorId,
        actorType,
        reason: body.reason,
      });

      if (body.status === InvoiceStatus.approval_pending) {
        await initiateApproval(updated.id, request.auth!.tenant.id);
      }

      return { data: updated };
    });
  });

  fastify.delete('/v1/invoices/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);

    await withTenantScope(request, async () => {
      const invoice = await prisma.invoice.findFirst({
        where: {
          id: params.id,
          deletedAt: null,
        },
      });

      if (!invoice) {
        throw new AppError('INVOICE_NOT_FOUND', 'Invoice not found', 404);
      }

      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { deletedAt: new Date() },
      });

      await enqueueWebhookEvent(request, 'invoice.deleted', {
        invoiceId: invoice.id,
      });
    });

    reply.status(204);
    return null;
  });
}

async function recordTransition(params: {
  request: FastifyRequest;
  invoiceId: string;
  fromState: InvoiceStatus | null;
  toState: InvoiceStatus;
  actorId: string;
  actorType: TransitionActorType;
  reason?: string;
}): Promise<void> {
  const { request, invoiceId, fromState, toState, actorId, actorType, reason } = params;
  const tenantId = request.auth?.tenant.id;

  if (!tenantId) {
    throw new AppError('TENANT_CONTEXT_MISSING', 'Tenant context is not available', 500);
  }

  await prisma.invoiceTransition.create({
    data: {
      tenantId,
      invoiceId,
      fromState,
      toState,
      actorId,
      actorType,
      reason,
      timestamp: new Date(),
    },
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

async function resolveMatchedVendorId(params: {
  tenantId: string;
  explicitVendorId?: string;
  vendorName?: string;
  vendorAddress?: Record<string, unknown>;
}): Promise<string | null> {
  const { tenantId, explicitVendorId, vendorName, vendorAddress } = params;

  if (explicitVendorId) {
    const existingVendor = await prisma.vendor.findFirst({
      where: { id: explicitVendorId },
      select: { id: true },
    });
    if (!existingVendor) {
      throw new AppError('VENDOR_NOT_FOUND', 'Matched vendor does not exist', 404);
    }
    return explicitVendorId;
  }

  if (!vendorName) {
    return null;
  }

  const existingByName = await prisma.vendor.findFirst({
    where: { name: { equals: vendorName, mode: 'insensitive' } },
    select: { id: true },
  });

  if (existingByName) {
    return existingByName.id;
  }

  const createdVendor = await prisma.vendor.create({
    data: {
      tenantId,
      name: vendorName,
      legalName: vendorName,
      address: vendorAddress,
      status: VendorStatus.active,
    },
    select: { id: true },
  });

  return createdVendor.id;
}
