import type { Knex } from 'knex';
import { BD_SME_TEMPLATE } from './coaTemplate.ts';
import { seedTaxCodes } from '../tax/seed.ts';
import { ensurePeriodsFor } from '../ledger/periods.ts';

export interface CreateCompanyInput {
  name: string;
  legalName?: string;
  country?: string;
  baseCurrency?: string;
  fiscalYearStartMonth?: number;
  taxRegistrationNo?: string;
  ownerUserId: string;
}

/** Creates a company with COA template, system-account wiring, tax codes, and current FY. */
export async function createCompany(trx: Knex, input: CreateCompanyInput) {
  const country = input.country ?? 'BD';
  const fyStart = input.fiscalYearStartMonth ?? 7;
  const [company] = await trx('companies')
    .insert({
      name: input.name,
      legal_name: input.legalName ?? input.name,
      country,
      base_currency: (input.baseCurrency ?? 'BDT').toUpperCase(),
      fiscal_year_start_month: fyStart,
      tax_registration_no: input.taxRegistrationNo ?? null,
    })
    .returning('*');

  await trx('memberships').insert({
    user_id: input.ownerUserId,
    company_id: company.id,
    role: 'owner',
  });

  for (const t of BD_SME_TEMPLATE) {
    const [account] = await trx('accounts')
      .insert({
        company_id: company.id,
        code: t.code,
        name: t.name,
        type: t.type,
        subtype: t.subtype ?? null,
        is_system: t.isSystem ?? false,
      })
      .returning(['id']);
    if (t.purpose) {
      await trx('company_accounts').insert({
        company_id: company.id,
        purpose: t.purpose,
        account_id: account.id,
      });
    }
  }

  await seedTaxCodes(trx, company.id, country);
  await ensurePeriodsFor(trx, company.id, new Date().toISOString().slice(0, 10), fyStart);
  return company;
}

/** Resolves a purpose-mapped account id (ar, ap, vat_output, rounding, ...). */
export async function purposeAccount(trx: Knex, companyId: string, purpose: string): Promise<string> {
  const row = await trx('company_accounts')
    .where({ company_id: companyId, purpose })
    .first();
  if (!row) throw new Error(`Company has no '${purpose}' account configured`);
  return row.account_id;
}
