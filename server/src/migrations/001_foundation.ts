import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE users (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email         text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      name          text NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE companies (
      id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name                    text NOT NULL,
      legal_name              text,
      country                 text NOT NULL DEFAULT 'BD',
      base_currency           char(3) NOT NULL DEFAULT 'BDT',
      fiscal_year_start_month int NOT NULL DEFAULT 7 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
      tax_registration_no     text,          -- BIN for Bangladesh
      address                 text,
      phone                   text,
      email                   text,
      invoice_logo_text       text,          -- simple branded header line for PDFs
      invoice_footer          text,
      next_entry_no           bigint NOT NULL DEFAULT 1,
      created_at              timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE memberships (
      user_id    uuid NOT NULL REFERENCES users(id),
      company_id uuid NOT NULL REFERENCES companies(id),
      role       text NOT NULL CHECK (role IN ('owner','accountant','data_entry','read_only')),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, company_id)
    );

    CREATE TABLE audit_log (
      id          bigserial PRIMARY KEY,
      company_id  uuid NOT NULL REFERENCES companies(id),
      user_id     uuid REFERENCES users(id),
      action      text NOT NULL,            -- e.g. invoice.created, journal.posted
      entity_type text NOT NULL,
      entity_id   text,
      details     jsonb,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX audit_log_company_idx ON audit_log (company_id, created_at DESC);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS audit_log;
    DROP TABLE IF EXISTS memberships;
    DROP TABLE IF EXISTS companies;
    DROP TABLE IF EXISTS users;
  `);
}
