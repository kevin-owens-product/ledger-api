import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env } from '../config/env.js';

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export interface LineItemInput {
  description: string;
  amountCents: number;
  currency?: string;
  vendor?: string;
}

export interface GLCodeCandidate {
  glCode: string;
  glLabel: string;
  confidence: number;
  rationale: string;
}

export interface GLLineItemResult {
  lineItemIndex: number;
  candidates: GLCodeCandidate[];
}

export interface ChartOfAccountsEntry {
  code: string;
  label: string;
  category?: string;
}

export interface GLHistoryExample {
  description: string;
  vendor?: string;
  amountCents?: number;
  glCode: string;
  glLabel: string;
}

// Cached static system prompt (>1024 tokens — qualifies for prompt caching)
const SYSTEM_PROMPT_STATIC = `You are a financial GL coding expert for accounts payable (AP) automation. Your job is to classify invoice line items to the correct General Ledger (GL) accounts.

## US GAAP Standard Chart of Accounts

Use these ranges as defaults when the tenant has not specified a custom chart:

### Assets (1000–1999)
- 1100: Cash & Cash Equivalents
- 1200: Accounts Receivable
- 1300: Inventory
- 1400: Prepaid Expenses
- 1500: Fixed Assets / Property, Plant & Equipment
- 1600: Accumulated Depreciation

### Liabilities (2000–2999)
- 2100: Accounts Payable
- 2200: Accrued Liabilities
- 2300: Deferred Revenue
- 2400: Notes Payable / Long-term Debt

### Equity (3000–3999)
- 3100: Common Stock / Paid-in Capital
- 3200: Retained Earnings

### Revenue (4000–4999)
- 4100: Product Revenue
- 4200: Service Revenue
- 4300: Subscription Revenue

### Cost of Goods Sold (5000–5999)
- 5100: Direct Materials / Cost of Revenue
- 5200: Direct Labor (billable)
- 5300: Manufacturing Overhead
- 5400: Shipping & Fulfillment (customer orders)
- 5500: Cloud Infrastructure (revenue-generating, COGS-eligible)

### Operating Expenses (6000–6999)

#### General & Administrative (6100–6199)
- 6110: Office Supplies & Consumables
- 6120: Professional Services (Legal, Accounting, Consulting)
- 6130: Business Insurance
- 6140: Utilities (electric, gas, water, phone)
- 6150: Rent & Facilities
- 6155: Equipment Rental & Leases
- 6160: Software Subscriptions (non-engineering)
- 6170: Postage & Shipping (internal)
- 6180: Bank Fees & Merchant Fees

#### Sales & Marketing (6200–6299)
- 6210: Digital Advertising (Google, Meta, LinkedIn)
- 6220: Print, Events & Sponsorships
- 6230: Sales Commissions & Referral Fees
- 6240: PR & Communications
- 6250: CRM & Marketing Software

#### Research & Development (6300–6399)
- 6310: Software Development (engineering tools & contractors)
- 6320: R&D Contractor Fees
- 6330: Prototyping, Testing & QA
- 6340: IP & Patent Filings

#### IT & Technology (6500–6599)
- 6510: Hardware & Equipment (internal use)
- 6520: Software Licenses (per-seat SaaS)
- 6530: Cloud & Hosting Services (internal/overhead)
- 6540: IT Support & Managed Services
- 6550: Security & Compliance Tools
- 6560: Data & Analytics Subscriptions

#### Travel & Entertainment (6600–6699)
- 6610: Business Travel (flights, hotels, ground transportation)
- 6620: Meals & Entertainment (business purpose)
- 6630: Conferences, Training & Education
- 6640: Employee Relocation

#### Depreciation & Amortization (6700–6799)
- 6710: Depreciation — Equipment & Furniture
- 6720: Amortization — Capitalized Software
- 6730: Amortization — Intangibles (patents, trademarks)

### Other Income / Expense (7000–7999)
- 7100: Interest Income
- 7200: Interest Expense
- 7300: Gain/Loss on Asset Disposal

## Classification Guidelines

1. **Specificity first**: Prefer the most specific applicable code. "AWS compute invoice" → 6530 (Cloud & Hosting), not 6500 (IT general).
2. **COGS vs. OpEx**: Code to 5000s when expense directly produces customer-facing revenue (e.g., cloud infrastructure serving customers). Code to 6000s for internal/overhead spend.
3. **Amount signals**: Large amounts ($10,000+) for "services" lean toward 6120 (Professional Services). Small amounts ($0–$200) for "supplies" lean toward 6110.
4. **Vendor signals**:
   - Cloud providers (AWS, Azure, GCP) → 6530 or 5500 depending on COGS/OpEx split
   - SaaS CRM/sales tools (Salesforce, HubSpot) → 6250
   - Legal/accounting firms → 6120
   - Staffing/contractor agencies → 6310 or 6120
   - Advertising platforms → 6210
5. **Confidence scoring**:
   - 0.90–1.00: near-certain match (clear vendor + description + amount)
   - 0.70–0.89: likely match (good description, minor ambiguity)
   - 0.50–0.69: reasonable guess (ambiguous description or unfamiliar vendor)
   - below 0.50: uncertain (still include if no better option exists)
6. **Always return 3 candidates** ordered by confidence descending, unless the item unambiguously matches exactly 1 code — then return 1. Aim for 3.`;

