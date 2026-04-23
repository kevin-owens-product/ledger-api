import type { FastifyInstance, FastifyRequest } from 'fastify';
import { InvoiceStatus, TransitionActorType } from '@prisma/client';
import { z } from 'zod';
import { withTenantScope } from '../../middleware/auth.js';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { webhookQueue } from '../../lib/queue.js';
import { classifyLineItems, type ChartOfAccountsEntry } from '../../services/gl-coding.js';

const GL_HISTORY_LIMIT = 20;

const batchGLCodeSchema = z.object({
  invoiceIds: z.array(z.string()).min(1).max(50),
});

const glCodingAllowedStatuses = new Set<InvoiceStatus>([
  InvoiceStatus.draft,
  InvoiceStatus.submitted,
]);

async function fetchTenantContext(tenantId: string): Promise<{
  chartOfAccounts: ChartOfAccountsEntry[] | undefined;
  historyExamples: Array<{ description: string; vendor?: string; amountCents?: number; glCode: string; glLabel: string }>;
}> {
  const [tenant, history] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    }),
    prisma.tenantGLHistory.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: GL_HISTORY_LIMIT,
    }),
  ]);

  const settings = (tenant?.settings ?? {}) as Record<string, unknown>;
  const chartOfAccounts = Array.isArray(settings.chartOfAccounts)
    ? (settings.chartOfAccounts as ChartOfAccountsEntry[])
    : undefined;

  return {
    chartOfAccounts,
    historyExamples: history.map((h) => ({
      description: h.description,
      vendor: h.vendor ?? undefined,
      amountCents: h.amountCents ?? undefined,
      glCode: h.glCode,
      glLabel: h.glLabel,
    })),
  };
}

async function runGLCodingForInvoice(
  invoiceId: string,
  tenantId: string,
  request: FastifyRequest,
): Promise<{ invoiceId: string; lineItemsUpdated: number }> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, deletedAt: null },
    include: { lineItems: { orderBy: { createdAt: 'asc' } } },
  });

  if (!invoice) {
    throw new AppError('INVOICE_NOT_FOUND', `Invoice ${invoiceId} not found`, 404);
  }

  if (invoice.lineItems.length === 0) {
    throw new AppError('NO_LINE_ITEMS', 'Invoice has no line items to classify', 400);
  }
  if (!glCodingAllowedStatuses.has(invoice.status)) {
    throw new AppError('INVALID_INVOICE_STATE', `Cannot GL-code an invoice in ${invoice.status} state`, 422);
  }

  const { chartOfAccounts, historyExamples } = await fetchTenantContext(tenantId);

  const lineItemInputs = invoice.lineItems.map((item) => ({
    description: item.description,
    amountCents: item.amountCents,
    currency: item.currency,
    vendor: item.vendor ?? undefined,
  }));

  const results = await classifyLineItems({ lineItems: lineItemInputs, chartOfAccounts, historyExamples });

  const now = new Date();

  await Promise.all(
    results.map((result) => {
      const lineItem = invoice.lineItems[result.lineItemIndex];
      if (!lineItem) return Promise.resolve();
      return prisma.invoiceLineItem.update({
        where: { id: lineItem.id },
        data: {
          glCodeSuggestions: result.candidates,
          glCodedAt: now,
        },
      });
    }),
  );

  const previousStatus = invoice.status;
  // Transition invoice to gl_coded status
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: InvoiceStatus.gl_coded },
  });
  await prisma.invoiceTransition.create({
    data: {
      tenantId,
      invoiceId: invoice.id,
      fromState: previousStatus,
      toState: InvoiceStatus.gl_coded,
      actorType: TransitionActorType.system,
      actorId: request.auth?.tenant.id ?? 'system',
      reason: 'GL coding completed',
      timestamp: new Date(),
    },
  });

  await enqueueWebhookEvent(request, 'invoice.gl_coded', {
    invoiceId: invoice.id,
    lineItemsClassified: results.length,
  });

  return { invoiceId: invoice.id, lineItemsUpdated: results.length };
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
    data: { tenantId, eventType, payload },
  });

  await webhookQueue.add('deliver', { webhookEventId: event.id, tenantId });
}

export async function registerGLCodingRoutes(fastify: FastifyInstance): Promise<void> {
  // Run GL coding for a single invoice
  fastify.post('/v1/invoices/:id/gl-code', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);

    return withTenantScope(request, async () => {
      const tenantId = request.auth!.tenant.id;
      const result = await runGLCodingForInvoice(params.id, tenantId, request);

      const lineItems = await prisma.invoiceLineItem.findMany({
        where: { invoiceId: params.id },
        orderBy: { createdAt: 'asc' },
      });

      return {
        data: {
          invoiceId: result.invoiceId,
          lineItemsClassified: result.lineItemsUpdated,
          lineItems,
        },
      };
    });
  });

  // Batch GL coding for multiple invoices
  fastify.post('/v1/gl-code/batch', async (request) => {
    const body = batchGLCodeSchema.parse(request.body);

    return withTenantScope(request, async () => {
      const tenantId = request.auth!.tenant.id;
      const results: Array<{ invoiceId: string; lineItemsClassified: number; error?: string }> = [];

      for (const invoiceId of body.invoiceIds) {
        try {
          const result = await runGLCodingForInvoice(invoiceId, tenantId, request);
          results.push({ invoiceId: result.invoiceId, lineItemsClassified: result.lineItemsUpdated });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          results.push({ invoiceId, lineItemsClassified: 0, error: message });
        }
      }

      const succeeded = results.filter((r) => !r.error).length;
      const failed = results.length - succeeded;

      return { data: { succeeded, failed, results } };
    });
  });
}
