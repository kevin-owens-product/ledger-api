import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenantScope } from '../../middleware/auth.js';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';

const lineItemCreateSchema = z.object({
  description: z.string().min(1).max(500),
  amountCents: z.number().int().positive(),
  currency: z.string().length(3).default('USD'),
  vendor: z.string().min(1).max(200).optional(),
});

const bulkLineItemsSchema = z.object({
  lineItems: z.array(lineItemCreateSchema).min(1).max(500),
});

const acceptGLCodeSchema = z.object({
  glCode: z.string().min(1).max(20),
  glLabel: z.string().min(1).max(200),
});

export async function registerLineItemRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/v1/invoices/:id/line-items', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = bulkLineItemsSchema.parse(request.body);

    const result = await withTenantScope(request, async () => {
      const invoice = await prisma.invoice.findFirst({
        where: { id: params.id, deletedAt: null },
      });

      if (!invoice) {
        throw new AppError('INVOICE_NOT_FOUND', 'Invoice not found', 404);
      }

      const tenantId = request.auth!.tenant.id;
      const created = await prisma.invoiceLineItem.createMany({
        data: body.lineItems.map((item) => ({
          tenantId,
          invoiceId: invoice.id,
          description: item.description,
          amountCents: item.amountCents,
          currency: item.currency.toUpperCase(),
          vendor: item.vendor,
        })),
      });

      const lineItems = await prisma.invoiceLineItem.findMany({
        where: { invoiceId: invoice.id },
        orderBy: { createdAt: 'asc' },
      });

      return { count: created.count, lineItems };
    });

    reply.status(201);
    return { data: result };
  });

  fastify.get('/v1/invoices/:id/line-items', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);

    return withTenantScope(request, async () => {
      const invoice = await prisma.invoice.findFirst({
        where: { id: params.id, deletedAt: null },
      });

      if (!invoice) {
        throw new AppError('INVOICE_NOT_FOUND', 'Invoice not found', 404);
      }

      const lineItems = await prisma.invoiceLineItem.findMany({
        where: { invoiceId: invoice.id },
        orderBy: { createdAt: 'asc' },
      });

      return { data: lineItems };
    });
  });

  // Accept a GL code for a line item — stores in TenantGLHistory for few-shot learning
  fastify.patch('/v1/invoices/:id/line-items/:lineItemId', async (request) => {
    const params = z.object({ id: z.string(), lineItemId: z.string() }).parse(request.params);
    const body = acceptGLCodeSchema.parse(request.body);

    return withTenantScope(request, async () => {
      const lineItem = await prisma.invoiceLineItem.findFirst({
        where: { id: params.lineItemId, invoiceId: params.id },
      });

      if (!lineItem) {
        throw new AppError('LINE_ITEM_NOT_FOUND', 'Line item not found', 404);
      }

      const tenantId = request.auth!.tenant.id;
      const now = new Date();

      const [updated] = await Promise.all([
        prisma.invoiceLineItem.update({
          where: { id: lineItem.id },
          data: {
            glCodeAccepted: body.glCode,
            glLabelAccepted: body.glLabel,
            acceptedAt: now,
          },
        }),
        prisma.tenantGLHistory.create({
          data: {
            tenantId,
            description: lineItem.description,
            vendor: lineItem.vendor,
            amountCents: lineItem.amountCents,
            glCode: body.glCode,
            glLabel: body.glLabel,
          },
        }),
      ]);

      return { data: updated };
    });
  });
}
