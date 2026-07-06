# Khata Books

Cloud accounting for SMEs in Bangladesh and similar markets — functionally in the
QuickBooks Online category, built as original software. Business owners get simple
workflows (invoice, get paid, pay bills, watch the bank); correct double-entry
bookkeeping happens invisibly underneath, and accountants get the journal,
period close, and full reporting.

**Demo login** (after seeding): `demo@khatabooks.app` / `demo1234` (owner) or
`accountant@khatabooks.app` / `demo1234`.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| API | Node.js 22+ (native TypeScript) + Express | Boring, mainstream, no build step |
| Database | PostgreSQL 16 + Knex migrations | The ledger invariants are enforced *in the database* with triggers |
| Money | `NUMERIC` columns surfaced as strings + decimal.js | No floats, ever |
| Frontend | React 18 + Vite + react-router | Plain CSS, no UI framework |
| Tests | Vitest + fast-check | Property-style tests of the ledger invariants |
| Exports | exceljs (XLSX), pdfkit (PDF) | Reports and branded invoice PDFs |

## The invariants

Enforced by Postgres triggers (`server/src/migrations/002_ledger.ts`), not just
application code — verified by tests that attack the DB with raw SQL:

1. **Balanced**: a posted journal entry must balance in both its transaction
   currency and the company base currency (deferred constraint trigger).
2. **Immutable**: posted entries and their lines reject `UPDATE`, `DELETE`, and
   line `INSERT`. Corrections are reversing entries only (`POST
   /ledger/journal/:id/reverse`); voiding a document posts reversals.
3. **Closed periods**: posting dated inside a closed period or fiscal year is
   rejected at commit time.

Every business document (invoice, bill, payment, credit note, expense claim,
bank rule, stock adjustment, FX revaluation) reduces to journal entries through
one posting service (`server/src/modules/ledger/posting.ts`).

## Feature map

- **Core ledger** — chart of accounts from a seedable template, manual journals,
  monthly periods + fiscal-year close/reopen, multi-currency journals with
  per-line base-currency amounts, realized FX gain/loss on settlement,
  unrealized FX revaluation with automatic next-day reversal.
- **Sales** — customers, quotes → invoices → payments/receipts, credit notes
  with application, recurring invoices (catch-up + auto-post), AR aging,
  customer statements, branded PDF invoices/quotes/credit notes.
- **Purchases** — vendors, bills, vendor credits, bill payments with VDS/AIT
  withholding at source, expense claims (approve → reimburse), AP aging.
- **Banking** — bank/cash accounts, CSV & OFX statement import with dedup,
  rules-based auto-matching (exact ledger match first, then rules that post
  entries), categorize/exclude workflow, reconciliation that only completes at
  a zero difference and then locks the lines.
- **Tax** — a configuration framework: rate, sales/purchase side accounts,
  withholding flag, report category, jurisdiction. Bangladesh ships as seed
  data (VAT 15/10/7.5/5/0/exempt per Mushak, VDS 15/7.5, AIT 2/3/5/10). Other
  jurisdictions are new `tax_codes` rows — no code changes.
- **Inventory** — items/services, weighted-average costing, stock on hand,
  COGS posted at average cost on sale, stock adjustments with balancing entries.
- **Reporting** — Trial Balance, P&L (with previous-period/year comparatives),
  Balance Sheet, Cash Flow (indirect, always reconciles), General Ledger,
  AR/AP aging, VAT & withholding summary, Stock on Hand, customer statements —
  every report exports to XLSX and PDF (`?format=xlsx|pdf`).
- **Platform** — multi-tenant company files, roles (owner / accountant /
  data_entry / read_only), audit trail on every posting, activity log.

## Setup

Prereqs: Node.js ≥ 22.7 (runs TypeScript natively; developed on Node 26),
PostgreSQL 16.

```bash
# 1. Postgres (macOS example)
brew install postgresql@16 && brew services start postgresql@16
createdb khata_dev && createdb khata_test   # khata_test only needed for tests

# 2. Install
npm install

# 3. Migrate + seed demo data
npm run migrate
npm run seed

# 4. Run (two terminals)
npm run dev:server   # API on :4000
npm run dev:web      # UI on :5173 (proxies /api to :4000)
```

Open http://localhost:5173 and sign in with the demo login above.

### Configuration

Environment variables (all optional in development):

| Var | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://localhost:5432/khata_dev` | Postgres connection |
| `JWT_SECRET` | dev value | **Set a strong value in production** |
| `PORT` | `4000` | API port |

### Tests

```bash
npm test          # 37 tests: unit, end-to-end flows, and fast-check property
                  # tests that post randomized entries and assert the trial
                  # balance never moves off 0.00
```

Tests run against `khata_test` and wipe it each run.

### Recurring invoices in production

`POST /api/companies/:id/sales/recurring-invoices/run` materializes due
schedules (idempotent, catches up missed periods). Call it daily from cron, or
use the "Run due now" button in the UI.

## Deployment sketch

1. Provision Postgres 16; set `DATABASE_URL` and a strong `JWT_SECRET`.
2. `npm ci && npm run migrate` on release.
3. Run the API with a process manager: `node server/src/index.ts`.
4. `npm run build -w web`, serve `web/dist/` from any static host/CDN, and
   proxy `/api/*` to the API process (nginx/Caddy).
5. Daily cron for recurring invoices (above). Back up Postgres; the ledger is
   append-only so PITR restores are safe.

## API docs

[docs/openapi.yaml](docs/openapi.yaml) — OpenAPI 3.0, viewable in any Swagger
UI/Redoc instance. Conventions: bearer JWT, company-scoped paths, decimal
strings for money, `YYYY-MM-DD` dates.

## Repository layout

```
server/
  src/migrations/       schema + trigger-enforced invariants (in-code knex source)
  src/modules/<area>/   routes.ts (HTTP + validation) and service.ts (logic)
  src/modules/ledger/   posting.ts — the single door into the journal
  scripts/              migrate.ts, seed.ts
  test/                 property + flow + report tests
web/src/pages/          one file per screen; Documents.tsx drives all doc types
docs/openapi.yaml       API reference
notes/                  engineering decision log
```
