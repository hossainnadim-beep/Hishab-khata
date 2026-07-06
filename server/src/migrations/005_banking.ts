import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE bank_imports (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id  uuid NOT NULL REFERENCES companies(id),
      account_id  uuid NOT NULL REFERENCES accounts(id),
      filename    text,
      format      text NOT NULL CHECK (format IN ('csv','ofx')),
      line_count  int NOT NULL DEFAULT 0,
      imported_by uuid REFERENCES users(id),
      created_at  timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE bank_txns (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id        uuid NOT NULL REFERENCES companies(id),
      account_id        uuid NOT NULL REFERENCES accounts(id),
      import_id         uuid REFERENCES bank_imports(id),
      txn_date          date NOT NULL,
      description       text NOT NULL DEFAULT '',
      reference         text,
      amount            numeric(18,2) NOT NULL,   -- signed: + money in, − money out
      ext_id            text NOT NULL,            -- OFX FITID or content hash; dedup key
      status            text NOT NULL DEFAULT 'unmatched'
                        CHECK (status IN ('unmatched','matched','reconciled','excluded')),
      matched_entry_id  uuid REFERENCES journal_entries(id),
      reconciliation_id uuid,
      created_at        timestamptz NOT NULL DEFAULT now(),
      UNIQUE (account_id, ext_id)
    );
    CREATE INDEX bank_txns_account_idx ON bank_txns (account_id, status, txn_date);

    CREATE TABLE bank_rules (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id        uuid NOT NULL REFERENCES companies(id),
      account_id        uuid REFERENCES accounts(id),  -- null = all bank accounts
      name              text NOT NULL,
      match_type        text NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains','regex')),
      pattern           text NOT NULL,
      direction         text NOT NULL DEFAULT 'any' CHECK (direction IN ('in','out','any')),
      contact_id        uuid REFERENCES contacts(id),
      target_account_id uuid NOT NULL REFERENCES accounts(id),
      tax_code_id       uuid REFERENCES tax_codes(id),
      priority          int NOT NULL DEFAULT 100,
      active            boolean NOT NULL DEFAULT true,
      created_at        timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE reconciliations (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id        uuid NOT NULL REFERENCES companies(id),
      account_id        uuid NOT NULL REFERENCES accounts(id),
      statement_date    date NOT NULL,
      statement_balance numeric(18,2) NOT NULL,
      status            text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
      completed_at      timestamptz,
      created_by        uuid REFERENCES users(id),
      created_at        timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE bank_txns
      ADD CONSTRAINT bank_txns_reconciliation_fk
      FOREIGN KEY (reconciliation_id) REFERENCES reconciliations(id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS bank_txns, bank_rules, reconciliations, bank_imports CASCADE;
  `);
}
