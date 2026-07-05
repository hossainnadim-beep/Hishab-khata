/**
 * Seedable chart-of-accounts template for a Bangladesh SME.
 * `purpose` marks accounts wired into company_accounts for automatic posting.
 */
export interface TemplateAccount {
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  subtype?: string;
  purpose?: string;
  isSystem?: boolean;
}

export const BD_SME_TEMPLATE: TemplateAccount[] = [
  { code: '1000', name: 'Cash on Hand', type: 'asset', subtype: 'cash' },
  { code: '1010', name: 'Bank Account', type: 'asset', subtype: 'bank' },
  { code: '1100', name: 'Accounts Receivable', type: 'asset', subtype: 'accounts_receivable', purpose: 'ar', isSystem: true },
  { code: '1150', name: 'Undeposited Funds', type: 'asset', subtype: 'current_asset', purpose: 'undeposited', isSystem: true },
  { code: '1200', name: 'Inventory Asset', type: 'asset', subtype: 'inventory', purpose: 'inventory', isSystem: true },
  { code: '1300', name: 'Advance Income Tax (AIT)', type: 'asset', subtype: 'current_asset', purpose: 'ait_receivable', isSystem: true },
  { code: '1310', name: 'VAT Input (Rebatable)', type: 'asset', subtype: 'current_asset', purpose: 'vat_input', isSystem: true },
  { code: '1400', name: 'Prepaid Expenses', type: 'asset', subtype: 'current_asset' },
  { code: '1500', name: 'Equipment & Machinery', type: 'asset', subtype: 'fixed_asset' },
  { code: '1510', name: 'Accumulated Depreciation', type: 'asset', subtype: 'fixed_asset' },
  { code: '2000', name: 'Accounts Payable', type: 'liability', subtype: 'accounts_payable', purpose: 'ap', isSystem: true },
  { code: '2100', name: 'VAT Output Payable', type: 'liability', subtype: 'current_liability', purpose: 'vat_output', isSystem: true },
  { code: '2110', name: 'VAT Withheld at Source (VDS) Payable', type: 'liability', subtype: 'current_liability', purpose: 'vds_payable', isSystem: true },
  { code: '2120', name: 'AIT Withheld Payable', type: 'liability', subtype: 'current_liability', purpose: 'ait_payable', isSystem: true },
  { code: '2200', name: 'Accrued Liabilities', type: 'liability', subtype: 'current_liability' },
  { code: '2210', name: 'Employee Reimbursements Payable', type: 'liability', subtype: 'current_liability', purpose: 'employee_reimb', isSystem: true },
  { code: '2300', name: 'Loans Payable', type: 'liability', subtype: 'long_term_liability' },
  { code: '3000', name: "Owner's Capital", type: 'equity', subtype: 'equity' },
  { code: '3100', name: 'Retained Earnings', type: 'equity', subtype: 'retained_earnings', purpose: 'retained_earnings', isSystem: true },
  { code: '3200', name: 'Opening Balance Equity', type: 'equity', subtype: 'equity', purpose: 'opening_balance', isSystem: true },
  { code: '4000', name: 'Sales Revenue', type: 'income', subtype: 'operating_revenue', purpose: 'sales', isSystem: true },
  { code: '4100', name: 'Service Revenue', type: 'income', subtype: 'operating_revenue' },
  { code: '4900', name: 'Other Income', type: 'income', subtype: 'other_income' },
  { code: '4950', name: 'Realized FX Gain/Loss', type: 'income', subtype: 'other_income', purpose: 'fx_gain_loss', isSystem: true },
  { code: '4960', name: 'Unrealized FX Gain/Loss', type: 'income', subtype: 'other_income', purpose: 'unrealized_fx', isSystem: true },
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense', subtype: 'cogs', purpose: 'cogs', isSystem: true },
  { code: '6000', name: 'Salaries & Wages', type: 'expense', subtype: 'operating_expense' },
  { code: '6100', name: 'Rent Expense', type: 'expense', subtype: 'operating_expense' },
  { code: '6200', name: 'Utilities', type: 'expense', subtype: 'operating_expense' },
  { code: '6300', name: 'Office Supplies', type: 'expense', subtype: 'operating_expense' },
  { code: '6400', name: 'Bank Charges', type: 'expense', subtype: 'operating_expense' },
  { code: '6500', name: 'Depreciation Expense', type: 'expense', subtype: 'operating_expense' },
  { code: '6600', name: 'Telephone & Internet', type: 'expense', subtype: 'operating_expense' },
  { code: '6700', name: 'Travel & Conveyance', type: 'expense', subtype: 'operating_expense' },
  { code: '6800', name: 'Repairs & Maintenance', type: 'expense', subtype: 'operating_expense' },
  { code: '6900', name: 'Miscellaneous Expense', type: 'expense', subtype: 'operating_expense' },
  { code: '6950', name: 'Rounding Differences', type: 'expense', subtype: 'operating_expense', purpose: 'rounding', isSystem: true },
];
