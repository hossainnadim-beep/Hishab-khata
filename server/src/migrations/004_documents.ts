import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE contacts (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id         uuid NOT NULL REFERENCES companies(id),
      name               text NOT NULL,
      is_customer        boolean NOT NULL DEFAULT false,
      is_vendor          boolean NOT NULL DEFAULT false,
      email              text,
      phone              text,
      address            text,
      tax_reg_no         text,             -- BIN/VAT registration
      currency           char(3),          -- default document currency for this contact
      payment_terms_days int NOT NULL DEFAULT 30,
      archived           boolean NOT NULL DEFAULT false,
      created_at         timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX contacts_company_idx ON contacts (company_id);

    CREATE TABLE doc_sequences (
      company_id uuid NOT NULL REFERENCES companies(id),
      doc_type   text NOT NULL,
      next_no    bigint NOT NULL DEFAULT 1,
      PRIMARY KEY (company_id, doc_type)
    );

    CREATE TABLE items (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id           uuid NOT NULL REFERENCES companies(id),
      name                 text NOT NULL,
      sku                  text,
      type                 text NOT NULL DEFAULT 'service' CHECK (type IN ('inventory','service')),
      description          text,
      sale_price           numeric(18,6) NOT NULL DEFAULT 0,
      purchase_price       numeric(18,6) NOT NULL DEFAULT 0,
      income_account_id    uuid REFERENCES accounts(id),
      expense_account_id   uuid REFERENCES accounts(id),   -- COGS for inventory items
      inventory_account_id uuid REFERENCES accounts(id),
      tax_code_id          uuid REFERENCES tax_codes(id),
      qty_on_hand          numeric(18,4) NOT NULL DEFAULT 0,
      avg_cost             numeric(18,6) NOT NULL DEFAULT 0,
      archived             boolean NOT NULL DEFAULT false,
      created_at           timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, name)
    );

    CREATE TABLE item_movements (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id    uuid NOT NULL REFERENCES companies(id),
      item_id       uuid NOT NULL REFERENCES items(id),
      movement_date date NOT NULL,
      qty_delta     numeric(18,4) NOT NULL,
      unit_cost     numeric(18,6) NOT NULL DEFAULT 0,  -- cost per unit for this movement
      source_type   text NOT NULL,
      source_id     uuid,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX item_movements_item_idx ON item_movements (item_id, created_at);

    CREATE TABLE quotes (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id    uuid NOT NULL REFERENCES companies(id),
      customer_id   uuid NOT NULL REFERENCES contacts(id),
      doc_no        text NOT NULL,
      status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','declined','invoiced')),
      issue_date    date NOT NULL,
      expiry_date   date,
      currency      char(3) NOT NULL,
      exchange_rate numeric(20,10) NOT NULL DEFAULT 1,
      amounts_are   text NOT NULL DEFAULT 'exclusive' CHECK (amounts_are IN ('exclusive','inclusive','no_tax')),
      subtotal      numeric(18,2) NOT NULL DEFAULT 0,
      tax_total     numeric(18,2) NOT NULL DEFAULT 0,
      total         numeric(18,2) NOT NULL DEFAULT 0,
      memo          text,
      created_by    uuid REFERENCES users(id),
      created_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, doc_no)
    );

    CREATE TABLE quote_lines (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      quote_id     uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      line_no      int NOT NULL,
      item_id      uuid REFERENCES items(id),
      description  text,
      qty          numeric(18,4) NOT NULL DEFAULT 1,
      unit_price   numeric(18,6) NOT NULL DEFAULT 0,
      discount_pct numeric(5,2) NOT NULL DEFAULT 0,
      account_id   uuid REFERENCES accounts(id),
      tax_code_id  uuid REFERENCES tax_codes(id),
      net_amount   numeric(18,2) NOT NULL DEFAULT 0,
      tax_amount   numeric(18,2) NOT NULL DEFAULT 0
    );

    CREATE TABLE invoices (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id           uuid NOT NULL REFERENCES companies(id),
      customer_id          uuid NOT NULL REFERENCES contacts(id),
      doc_no               text NOT NULL,
      status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','paid','voided')),
      issue_date           date NOT NULL,
      due_date             date NOT NULL,
      currency             char(3) NOT NULL,
      exchange_rate        numeric(20,10) NOT NULL DEFAULT 1,
      amounts_are          text NOT NULL DEFAULT 'exclusive' CHECK (amounts_are IN ('exclusive','inclusive','no_tax')),
      subtotal             numeric(18,2) NOT NULL DEFAULT 0,
      tax_total            numeric(18,2) NOT NULL DEFAULT 0,
      total                numeric(18,2) NOT NULL DEFAULT 0,
      balance_due          numeric(18,2) NOT NULL DEFAULT 0,   -- in document currency
      memo                 text,
      quote_id             uuid REFERENCES quotes(id),
      recurring_id         uuid,
      journal_entry_id     uuid REFERENCES journal_entries(id),
      void_journal_entry_id uuid REFERENCES journal_entries(id),
      created_by           uuid REFERENCES users(id),
      created_at           timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, doc_no)
    );
    CREATE INDEX invoices_company_status_idx ON invoices (company_id, status);
    CREATE INDEX invoices_customer_idx ON invoices (customer_id);

    CREATE TABLE invoice_lines (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id   uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      line_no      int NOT NULL,
      item_id      uuid REFERENCES items(id),
      description  text,
      qty          numeric(18,4) NOT NULL DEFAULT 1,
      unit_price   numeric(18,6) NOT NULL DEFAULT 0,
      discount_pct numeric(5,2) NOT NULL DEFAULT 0,
      account_id   uuid REFERENCES accounts(id),
      tax_code_id  uuid REFERENCES tax_codes(id),
      net_amount   numeric(18,2) NOT NULL DEFAULT 0,
      tax_amount   numeric(18,2) NOT NULL DEFAULT 0
    );

    CREATE TABLE credit_notes (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id           uuid NOT NULL REFERENCES companies(id),
      customer_id          uuid NOT NULL REFERENCES contacts(id),
      doc_no               text NOT NULL,
      status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','applied','voided')),
      issue_date           date NOT NULL,
      currency             char(3) NOT NULL,
      exchange_rate        numeric(20,10) NOT NULL DEFAULT 1,
      amounts_are          text NOT NULL DEFAULT 'exclusive' CHECK (amounts_are IN ('exclusive','inclusive','no_tax')),
      subtotal             numeric(18,2) NOT NULL DEFAULT 0,
      tax_total            numeric(18,2) NOT NULL DEFAULT 0,
      total                numeric(18,2) NOT NULL DEFAULT 0,
      balance               numeric(18,2) NOT NULL DEFAULT 0,  -- unapplied remainder
      memo                 text,
      journal_entry_id     uuid REFERENCES journal_entries(id),
      void_journal_entry_id uuid REFERENCES journal_entries(id),
      created_by           uuid REFERENCES users(id),
      created_at           timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, doc_no)
    );

    CREATE TABLE credit_note_lines (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      credit_note_id uuid NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
      line_no        int NOT NULL,
      item_id        uuid REFERENCES items(id),
      description    text,
      qty            numeric(18,4) NOT NULL DEFAULT 1,
      unit_price     numeric(18,6) NOT NULL DEFAULT 0,
      discount_pct   numeric(5,2) NOT NULL DEFAULT 0,
      account_id     uuid REFERENCES accounts(id),
      tax_code_id    uuid REFERENCES tax_codes(id),
      net_amount     numeric(18,2) NOT NULL DEFAULT 0,
      tax_amount     numeric(18,2) NOT NULL DEFAULT 0
    );

    CREATE TABLE credit_note_applications (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      credit_note_id uuid NOT NULL REFERENCES credit_notes(id),
      invoice_id     uuid NOT NULL REFERENCES invoices(id),
      amount         numeric(18,2) NOT NULL CHECK (amount > 0),
      applied_at     timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE bills (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id           uuid NOT NULL REFERENCES companies(id),
      vendor_id            uuid NOT NULL REFERENCES contacts(id),
      doc_no               text NOT NULL,                       -- internal number
      vendor_ref           text,                                -- vendor's invoice number
      status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','paid','voided')),
      issue_date           date NOT NULL,
      due_date             date NOT NULL,
      currency             char(3) NOT NULL,
      exchange_rate        numeric(20,10) NOT NULL DEFAULT 1,
      amounts_are          text NOT NULL DEFAULT 'exclusive' CHECK (amounts_are IN ('exclusive','inclusive','no_tax')),
      subtotal             numeric(18,2) NOT NULL DEFAULT 0,
      tax_total            numeric(18,2) NOT NULL DEFAULT 0,
      total                numeric(18,2) NOT NULL DEFAULT 0,
      balance_due          numeric(18,2) NOT NULL DEFAULT 0,
      memo                 text,
      journal_entry_id     uuid REFERENCES journal_entries(id),
      void_journal_entry_id uuid REFERENCES journal_entries(id),
      created_by           uuid REFERENCES users(id),
      created_at           timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, doc_no)
    );
    CREATE INDEX bills_company_status_idx ON bills (company_id, status);

    CREATE TABLE bill_lines (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bill_id      uuid NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      line_no      int NOT NULL,
      item_id      uuid REFERENCES items(id),
      description  text,
      qty          numeric(18,4) NOT NULL DEFAULT 1,
      unit_price   numeric(18,6) NOT NULL DEFAULT 0,
      discount_pct numeric(5,2) NOT NULL DEFAULT 0,
      account_id   uuid REFERENCES accounts(id),
      tax_code_id  uuid REFERENCES tax_codes(id),
      net_amount   numeric(18,2) NOT NULL DEFAULT 0,
      tax_amount   numeric(18,2) NOT NULL DEFAULT 0
    );

    CREATE TABLE vendor_credits (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id           uuid NOT NULL REFERENCES companies(id),
      vendor_id            uuid NOT NULL REFERENCES contacts(id),
      doc_no               text NOT NULL,
      status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','applied','voided')),
      issue_date           date NOT NULL,
      currency             char(3) NOT NULL,
      exchange_rate        numeric(20,10) NOT NULL DEFAULT 1,
      amounts_are          text NOT NULL DEFAULT 'exclusive' CHECK (amounts_are IN ('exclusive','inclusive','no_tax')),
      subtotal             numeric(18,2) NOT NULL DEFAULT 0,
      tax_total            numeric(18,2) NOT NULL DEFAULT 0,
      total                numeric(18,2) NOT NULL DEFAULT 0,
      balance              numeric(18,2) NOT NULL DEFAULT 0,
      memo                 text,
      journal_entry_id     uuid REFERENCES journal_entries(id),
      void_journal_entry_id uuid REFERENCES journal_entries(id),
      created_by           uuid REFERENCES users(id),
      created_at           timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, doc_no)
    );

    CREATE TABLE vendor_credit_lines (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      vendor_credit_id uuid NOT NULL REFERENCES vendor_credits(id) ON DELETE CASCADE,
      line_no          int NOT NULL,
      item_id          uuid REFERENCES items(id),
      description      text,
      qty              numeric(18,4) NOT NULL DEFAULT 1,
      unit_price       numeric(18,6) NOT NULL DEFAULT 0,
      discount_pct     numeric(5,2) NOT NULL DEFAULT 0,
      account_id       uuid REFERENCES accounts(id),
      tax_code_id      uuid REFERENCES tax_codes(id),
      net_amount       numeric(18,2) NOT NULL DEFAULT 0,
      tax_amount       numeric(18,2) NOT NULL DEFAULT 0
    );

    CREATE TABLE vendor_credit_applications (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      vendor_credit_id uuid NOT NULL REFERENCES vendor_credits(id),
      bill_id          uuid NOT NULL REFERENCES bills(id),
      amount           numeric(18,2) NOT NULL CHECK (amount > 0),
      applied_at       timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE payments (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id         uuid NOT NULL REFERENCES companies(id),
      kind               text NOT NULL CHECK (kind IN ('receive','pay')),
      contact_id         uuid NOT NULL REFERENCES contacts(id),
      doc_no             text NOT NULL,
      payment_date       date NOT NULL,
      currency           char(3) NOT NULL,
      exchange_rate      numeric(20,10) NOT NULL DEFAULT 1,
      amount             numeric(18,2) NOT NULL DEFAULT 0,     -- cash moved, in payment currency
      deposit_account_id uuid NOT NULL REFERENCES accounts(id), -- bank/cash/undeposited
      reference          text,
      memo               text,
      status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
      journal_entry_id   uuid REFERENCES journal_entries(id),
      void_journal_entry_id uuid REFERENCES journal_entries(id),
      created_by         uuid REFERENCES users(id),
      created_at         timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, doc_no)
    );
    CREATE INDEX payments_company_idx ON payments (company_id, payment_date);

    CREATE TABLE payment_allocations (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_id uuid NOT NULL REFERENCES payments(id),
      doc_type   text NOT NULL CHECK (doc_type IN ('invoice','bill')),
      doc_id     uuid NOT NULL,
      amount     numeric(18,2) NOT NULL CHECK (amount > 0)    -- gross amount settled, doc currency
    );
    CREATE INDEX payment_allocations_doc_idx ON payment_allocations (doc_type, doc_id);

    -- Withholding deducted at source as part of a payment (VDS / AIT).
    CREATE TABLE payment_withholdings (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_id  uuid NOT NULL REFERENCES payments(id),
      tax_code_id uuid NOT NULL REFERENCES tax_codes(id),
      base_amount numeric(18,2) NOT NULL DEFAULT 0,
      amount      numeric(18,2) NOT NULL CHECK (amount >= 0)
    );

    CREATE TABLE recurring_invoices (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id    uuid NOT NULL REFERENCES companies(id),
      customer_id   uuid NOT NULL REFERENCES contacts(id),
      name          text NOT NULL,
      template      jsonb NOT NULL,          -- invoice body: lines, currency, terms, memo
      frequency     text NOT NULL CHECK (frequency IN ('weekly','monthly')),
      every_n       int NOT NULL DEFAULT 1 CHECK (every_n >= 1),
      next_run_date date NOT NULL,
      end_date      date,
      last_run_date date,
      auto_post     boolean NOT NULL DEFAULT false,
      active        boolean NOT NULL DEFAULT true,
      created_at    timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE expense_claims (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id       uuid NOT NULL REFERENCES companies(id),
      claimant         text NOT NULL,
      doc_no           text NOT NULL,
      status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','reimbursed','voided')),
      claim_date       date NOT NULL,
      currency         char(3) NOT NULL,
      exchange_rate    numeric(20,10) NOT NULL DEFAULT 1,
      total            numeric(18,2) NOT NULL DEFAULT 0,
      memo             text,
      journal_entry_id uuid REFERENCES journal_entries(id),
      reimburse_journal_entry_id uuid REFERENCES journal_entries(id),
      created_by       uuid REFERENCES users(id),
      created_at       timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, doc_no)
    );

    CREATE TABLE expense_claim_lines (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      claim_id     uuid NOT NULL REFERENCES expense_claims(id) ON DELETE CASCADE,
      line_no      int NOT NULL,
      expense_date date NOT NULL,
      account_id   uuid NOT NULL REFERENCES accounts(id),
      description  text,
      amount       numeric(18,2) NOT NULL DEFAULT 0,   -- gross
      tax_code_id  uuid REFERENCES tax_codes(id),
      net_amount   numeric(18,2) NOT NULL DEFAULT 0,
      tax_amount   numeric(18,2) NOT NULL DEFAULT 0
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS expense_claim_lines, expense_claims, recurring_invoices,
      payment_withholdings, payment_allocations, payments,
      vendor_credit_applications, vendor_credit_lines, vendor_credits,
      bill_lines, bills,
      credit_note_applications, credit_note_lines, credit_notes,
      invoice_lines, invoices, quote_lines, quotes,
      item_movements, items, doc_sequences, contacts CASCADE;
  `);
}
