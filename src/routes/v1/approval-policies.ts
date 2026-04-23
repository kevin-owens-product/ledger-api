import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenantScope } from '../../middleware/auth.js';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { policyRuleSchema } from '../../services/approval-workflow.js';

const createPolicySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  rules: z.array(policyRuleSchema).min(1),
});

const updatePolicySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  rules: z.array(policyRuleSchema).min(1).optional(),
  isActive: z.boolean().optional(),
});

export async function registerApprovalPoliciesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/v1/approval-policies', async (request, reply) => {
    const body = createPolicySchema.parse(request.body);

    const policy = await withTenantScope(request, async () => {
      return prisma.approvalPolicy.create({
        data: {
          tenantId: request.auth!.tenant.id,
          name: body.name,
          description: body.description ?? null,
          rules: body.rules as object,
          isActive: true,
        },
      });
    });

    reply.status(201);
    return { data: policy };
  });

  fastify.get('/v1/approval-policies', async (request) => {
    const query = z
      .object({
        cursor: z.string().optional(),
        limit: z.coerce.number().int().positive().max(100).default(25),
        isActive: z.coerce.boolean().optional(),
      })
      .parse(request.query);

    return withTenantScope(request, async () => {
      const policies = await prisma.approvalPolicy.findMany({
        where: {
          ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
        },
        orderBy: { createdAt: 'desc' },
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        take: query.limit + 1,
      });

      const hasNextPage = policies.length > query.limit;
      const data = hasNextPage ? policies.slice(0, query.limit) : policies;

      return {
        data,
        pageInfo: {
          hasNextPage,
          nextCursor: hasNextPage ? data[data.length - 1]?.id : null,
        },
      };
    });
  });

  fastify.get('/v1/approval-policies/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);

    return withTenantScope(request, async () => {
      const policy = await prisma.approvalPolicy.findFirst({
        where: { id: params.id },
      });

      if (!policy) {
        throw new AppError('POLICY_NOT_FOUND', 'Approval policy not found', 404);
      }

      return { data: policy };
    });
  });

  fastify.patch('/v1/approval-policies/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = updatePolicySchema.parse(request.body);

    return withTenantScope(request, async () => {
      const existing = await prisma.approvalPolicy.findFirst({
        where: { id: params.id },
      });

      if (!existing) {
        throw new AppError('POLICY_NOT_FOUND', 'Approval policy not found', 404);
      }

      const updated = await prisma.approvalPolicy.update({
        where: { id: params.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.rules !== undefined ? { rules: body.rules as object } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        },
      });

      return { data: updated };
    });
  });

  fastify.delete('/v1/approval-policies/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);

    await withTenantScope(request, async () => {
      const existing = await prisma.approvalPolicy.findFirst({
        where: { id: params.id },
      });

      if (!existing) {
        throw new AppError('POLICY_NOT_FOUND', 'Approval policy not found', 404);
      }

      await prisma.approvalPolicy.delete({
        where: { id: params.id },
      });
    });

    reply.status(204);
    return null;
  });
}
