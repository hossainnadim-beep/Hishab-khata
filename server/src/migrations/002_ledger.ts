import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE accounts (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES companies(id),
      code       text NOT NULL,
      name       text NOT NULL,
      type       text NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
      subtype    text,
      currency   char(3),                 -- non-null only for currency-specific accounts (e.g. USD bank)
      is_system  boolean NOT NULL DEFAULT false,
      parent_id  uuid REFERENCES accounts(id),
      archived   boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, code)
    );
    CREATE INDEX accounts_company_idx ON accounts (company_id);

    -- Maps well-known roles (AR control, VAT output, rounding, ...) to accounts per company.
    CREATE TABLE company_accounts (
      company_id uuid NOT NULL REFERENCES companies(id),
      purpose    text NOT NULL,
      account_id uuid NOT NULL REFERENCES accounts(id),
      PRIMARY KEY (company_id, purpose)
    );

    CREATE TABLE fiscal_years (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES companies(id),
      start_date date NOT NULL,
      end_date   date NOT NULL,
      status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      UNIQUE (company_id, start_date)
    );

    CREATE TABLE accounting_periods (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id     uuid NOT NULL REFERENCES companies(id),
      fiscal_year_id uuid NOT NULL REFERENCES fiscal_years(id),
      start_date     date NOT NULL,
      end_date       date NOT NULL,
      status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      UNIQUE (company_id, start_date)
    );

    CREATE TABLE journal_entries (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id         uuid NOT NULL REFERENCES companies(id),
      entry_no           bigint NOT NULL,
      txn_date           date NOT NULL,
      currency           char(3) NOT NULL,
      exchange_rate      numeric(20,10) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
      memo               text,
      source_type        text NOT NULL DEFAULT 'manual',
      source_id          uuid,
      status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted')),
      reverses_entry_id  uuid REFERENCES journal_entries(id),
      created_by         uuid REFERENCES users(id),
      posted_by          uuid REFERENCES users(id),
      posted_at          timestamptz,
      created_at         timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, entry_no)
    );
    CREATE INDEX je_company_date_idx ON journal_entries (company_id, txn_date);
    CREATE INDEX je_source_idx ON journal_entries (source_type, source_id);

    CREATE TABLE journal_lines (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entry_id    uuid NOT NULL REFERENCES journal_entries(id),
      line_no     int NOT NULL,
      account_id  uuid NOT NULL REFERENCES accounts(id),
      description text,
      -- amounts in the entry's transaction currency
      debit       numeric(18,2) NOT NULL DEFAULT 0,
      credit      numeric(18,2) NOT NULL DEFAULT 0,
      -- amounts converted to the company base currency
      base_debit  numeric(18,2) NOT NULL DEFAULT 0,
      base_credit numeric(18,2) NOT NULL DEFAULT 0,
      contact_id  uuid,                    -- customer/vendor link for subledgers
      tax_code_id uuid,
      UNIQUE (entry_id, line_no),
      CHECK (debit >= 0 AND credit >= 0 AND base_debit >= 0 AND base_credit >= 0),
      CHECK (NOT (debit > 0 AND credit > 0)),
      -- a line may be base-currency-only (FX rounding), but never fully zero
      CHECK (debit + credit + base_debit + base_credit > 0),
      CHECK (NOT (debit > 0 AND base_credit > 0)),
      CHECK (NOT (credit > 0 AND base_debit > 0))
    );
    CREATE INDEX jl_entry_idx ON journal_lines (entry_id);
    CREATE INDEX jl_account_idx ON journal_lines (account_id);

    ------------------------------------------------------------------
    -- INVARIANT 1: posted entries and their lines are immutable.
    ------------------------------------------------------------------
    CREATE FUNCTION je_immutable() RETURNS trigger AS $$
    BEGIN
      IF OLD.status = 'posted' THEN
        RAISE EXCEPTION 'posted journal entries are immutable (use a reversing entry)';
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;

    CREATE TRIGGER je_immutable_trg
      BEFORE UPDATE OR DELETE ON journal_entries
      FOR EACH ROW EXECUTE FUNCTION je_immutable();

    CREATE FUNCTION jl_immutable() RETURNS trigger AS $$
    DECLARE eid uuid;
    BEGIN
      eid := CASE WHEN TG_OP = 'INSERT' THEN NEW.entry_id ELSE OLD.entry_id END;
      IF EXISTS (SELECT 1 FROM journal_entries WHERE id = eid AND status = 'posted') THEN
        RAISE EXCEPTION 'lines of a posted journal entry are immutable';
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;

    CREATE TRIGGER jl_immutable_trg
      BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
      FOR EACH ROW EXECUTE FUNCTION jl_immutable();

    ------------------------------------------------------------------
    -- INVARIANT 2: a posted entry balances (txn currency and base
    -- currency) and has at least two lines. Checked at commit time.
    ------------------------------------------------------------------
    CREATE FUNCTION je_check_balanced() RETURNS trigger AS $$
    DECLARE
      e journal_entries%ROWTYPE;
      n int; sd numeric; sc numeric; sbd numeric; sbc numeric;
    BEGIN
      SELECT * INTO e FROM journal_entries WHERE id = NEW.id;
      IF NOT FOUND OR e.status <> 'posted' THEN RETURN NULL; END IF;

      SELECT count(*), COALESCE(sum(debit),0), COALESCE(sum(credit),0),
             COALESCE(sum(base_debit),0), COALESCE(sum(base_credit),0)
        INTO n, sd, sc, sbd, sbc
        FROM journal_lines WHERE entry_id = e.id;

      IF n < 2 THEN
        RAISE EXCEPTION 'posted entry % must have at least two lines', e.entry_no;
      END IF;
      IF sd <> sc THEN
        RAISE EXCEPTION 'entry % does not balance in transaction currency: debit % <> credit %', e.entry_no, sd, sc;
      END IF;
      IF sbd <> sbc THEN
        RAISE EXCEPTION 'entry % does not balance in base currency: debit % <> credit %', e.entry_no, sbd, sbc;
      END IF;

      -- INVARIANT 3: cannot post into a closed period or closed fiscal year.
      IF EXISTS (SELECT 1 FROM accounting_periods p
                  WHERE p.company_id = e.company_id AND p.status = 'closed'
                    AND e.txn_date BETWEEN p.start_date AND p.end_date)
         OR EXISTS (SELECT 1 FROM fiscal_years f
                  WHERE f.company_id = e.company_id AND f.status = 'closed'
                    AND e.txn_date BETWEEN f.start_date AND f.end_date) THEN
        RAISE EXCEPTION 'entry % is dated in a closed period', e.entry_no;
      END IF;
      RETURN NULL;
    END $$ LANGUAGE plpgsql;

    CREATE CONSTRAINT TRIGGER je_balanced_trg
      AFTER INSERT OR UPDATE ON journal_entries
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION je_check_balanced();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS journal_lines;
    DROP TABLE IF EXISTS journal_entries;
    DROP TABLE IF EXISTS accounting_periods;
    DROP TABLE IF EXISTS fiscal_years;
    DROP TABLE IF EXISTS company_accounts;
    DROP TABLE IF EXISTS accounts;
    DROP FUNCTION IF EXISTS je_immutable;
    DROP FUNCTION IF EXISTS jl_immutable;
    DROP FUNCTION IF EXISTS je_check_balanced;
  `);
}
