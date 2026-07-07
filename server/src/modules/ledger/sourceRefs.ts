import type { Knex } from 'knex';

export interface SourceRef {
  label: string; // e.g. "Invoice INV-0003"
  route: string | null; // frontend route, e.g. "/invoices/<id>"
}

const DOC_TABLES: Record<string, { table: string; route: string; label: string }> = {
  invoice: { table: 'invoices', route: 'invoices', label: 'Invoice' },
  invoice_cogs: { table: 'invoices', route: 'invoices', label: 'COGS for invoice' },
  credit_note: { table: 'credit_notes', route: 'credit-notes', label: 'Credit note' },
  credit_note_cogs: { table: 'credit_notes', route: 'credit-notes', label: 'Restock for credit note' },
  bill: { table: 'bills', route: 'bills', label: 'Bill' },
  vendor_credit: { table: 'vendor_credits', route: 'vendor-credits', label: 'Vendor credit' },
  expense_claim: { table: 'expense_claims', route: 'expense-claims', label: 'Expense claim' },
  expense_reimbursement: { table: 'expense_claims', route: 'expense-claims', label: 'Reimbursement' },
};

/**
 * Resolves journal entries' (source_type, source_id) to a human label and a
 * frontend route, so every ledger line can link back to its source document.
 */
export async function resolveSourceRefs(
  trx: Knex,
  companyId: string,
  entries: Array<{ id: string; source_type: string; source_id: string | null }>,
): Promise<Map<string, SourceRef>> {
  const refs = new Map<string, SourceRef>();

  // Documents keyed by their own table
  const byTable = new Map<string, Set<string>>();
  for (const e of entries) {
    const cfg = DOC_TABLES[e.source_type];
    if (cfg && e.source_id) {
      if (!byTable.has(cfg.table)) byTable.set(cfg.table, new Set());
      byTable.get(cfg.table)!.add(e.source_id);
    }
  }
  const docRows = new Map<string, any>();
  for (const [table, ids] of byTable) {
    const rows = await trx(table).whereIn('id', [...ids]).andWhere({ company_id: companyId });
    for (const r of rows) docRows.set(`${table}:${r.id}`, r);
  }

  // Payments link via journal_entry_id
  const paymentEntryIds = entries
    .filter((e) => e.source_type === 'payment' || e.source_type === 'bill_payment')
    .map((e) => e.id);
  const payments = paymentEntryIds.length
    ? await trx('payments').whereIn('journal_entry_id', paymentEntryIds).andWhere({ company_id: companyId })
    : [];
  const paymentByEntry = new Map(payments.map((p: any) => [p.journal_entry_id, p]));

  for (const e of entries) {
    const cfg = DOC_TABLES[e.source_type];
    if (cfg && e.source_id) {
      const doc = docRows.get(`${cfg.table}:${e.source_id}`);
      if (doc) {
        refs.set(e.id, { label: `${cfg.label} ${doc.doc_no}`, route: `/${cfg.route}/${doc.id}` });
        continue;
      }
    }
    const payment = paymentByEntry.get(e.id);
    if (payment) {
      refs.set(e.id, {
        label: `${payment.kind === 'receive' ? 'Payment received' : 'Payment made'} ${payment.doc_no}`,
        route: null,
      });
      continue;
    }
    const fallback: Record<string, string> = {
      manual: 'Manual journal',
      reversal: 'Reversing entry',
      bank_txn: 'Bank transaction',
      bank_rule: 'Bank rule posting',
      fx_revaluation: 'FX revaluation',
      inventory_adjustment: 'Stock adjustment',
      credit_application: 'Credit application',
    };
    refs.set(e.id, { label: fallback[e.source_type] ?? e.source_type, route: null });
  }
  return refs;
}
