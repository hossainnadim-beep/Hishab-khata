import type { Knex } from 'knex';

/**
 * INVARIANT 4 (tenant isolation): a journal line's account must belong to the
 * same company as its entry. Without this, a crafted posting could plant an
 * unbalanced line in another tenant's books (found by adversarial audit).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE FUNCTION jl_same_company() RETURNS trigger AS $$
    DECLARE
      entry_company uuid;
      account_company uuid;
    BEGIN
      SELECT company_id INTO entry_company FROM journal_entries WHERE id = NEW.entry_id;
      SELECT company_id INTO account_company FROM accounts WHERE id = NEW.account_id;
      IF entry_company IS DISTINCT FROM account_company THEN
        RAISE EXCEPTION 'journal line account belongs to a different company than its entry';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;

    CREATE TRIGGER jl_same_company_trg
      BEFORE INSERT OR UPDATE ON journal_lines
      FOR EACH ROW EXECUTE FUNCTION jl_same_company();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TRIGGER IF EXISTS jl_same_company_trg ON journal_lines;
    DROP FUNCTION IF EXISTS jl_same_company;
  `);
}