const GL_CODING_TOOL: Anthropic.Tool = {
  name: 'classify_line_items',
  description: 'Classify invoice line items to GL accounts. Return top-3 candidates per item ordered by confidence descending.',
  input_schema: {
    type: 'object' as const,
    properties: {
      classifications: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            line_item_index: {
              type: 'integer',
              description: 'Zero-based index matching the input line_items array',
            },
            candidates: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  gl_code: { type: 'string', description: 'GL account code (e.g. "6530")' },
                  gl_label: { type: 'string', description: 'GL account name (e.g. "Cloud & Hosting Services")' },
                  confidence: { type: 'number', description: 'Confidence score 0.0–1.0' },
                  rationale: { type: 'string', description: 'One sentence explaining why this GL code fits' },
                },
                required: ['gl_code', 'gl_label', 'confidence', 'rationale'],
              },
              minItems: 1,
              maxItems: 3,
            },
          },
          required: ['line_item_index', 'candidates'],
        },
      },
    },
    required: ['classifications'],
  },
};

const candidateSchema = z.object({
  gl_code: z.string(),
  gl_label: z.string(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

const toolOutputSchema = z.object({
  classifications: z.array(
    z.object({
      line_item_index: z.number().int().min(0),
      candidates: z.array(candidateSchema).min(1).max(3),
    }),
  ),
});

function formatAmountForPrompt(amountCents: number, currency = 'USD'): string {
  const amount = amountCents / 100;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}

function buildDynamicContext(
  chartOfAccounts: ChartOfAccountsEntry[] | undefined,
  historyExamples: GLHistoryExample[],
): string {
  const parts: string[] = [];

  if (chartOfAccounts && chartOfAccounts.length > 0) {
    parts.push('## Tenant Chart of Accounts (use these codes — they override GAAP defaults)');
    for (const entry of chartOfAccounts) {
      parts.push(`- ${entry.code}: ${entry.label}${entry.category ? ` (${entry.category})` : ''}`);
    }
    parts.push('');
  }

  if (historyExamples.length > 0) {
    parts.push('## Past Accepted Classifications (few-shot examples for this tenant)');
    for (const ex of historyExamples) {
      const amount = ex.amountCents != null ? ` | ${formatAmountForPrompt(ex.amountCents)}` : '';
      const vendor = ex.vendor ? ` | vendor: ${ex.vendor}` : '';
      parts.push(`- "${ex.description}"${vendor}${amount} → ${ex.glCode} (${ex.glLabel})`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

function buildUserMessage(lineItems: LineItemInput[], dynamicContext: string): string {
  const itemsList = lineItems
    .map((item, i) => {
      const amount = formatAmountForPrompt(item.amountCents, item.currency);
      const vendor = item.vendor ? ` | vendor: "${item.vendor}"` : '';
      return `${i}. description: "${item.description}"${vendor} | amount: ${amount}`;
    })
    .join('\n');

  return `${dynamicContext}## Line Items to Classify

${itemsList}

Use the classify_line_items tool to return GL code candidates for each line item.`;
}

export async function classifyLineItems(params: {
  lineItems: LineItemInput[];
  chartOfAccounts?: ChartOfAccountsEntry[];
  historyExamples?: GLHistoryExample[];
}): Promise<GLLineItemResult[]> {
  const { lineItems, chartOfAccounts, historyExamples = [] } = params;

  if (lineItems.length === 0) {
    return [];
  }

  const dynamicContext = buildDynamicContext(chartOfAccounts, historyExamples);
  const userMessage = buildUserMessage(lineItems, dynamicContext);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT_STATIC,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userMessage }],
    tools: [
      {
        ...GL_CODING_TOOL,
        cache_control: { type: 'ephemeral' },
      } as Anthropic.Tool,
    ],
    tool_choice: { type: 'tool', name: 'classify_line_items' },
  });

  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
  if (!toolUse) {
    throw new Error('GL coding engine did not return a tool_use response');
  }

  const parsed = toolOutputSchema.parse(toolUse.input);

  return parsed.classifications.map((c) => ({
    lineItemIndex: c.line_item_index,
    candidates: c.candidates.map((candidate) => ({
      glCode: candidate.gl_code,
      glLabel: candidate.gl_label,
      confidence: candidate.confidence,
      rationale: candidate.rationale,
    })),
  }));
}
