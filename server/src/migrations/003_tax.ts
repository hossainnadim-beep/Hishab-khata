import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE tax_codes (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id          uuid NOT NULL REFERENCES companies(id),
      code                text NOT NULL,
      name                text NOT NULL,
      rate                numeric(9,4) NOT NULL CHECK (rate >= 0),
      applies_to          text NOT NULL DEFAULT 'both' CHECK (applies_to IN ('sales','purchases','both')),
      -- Withholding taxes are deducted from the counterparty payment at source
      -- instead of being added to the document total.
      is_withholding      boolean NOT NULL DEFAULT false,
      sales_account_id    uuid REFERENCES accounts(id),
      purchase_account_id uuid REFERENCES accounts(id),
      report_category     text,          -- groups lines on the VAT/tax summary report
      jurisdiction        text NOT NULL DEFAULT 'BD',
      archived            boolean NOT NULL DEFAULT false,
      created_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, code)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS tax_codes;`);
}
