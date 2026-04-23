-- Create transition actor enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TransitionActorType') THEN
    CREATE TYPE "TransitionActorType" AS ENUM ('user', 'system', 'agent', 'integration');
  END IF;
END
$$;

-- Expand and normalize invoice status lifecycle
ALTER TYPE "InvoiceStatus" RENAME TO "InvoiceStatus_old";
CREATE TYPE "InvoiceStatus" AS ENUM (
  'draft',
  'submitted',
  'gl_coded',
  'approval_pending',
  'approved',
  'payment_pending',
  'paid',
  'rejected',
  'voided'
);

ALTER TABLE "invoices" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "invoices"
  ALTER COLUMN "status" TYPE "InvoiceStatus"
  USING (
    CASE "status"::text
      WHEN 'received' THEN 'draft'
      WHEN 'validated' THEN 'gl_coded'
      WHEN 'submitted' THEN 'submitted'
      WHEN 'gl_coded' THEN 'gl_coded'
      WHEN 'approval_pending' THEN 'approval_pending'
      WHEN 'approved' THEN 'approved'
      WHEN 'payment_pending' THEN 'payment_pending'
      WHEN 'paid' THEN 'paid'
      WHEN 'rejected' THEN 'rejected'
      WHEN 'voided' THEN 'voided'
      ELSE 'draft'
    END
  )::"InvoiceStatus";

ALTER TABLE "invoices" ALTER COLUMN "status" SET DEFAULT 'draft';
DROP TYPE "InvoiceStatus_old";

-- Add transition audit table
CREATE TABLE "invoice_transitions" (
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

CREATE INDEX "invoice_transitions_tenant_id_invoice_id_timestamp_idx"
  ON "invoice_transitions"("tenant_id", "invoice_id", "timestamp" DESC);

ALTER TABLE "invoice_transitions"
  ADD CONSTRAINT "invoice_transitions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invoice_transitions"
  ADD CONSTRAINT "invoice_transitions_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
