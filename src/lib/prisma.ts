import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { getTenantScope } from './tenant-context.js';

const tenantModels = new Set([
  'Invoice',
  'WebhookEvent',
  'InvoiceTransition',
  'InvoiceLineItem',
  'TenantGLHistory',
  'ApprovalPolicy',
  'InvoiceApproval',
  'ApprovalStageDecision',
  'Vendor',
]);

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prismaBase = new PrismaClient({ adapter });

function mergeTenantWhere(args: Record<string, unknown>, tenantId: string): void {
  const where = (args.where as Record<string, unknown> | undefined) ?? {};
  args.where = { ...where, tenantId };
}

function applyTenantScoping(
  model: string | undefined,
  operation: string,
  args: Record<string, unknown>,
): void {
  if (!model || !tenantModels.has(model)) {
    return;
  }

  const scope = getTenantScope();
  if (!scope) {
    return;
  }

  const { tenantId } = scope;

  if (operation === 'create') {
    const data = (args.data as Record<string, unknown>) ?? {};
    args.data = { ...data, tenantId };
    return;
  }

  if (operation === 'createMany') {
    const data = args.data;
    if (Array.isArray(data)) {
      args.data = data.map((item) => ({ ...(item as Record<string, unknown>), tenantId }));
      return;
    }
    if (data && typeof data === 'object') {
      args.data = { ...(data as Record<string, unknown>), tenantId };
    }
    return;
  }

  if (['findMany', 'findFirst', 'findUnique', 'count', 'update', 'updateMany', 'delete', 'deleteMany'].includes(operation)) {
    mergeTenantWhere(args, tenantId);
  }

  if (operation === 'upsert') {
    mergeTenantWhere(args, tenantId);

    const createData = (args.create as Record<string, unknown>) ?? {};
    args.create = { ...createData, tenantId };

    const updateData = (args.update as Record<string, unknown>) ?? {};
    args.update = { ...updateData };
  }
}

export const prisma = prismaBase.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const scopedArgs = { ...(args as Record<string, unknown>) };
        applyTenantScoping(model, operation, scopedArgs);
        return query(scopedArgs);
      },
    },
  },
});
