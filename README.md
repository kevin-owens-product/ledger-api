# Ledger API (Multi-tenant Skeleton)

Foundational API server for Ledger with tenant isolation, invoice CRUD, webhook delivery, and operational endpoints.

## Stack

- Node.js + TypeScript
- Fastify
- PostgreSQL + Prisma
- Redis + BullMQ

## Quick start

1. Copy env file:

```bash
cp .env.example .env
```

2. Start local dependencies:

```bash
docker compose up -d
```

3. Install deps:

```bash
npm install
```

4. Generate Prisma client + run migrations:

```bash
npm run prisma:generate
npm run prisma:migrate -- --name init
```

5. Run API and worker (separate terminals):

```bash
npm run dev
npm run worker
```

## API endpoints

- `GET /health` — liveness
- `GET /v1/status` — readiness (DB + queue depth)
- `POST /v1/invoices`
- `GET /v1/invoices`
- `GET /v1/invoices/:id`
- `GET /v1/invoices/:id/history`
- `PATCH /v1/invoices/:id` (status transitions enforced)
- `DELETE /v1/invoices/:id` (soft delete)
- `GET /v1/vendors` (supports fuzzy query `?q=acme`)
- `POST /v1/vendors`
- `GET /v1/vendors/:id`
- `PATCH /v1/vendors/:id`
- `DELETE /v1/vendors/:id`
- `POST /v1/vendors/invite`
- `POST /v1/vendors/:id/onboarding`
- `GET /v1/vendors/:id/invoices`
- `POST /v1/vendors/:id/payment-methods`

## Invoice state machine

Lifecycle:

`draft -> submitted -> gl_coded -> approval_pending -> approved -> payment_pending -> paid`

Alternative terminal branches:

- `rejected`
- `voided`

Guards:

- Only `approved` invoices may transition to `payment_pending`.
- `paid` and `voided` are terminal.
- Invalid transitions return `422` with allowed transition metadata.

Every status transition is stored in `invoice_transitions` and emits a webhook event named by destination state (for example `invoice.submitted`, `invoice.approved`).

Guard:

- Invoices linked to `suspended` vendors cannot transition past `submitted`.

## Vendor onboarding and TIN verification

- Invite flow creates vendor in `invited` status and emits `vendor.invite_sent`.
- Onboarding updates vendor to `pending_verification` and enqueues async TIN verification (`verify-tin` job).
- Worker emits:
  - `vendor.tin_verified` and sets vendor status to `active`
  - `vendor.tin_failed` and sets vendor status to `suspended`

## Auth model

Protected routes require:

```http
Authorization: Bearer <api-key-or-jwt>
```

- API key auth: compares bearer token against `tenants.api_key_hash` values.
- Bearer token auth: verifies JWT with `API_JWT_SECRET`, expects `tenantId` claim.

## Multi-tenant isolation

- Tenant resolved in auth middleware.
- Tenant context stored in async-local storage.
- Prisma query extension automatically scopes tenant models (`Invoice`, `WebhookEvent`) by `tenantId`.

## Webhooks

- Events persisted in `webhook_events`.
- Background worker delivers events to tenant webhook URL.
- HMAC SHA256 signature in `x-ledger-signature`.
- Exponential backoff with max retries controlled by `WEBHOOK_RETRY_LIMIT`.

## Error shape

All API errors use:

```json
{
  "error": {
    "code": "STRING_CODE",
    "message": "Human-readable message",
    "details": {}
  }
}
```
