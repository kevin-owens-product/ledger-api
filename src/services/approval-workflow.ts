import { InvoiceStatus, ApprovalWorkflowStatus, ApprovalDecisionOutcome, TransitionActorType } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { webhookQueue } from '../lib/queue.js';
import { approvalEscalationQueue } from '../lib/approval-queue.js';
import { AppError } from '../lib/errors.js';
import { env } from '../config/env.js';

// ---- Policy shape types ----

export const approverSpecSchema = z.object({
  type: z.enum(['user', 'agent', 'role']),
  id: z.string().optional(),
  role: z.string().optional(),
});

export const policyStageSchema = z.object({
  approvers: z.array(approverSpecSchema).min(1),
  timeoutHours: z.number().int().positive().optional(),
  escalateTo: approverSpecSchema.optional(),
});

export const policyConditionSchema = z.object({
  amountGt: z.number().int().positive().optional(),
  amountLte: z.number().int().positive().optional(),
  glCodePrefix: z.string().optional(),
});

export const policyRuleSchema = z.object({
  condition: policyConditionSchema,
  stages: z.array(policyStageSchema).min(1),
});

export type ApproverSpec = z.infer<typeof approverSpecSchema>;
export type PolicyStage = z.infer<typeof policyStageSchema>;
export type PolicyRule = z.infer<typeof policyRuleSchema>;

// ---- Webhook helper ----

async function enqueueWebhookEvent(
  tenantId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const event = await prisma.webhookEvent.create({
    data: { tenantId, eventType, payload },
  });
  await webhookQueue.add('deliver', { webhookEventId: event.id, tenantId });
}

async function recordTransition(params: {
  tenantId: string;
  invoiceId: string;
  fromState: InvoiceStatus;
  toState: InvoiceStatus;
  actorType: TransitionActorType;
  actorId: string;
  reason?: string;
}): Promise<void> {
  await prisma.invoiceTransition.create({
    data: {
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      fromState: params.fromState,
      toState: params.toState,
      actorType: params.actorType,
      actorId: params.actorId,
      reason: params.reason,
      timestamp: new Date(),
    },
  });
}

// ---- Paperclip agent notification ----

