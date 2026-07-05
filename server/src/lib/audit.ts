import type { Knex } from 'knex';

export async function audit(
  trx: Knex,
  entry: {
    companyId: string;
    userId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    details?: unknown;
  },
) {
  await trx('audit_log').insert({
    company_id: entry.companyId,
    user_id: entry.userId ?? null,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId ?? null,
    details: entry.details ? JSON.stringify(entry.details) : null,
  });
}
