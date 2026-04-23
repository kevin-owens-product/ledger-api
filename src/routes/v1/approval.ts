import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenantScope } from '../../middleware/auth.js';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import {
  processDecision,
  getApprovalStatus,
} from '../../services/approval-workflow.js';

const approveSchema = z.object({
  actorType: z.enum(['user', 'agent']),
  actorId: z.string().min(1),
  comment: z.string().max(2000).optional(),
});

const rejectSchema = z.object({
  actorType: z.enum(['user', 'agent']),
  actorId: z.string().min(1),
  reason: z.string().min(1).max(2000),
});

export async function registerApprovalRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/v1/invoices/:id/approve', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = approveSchema.parse(request.body);

    return withTenantScope(request, async () => {
      await processDecision({
        invoiceId: params.id,
        tenantId: request.auth!.tenant.id,
        outcome: 'approved',
        comment: body.comment,
        actorType: body.actorType,
        actorId: body.actorId,
      });

      const invoice = await prisma.invoice.findFirst({
        where: { id: params.id, deletedAt: null },
      });

      return { data: invoice };
    });
  });

  fastify.post('/v1/invoices/:id/reject', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = rejectSchema.parse(request.body);

    return withTenantScope(request, async () => {
      await processDecision({
        invoiceId: params.id,
        tenantId: request.auth!.tenant.id,
        outcome: 'rejected',
        comment: body.reason,
        actorType: body.actorType,
        actorId: body.actorId,
      });

      const invoice = await prisma.invoice.findFirst({
        where: { id: params.id, deletedAt: null },
      });

      return { data: invoice };
    });
  });

  fastify.get('/v1/invoices/:id/approval-status', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);

    return withTenantScope(request, async () => {
      const invoice = await prisma.invoice.findFirst({
        where: { id: params.id, deletedAt: null },
      });

      if (!invoice) {
        throw new AppError('INVOICE_NOT_FOUND', 'Invoice not found', 404);
      }

      const status = await getApprovalStatus(params.id);

      if (!status) {
        return {
          data: {
            invoiceId: params.id,
            invoiceStatus: invoice.status,
            approvalWorkflow: null,
          },
        };
      }

      return {
        data: {
          invoiceId: params.id,
          invoiceStatus: invoice.status,
          approvalWorkflow: status,
        },
      };
    });
  });
}