async function notifyPaperclipAgent(params: {
  agentId: string;
  invoiceId: string;
  approvalId: string;
  stageIndex: number;
  invoice: Record<string, unknown>;
}): Promise<void> {
  if (!env.PAPERCLIP_API_URL || !env.PAPERCLIP_API_KEY || !env.PAPERCLIP_COMPANY_ID) {
    return;
  }

  const body = {
    type: 'request_board_approval',
    requestedByAgentId: params.agentId,
    payload: {
      title: `Invoice approval required: ${params.invoiceId}`,
      summary: `Invoice ${params.invoiceId} requires approval at stage ${params.stageIndex + 1}. Amount: ${params.invoice.amountCents} ${params.invoice.currency}.`,
      recommendedAction: `Review invoice details and call POST /v1/invoices/${params.invoiceId}/approve or /reject with your decision.`,
      invoiceId: params.invoiceId,
      approvalId: params.approvalId,
      stageIndex: params.stageIndex,
    },
  };

  try {
    await fetch(`${env.PAPERCLIP_API_URL}/api/companies/${env.PAPERCLIP_COMPANY_ID}/approvals`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.PAPERCLIP_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Non-fatal: webhook is the primary notification channel
  }
}

// ---- Policy evaluation ----

function conditionMatches(
  condition: z.infer<typeof policyConditionSchema>,
  invoice: { amountCents: number },
  glCodePrefixes: string[],
): boolean {
  if (condition.amountGt !== undefined && invoice.amountCents <= condition.amountGt) {
    return false;
  }
  if (condition.amountLte !== undefined && invoice.amountCents > condition.amountLte) {
    return false;
  }
  if (condition.glCodePrefix !== undefined) {
    const matches = glCodePrefixes.some((p) => p.startsWith(condition.glCodePrefix!));
    if (!matches) return false;
  }
  return true;
}

async function findApplicablePolicy(
  tenantId: string,
  invoice: { id: string; amountCents: number },
): Promise<{ policy: { id: string; rules: unknown }; stages: PolicyStage[] } | null> {
  const policies = await prisma.approvalPolicy.findMany({
    where: { tenantId, isActive: true },
    orderBy: { createdAt: 'asc' },
  });

  if (policies.length === 0) return null;

  // Collect accepted GL code prefixes from line items
  const lineItems = await prisma.invoiceLineItem.findMany({
    where: { invoiceId: invoice.id },
    select: { glCodeAccepted: true },
  });
  const glCodePrefixes = lineItems
    .map((li) => li.glCodeAccepted ?? '')
    .filter(Boolean);

  for (const policy of policies) {
    const rules = z.array(policyRuleSchema).parse(policy.rules);
    for (const rule of rules) {
      if (conditionMatches(rule.condition, invoice, glCodePrefixes)) {
        return { policy: { id: policy.id, rules: policy.rules }, stages: rule.stages };
      }
    }
  }

  return null;
}

// ---- Stage notification ----

async function requestStageApproval(params: {
  approvalId: string;
  invoiceId: string;
  tenantId: string;
  stageIndex: number;
  stage: PolicyStage;
  invoice: Record<string, unknown>;
}): Promise<void> {
  const { approvalId, invoiceId, tenantId, stageIndex, stage, invoice } = params;

  for (const approver of stage.approvers) {
    await enqueueWebhookEvent(tenantId, 'invoice.approval_requested', {
      invoiceId,
      approvalId,
      stageIndex,
      approverType: approver.type,
      ...(approver.type === 'agent' ? { agentId: approver.id } : {}),
      ...(approver.type === 'user' ? { userId: approver.id } : {}),
      ...(approver.type === 'role' ? { role: approver.role } : {}),
      invoice,
    });

    if (approver.type === 'agent' && approver.id) {
      await notifyPaperclipAgent({
        agentId: approver.id,
        invoiceId,
        approvalId,
        stageIndex,
        invoice,
      });
    }
  }

  // Schedule escalation if a timeout is configured
  const timeoutHours = stage.timeoutHours ?? env.APPROVAL_ESCALATION_TIMEOUT_HOURS;
  await approvalEscalationQueue.add(
    'check-escalation',
    { approvalId, stageIndex, tenantId, invoiceId },
    { delay: timeoutHours * 60 * 60 * 1000 },
  );
}

// ---- Public API ----

export async function initiateApproval(
  invoiceId: string,
  tenantId: string,
): Promise<void> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, deletedAt: null },
    include: { lineItems: true },
  });

  if (!invoice) {
    throw new AppError('INVOICE_NOT_FOUND', 'Invoice not found', 404);
  }

  const existing = await prisma.invoiceApproval.findUnique({
    where: { invoiceId },
  });
  if (existing) return; // already has an active workflow

  const match = await findApplicablePolicy(tenantId, invoice);

  let approvalRecord: { id: string; currentStage: number; totalStages: number };

  if (match) {
    approvalRecord = await prisma.invoiceApproval.create({
      data: {
        tenantId,
        invoiceId,
        policyId: match.policy.id,
        stagesSnapshot: match.stages as object,
        currentStage: 0,
        totalStages: match.stages.length,
        status: ApprovalWorkflowStatus.pending,
        stageStartedAt: new Date(),
      },
      select: { id: true, currentStage: true, totalStages: true },
    });

    const invoicePayload = {
      id: invoice.id,
      amountCents: invoice.amountCents,
      currency: invoice.currency,
      externalRef: invoice.externalRef,
      status: invoice.status,
      metadata: invoice.metadata,
    };

    await requestStageApproval({
      approvalId: approvalRecord.id,
      invoiceId,
      tenantId,
      stageIndex: 0,
      stage: match.stages[0],
      invoice: invoicePayload as Record<string, unknown>,
    });
  } else {
    // No matching policy — create a pending workflow with zero stages; auto-approve
    approvalRecord = await prisma.invoiceApproval.create({
      data: {
        tenantId,
        invoiceId,
        stagesSnapshot: [] as unknown as object,
        currentStage: 0,
        totalStages: 0,
        status: ApprovalWorkflowStatus.approved,
        stageStartedAt: new Date(),
      },
      select: { id: true, currentStage: true, totalStages: true },
    });

    const previousStatus = invoice.status;
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: InvoiceStatus.approved },
    });
    await recordTransition({
      tenantId,
      invoiceId,
      fromState: previousStatus,
      toState: InvoiceStatus.approved,
      actorType: TransitionActorType.system,
      actorId: 'system',
      reason: 'Auto-approved: no matching approval policy',
    });

    await enqueueWebhookEvent(tenantId, 'invoice.approved', {
      invoiceId,
      approvalId: approvalRecord.id,
      autoApproved: true,
    });
  }
}

