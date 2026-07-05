import type { Knex } from 'knex';

/**
 * Seeds jurisdiction tax codes for a new company. Bangladesh (Mushak / VAT Act
 * 2012 rates plus withholding VDS and AIT) ships as the first configuration;
 * other jurisdictions are added here or via the tax-codes API — no code changes.
 */
export async function seedTaxCodes(trx: Knex, companyId: string, country: string): Promise<void> {
  const purposes = await trx('company_accounts').where({ company_id: companyId });
  const acct = (purpose: string) =>
    purposes.find((p: any) => p.purpose === purpose)?.account_id ?? null;

  const vatOut = acct('vat_output');
  const vatIn = acct('vat_input');
  const vds = acct('vds_payable');
  const aitPay = acct('ait_payable');
  const aitRec = acct('ait_receivable');

  const codes =
    country === 'BD'
      ? [
          { code: 'VAT15', name: 'VAT Standard 15%', rate: 15, applies_to: 'both', sales_account_id: vatOut, purchase_account_id: vatIn, report_category: 'vat_standard' },
          { code: 'VAT10', name: 'VAT Reduced 10%', rate: 10, applies_to: 'both', sales_account_id: vatOut, purchase_account_id: vatIn, report_category: 'vat_reduced' },
          { code: 'VAT7.5', name: 'VAT Reduced 7.5%', rate: 7.5, applies_to: 'both', sales_account_id: vatOut, purchase_account_id: vatIn, report_category: 'vat_reduced' },
          { code: 'VAT5', name: 'VAT Reduced 5%', rate: 5, applies_to: 'both', sales_account_id: vatOut, purchase_account_id: vatIn, report_category: 'vat_reduced' },
          { code: 'VAT0', name: 'VAT Zero-rated (Export)', rate: 0, applies_to: 'both', sales_account_id: vatOut, purchase_account_id: vatIn, report_category: 'zero_rated' },
          { code: 'EXEMPT', name: 'VAT Exempt', rate: 0, applies_to: 'both', sales_account_id: null, purchase_account_id: null, report_category: 'exempt' },
          { code: 'VDS15', name: 'VAT Deducted at Source 15%', rate: 15, applies_to: 'purchases', is_withholding: true, purchase_account_id: vds, report_category: 'vds' },
          { code: 'VDS7.5', name: 'VAT Deducted at Source 7.5%', rate: 7.5, applies_to: 'purchases', is_withholding: true, purchase_account_id: vds, report_category: 'vds' },
          { code: 'AIT2', name: 'AIT Withheld 2%', rate: 2, applies_to: 'both', is_withholding: true, sales_account_id: aitRec, purchase_account_id: aitPay, report_category: 'ait' },
          { code: 'AIT3', name: 'AIT Withheld 3%', rate: 3, applies_to: 'both', is_withholding: true, sales_account_id: aitRec, purchase_account_id: aitPay, report_category: 'ait' },
          { code: 'AIT5', name: 'AIT Withheld 5%', rate: 5, applies_to: 'both', is_withholding: true, sales_account_id: aitRec, purchase_account_id: aitPay, report_category: 'ait' },
          { code: 'AIT10', name: 'AIT Withheld 10%', rate: 10, applies_to: 'both', is_withholding: true, sales_account_id: aitRec, purchase_account_id: aitPay, report_category: 'ait' },
        ]
      : [
          // Generic fallback for other countries: a single standard rate the
          // company edits after setup, plus exempt.
          { code: 'TAX_STD', name: 'Standard Tax', rate: 0, applies_to: 'both', sales_account_id: vatOut, purchase_account_id: vatIn, report_category: 'vat_standard' },
          { code: 'EXEMPT', name: 'Tax Exempt', rate: 0, applies_to: 'both', sales_account_id: null, purchase_account_id: null, report_category: 'exempt' },
        ];

  await trx('tax_codes').insert(
    codes.map((c) => ({ ...c, company_id: companyId, jurisdiction: country })),
  );
}
