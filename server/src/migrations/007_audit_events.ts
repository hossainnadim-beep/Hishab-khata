import type { Knex } from 'knex';

/**
 * Phase 2:
 * - Audit records are immutable (no UPDATE/DELETE, ever).
 * - Every audit insert NOTIFYs 'company_events' on commit — the API fans this
 *   out to SSE subscribers so open report screens refetch instantly.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE FUNCTION audit_immutable() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit log records are immutable';
    END $$ LANGUAGE plpgsql;

    CREATE TRIGGER audit_immutable_trg
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION audit_immutable();

    CREATE FUNCTION audit_notify() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify('company_events', NEW.company_id::text);
      RETURN NEW;
    END $$ LANGUAGE plpgsql;

    CREATE TRIGGER audit_notify_trg
      AFTER INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION audit_notify();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TRIGGER IF EXISTS audit_immutable_trg ON audit_log;
    DROP TRIGGER IF EXISTS audit_notify_trg ON audit_log;
    DROP FUNCTION IF EXISTS audit_immutable;
    DROP FUNCTION IF EXISTS audit_notify;
  `);
}