export async function processDecision(params: {
  invoiceId: string;
  tenantId: string;
  outcome: 'approved' | 'rejected';
  comment?: string;
  actorType: 'user' | 'agent';
  actorId: string;
}): Promise<void> {
  const { invoiceId, tenantId, outcome, comment, actorType, actorId } = params;

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, deletedAt: null },
  });

  if (!invoice) {
    throw new AppError('INVOICE_NOT_FOUND', 'Invoice not found', 404);
  }

  if (invoice.status !== InvoiceStatus.approval_pending) {
    throw new AppError(
      'INVALID_INVOICE_STATE',
      `Invoice is not pending approval (current status: ${invoice.status})`,
      409,
    );
  }

  const approval = await prisma.invoiceApproval.findUnique({
    where: { invoiceId },
  });

  if (!approval || approval.status !== ApprovalWorkflowStatus.pending) {
    throw new AppError('APPROVAL_NOT_FOUND', 'No active approval workflow for this invoice', 404);
  }

  // Record the stage decision
  await prisma.approvalStageDecision.create({
    data: {
      tenantId,
      approvalId: approval.id,
      stageIndex: approval.currentStage,
      outcome: outcome === 'approved' ? ApprovalDecisionOutcome.approved : ApprovalDecisionOutcome.rejected,
      comment: comment ?? null,
      actorType,
      actorId,
      decidedAt: new Date(),
    },
  });

  if (outcome === 'rejected') {
    await prisma.invoiceApproval.update({
      where: { id: approval.id },
      data: { status: ApprovalWorkflowStatus.rejected },
    });

    const previousStatus = invoice.status;
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: InvoiceStatus.rejected },
    });
    await recordTransition({
      tenantId,
      invoiceId,
      fromState: previousStatus,
      toState: InvoiceStatus.rejected,
      actorType: actorType === 'agent' ? TransitionActorType.agent : TransitionActorType.user,
      actorId,
      reason: comment,
    });

    await enqueueWebhookEvent(tenantId, 'invoice.rejected', {
      invoiceId,
      approvalId: approval.id,
      stageIndex: approval.currentStage,
      actorType,
      actorId,
      comment,
    });

    return;
  }

  // outcome === 'approved'
  const nextStage = approval.currentStage + 1;
  const isLastStage = nextStage >= approval.totalStages;

  if (isLastStage) {
    await prisma.invoiceApproval.update({
      where: { id: approval.id },
      data: { status: ApprovalWorkflowStatus.approved },
    });

    const previousStatus = invoice.status;
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: InvoiceStatus.approved },
    });
    await recordTransition({
      tenantId,
      invoiceId,
      fromState: previousStatus,
      toState: InvoiceStatus.approved,
      actorType: actorType === 'agent' ? TransitionActorType.agent : TransitionActorType.user,
      actorId,
      reason: comment,
    });

    await enqueueWebhookEvent(tenantId, 'invoice.approved', {
      invoiceId,
      approvalId: approval.id,
      actorType,
      actorId,
    });
  } else {
    // Advance to next stage
    const stages = z.array(policyStageSchema).parse(approval.stagesSnapshot);
    const nextStageSpec = stages[nextStage];

    await prisma.invoiceApproval.update({
      where: { id: approval.id },
      data: {
        currentStage: nextStage,
        stageStartedAt: new Date(),
      },
    });

    const invoiceData = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, amountCents: true, currency: true, externalRef: true, status: true, metadata: true },
    });

    await requestStageApproval({
      approvalId: approval.id,
      invoiceId,
      tenantId,
      stageIndex: nextStage,
      stage: nextStageSpec,
      invoice: invoiceData as Record<string, unknown>,
    });
  }
}

