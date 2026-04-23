-- Create enum
CREATE TYPE "VendorStatus" AS ENUM ('invited', 'pending_verification', 'active', 'suspended');

-- Create vendors table
CREATE TABLE "vendors" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "legal_name" TEXT,
  "tax_id" TEXT,
  "address" JSONB,
  "payment_preferences" JSONB,
  "contacts" JSONB,
  "status" "VendorStatus" NOT NULL DEFAULT 'invited',
  "invite_email" TEXT,
  "onboarding_token" TEXT,
  "token_expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- Link invoice to matched vendor
ALTER TABLE "invoices" ADD COLUMN "matched_vendor_id" TEXT;

-- Indexes
CREATE INDEX "vendors_tenant_id_status_idx" ON "vendors"("tenant_id", "status");
CREATE INDEX "vendors_tenant_id_name_idx" ON "vendors"("tenant_id", "name");
CREATE INDEX "invoices_tenant_id_matched_vendor_id_idx" ON "invoices"("tenant_id", "matched_vendor_id");

-- Foreign keys
ALTER TABLE "vendors"
  ADD CONSTRAINT "vendors_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_matched_vendor_id_fkey"
  FOREIGN KEY ("matched_vendor_id") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
