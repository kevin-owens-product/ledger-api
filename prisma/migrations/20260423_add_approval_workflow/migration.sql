-- AddApprovalWorkflow: enums, ApprovalPolicy, InvoiceApproval, ApprovalStageDecision
-- Also adds approval_pending to InvoiceStatus and InvoiceTransition from PRO-527

-- Extend InvoiceStatus enum
ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'draft';
ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'approval_pending';
ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'payment_pending';
ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'voided';

-- New enums for approval workflow
DO $$ BEGIN
    CREATE TYPE "ApprovalWorkflowStatus" AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "ApprovalDecisionOutcome" AS ENUM ('approved', 'rejected');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "TransitionActorType" AS ENUM ('user', 'system', 'agent', 'integration');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- InvoiceTransition audit table (PRO-527)
CREATE TABLE IF NOT EXISTS "invoice_transitions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "from_state" "InvoiceStatus",
    "to_state" "InvoiceStatus" NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_type" "TransitionActorType" NOT NULL,
    "reason" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_transitions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "invoice_transitions_tenant_id_invoice_id_timestamp_idx"
    ON "invoice_transitions"("tenant_id", "invoice_id", "timestamp" DESC);

ALTER TABLE "invoice_transitions"
    ADD CONSTRAINT "invoice_transitions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invoice_transitions"
    ADD CONSTRAINT "invoice_transitions_invoice_id_fkey"
    FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ApprovalPolicy
CREATE TABLE IF NOT EXISTS "approval_policies" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rules" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_policies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "approval_policies_tenant_id_is_active_idx"
    ON "approval_policies"("tenant_id", "is_active");

ALTER TABLE "approval_policies"
    ADD CONSTRAINT "approval_policies_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- InvoiceApproval
CREATE TABLE IF NOT EXISTS "invoice_approvals" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "policy_id" TEXT,
    "stages_snapshot" JSONB NOT NULL,
    "current_stage" INTEGER NOT NULL DEFAULT 0,
    "total_stages" INTEGER NOT NULL,
    "status" "ApprovalWorkflowStatus" NOT NULL DEFAULT 'pending',
    "stage_started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_approvals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "invoice_approvals_invoice_id_key"
    ON "invoice_approvals"("invoice_id");

CREATE INDEX IF NOT EXISTS "invoice_approvals_tenant_id_status_idx"
    ON "invoice_approvals"("tenant_id", "status");

ALTER TABLE "invoice_approvals"
    ADD CONSTRAINT "invoice_approvals_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invoice_approvals"
    ADD CONSTRAINT "invoice_approvals_invoice_id_fkey"
    FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invoice_approvals"
    ADD CONSTRAINT "invoice_approvals_policy_id_fkey"
    FOREIGN KEY ("policy_id") REFERENCES "approval_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ApprovalStageDecision
CREATE TABLE IF NOT EXISTS "approval_stage_decisions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "approval_id" TEXT NOT NULL,
    "stage_index" INTEGER NOT NULL,
    "outcome" "ApprovalDecisionOutcome" NOT NULL,
    "comment" TEXT,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_stage_decisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "approval_stage_decisions_approval_id_stage_index_idx"
    ON "approval_stage_decisions"("approval_id", "stage_index");

CREATE INDEX IF NOT EXISTS "approval_stage_decisions_tenant_id_idx"
    ON "approval_stage_decisions"("tenant_id");

ALTER TABLE "approval_stage_decisions"
    ADD CONSTRAINT "approval_stage_decisions_approval_id_fkey"
    FOREIGN KEY ("approval_id") REFERENCES "invoice_approvals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "approval_stage_decisions"
    ADD CONSTRAINT "approval_stage_decisions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