export async function getApprovalStatus(invoiceId: string): Promise<{
  approvalId: string;
  status: string;
  currentStage: number;
  totalStages: number;
  stageStartedAt: Date;
  decisions: Array<{
    stageIndex: number;
    outcome: string;
    actorType: string;
    actorId: string;
    comment: string | null;
    decidedAt: Date;
  }>;
  pendingApprovers: ApproverSpec[] | null;
} | null> {
  const approval = await prisma.invoiceApproval.findUnique({
    where: { invoiceId },
    include: {
      decisions: {
        orderBy: { decidedAt: 'asc' },
      },
    },
  });

  if (!approval) return null;

  let pendingApprovers: ApproverSpec[] | null = null;
  if (approval.status === ApprovalWorkflowStatus.pending) {
    const stages = z.array(policyStageSchema).parse(approval.stagesSnapshot);
    const current = stages[approval.currentStage];
    pendingApprovers = current?.approvers ?? null;
  }

  return {
    approvalId: approval.id,
    status: approval.status,
    currentStage: approval.currentStage,
    totalStages: approval.totalStages,
    stageStartedAt: approval.stageStartedAt,
    decisions: approval.decisions.map((d) => ({
      stageIndex: d.stageIndex,
      outcome: d.outcome,
      actorType: d.actorType,
      actorId: d.actorId,
      comment: d.comment,
      decidedAt: d.decidedAt,
    })),
    pendingApprovers,
  };
}

export async function handleEscalation(params: {
  approvalId: string;
  stageIndex: number;
  tenantId: string;
  invoiceId: string;
}): Promise<void> {
  const { approvalId, stageIndex, tenantId, invoiceId } = params;

  const approval = await prisma.invoiceApproval.findUnique({
    where: { id: approvalId },
    include: { decisions: { where: { stageIndex } } },
  });

  // Skip if already decided or moved past this stage
  if (!approval || approval.status !== ApprovalWorkflowStatus.pending) return;
  if (approval.currentStage !== stageIndex) return;
  if (approval.decisions.length > 0) return;

  const stages = z.array(policyStageSchema).parse(approval.stagesSnapshot);
  const stage = stages[stageIndex];
  if (!stage?.escalateTo) {
    // No escalation target configured — just fire a webhook warning
    await enqueueWebhookEvent(tenantId, 'invoice.approval_escalation_warning', {
      invoiceId,
      approvalId,
      stageIndex,
      message: 'Approval stage has timed out with no escalation target configured.',
    });
    return;
  }

  // Fire escalation webhook
  await enqueueWebhookEvent(tenantId, 'invoice.approval_escalated', {
    invoiceId,
    approvalId,
    stageIndex,
    escalatedTo: stage.escalateTo,
  });

  // Update the stage snapshot so the escalateTo approver becomes the primary
  const updatedStages = stages.map((s, i) =>
    i === stageIndex ? { ...s, approvers: [stage.escalateTo!] } : s,
  );

  await prisma.invoiceApproval.update({
    where: { id: approvalId },
    data: {
      stagesSnapshot: updatedStages as unknown as object,
      stageStartedAt: new Date(),
    },
  });

  const invoiceData = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, amountCents: true, currency: true, externalRef: true, status: true, metadata: true },
  });

  await requestStageApproval({
    approvalId,
    invoiceId,
    tenantId,
    stageIndex,
    stage: { ...stage, approvers: [stage.escalateTo] },
    invoice: invoiceData as Record<string, unknown>,
  });
}
