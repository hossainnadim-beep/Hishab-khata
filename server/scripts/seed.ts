/**
 * Demo seed: a realistic Bangladeshi trading company with six months of
 * activity. Run after migrations: `npm run seed -w server`.
 * Login: demo@khatabooks.app / demo1234 (owner)
 *        accountant@khatabooks.app / demo1234 (accountant)
 */
import bcrypt from 'bcryptjs';
import { db } from '../src/db.ts';
import { createCompany } from '../src/modules/companies/service.ts';
import { postEntry } from '../src/modules/ledger/posting.ts';
import {
  createInvoice, postInvoice, receivePayment,
  createCreditNote, postCreditNote, applyCreditNote,
} from '../src/modules/sales/service.ts';
import {
  createBill, postBill, payBill,
  createExpenseClaim, approveExpenseClaim, reimburseExpenseClaim,
} from '../src/modules/purchases/service.ts';
import { importStatement, autoMatch, createSpendReceive } from '../src/modules/banking/service.ts';
import { nextDocNo } from '../src/lib/docs.ts';

const existing = await db('users').where({ email: 'demo@khatabooks.app' }).first();
if (existing) {
  console.log('Demo data already seeded — skipping. (Drop and recreate the DB to reseed.)');
  await db.destroy();
  process.exit(0);
}

const hash = await bcrypt.hash('demo1234', 10);
const [owner] = await db('users')
  .insert({ email: 'demo@khatabooks.app', password_hash: hash, name: 'Nusrat Rahman' })
  .returning('*');
const [accountant] = await db('users')
  .insert({ email: 'accountant@khatabooks.app', password_hash: hash, name: 'Tanvir Alam' })
  .returning('*');

await db.transaction(async (trx) => {
  const company = await createCompany(trx, {
    name: 'Dhaka Trading Co.',
    legalName: 'Dhaka Trading Company Ltd.',
    country: 'BD',
    baseCurrency: 'BDT',
    fiscalYearStartMonth: 7,
    taxRegistrationNo: '004512345-0101',
    ownerUserId: owner.id,
  });
  const c = company.id;
  await trx('companies').where({ id: c }).update({
    address: 'House 42, Road 11, Banani, Dhaka 1213',
    phone: '+880 2-9882211',
    email: 'accounts@dhakatrading.example',
    invoice_logo_text: 'Dhaka Trading Co.',
    invoice_footer: 'Payment within terms via bank transfer or bKash. Thank you for your business.',
  });
  await trx('memberships').insert([
    { user_id: accountant.id, company_id: c, role: 'accountant' },
  ]);

  const accounts = await trx('accounts').where({ company_id: c });
  const A = Object.fromEntries(accounts.map((a: any) => [a.code, a.id]));
  const taxes = await trx('tax_codes').where({ company_id: c });
  const T = Object.fromEntries(taxes.map((t: any) => [t.code, t.id]));

  // USD bank account
  const [usdBank] = await trx('accounts')
    .insert({ company_id: c, code: '1020', name: 'City Bank USD Account', type: 'asset', subtype: 'bank', currency: 'USD' })
    .returning('*');

  // ---- Contacts ----
  const mkContact = async (row: any) =>
    (await trx('contacts').insert({ company_id: c, ...row }).returning('*'))[0];
  const rahim = await mkContact({ name: 'Rahim Traders', is_customer: true, email: 'rahim@traders.example', phone: '+880 1711-000001', address: 'Islampur Road, Dhaka', payment_terms_days: 30 });
  const meghna = await mkContact({ name: 'Meghna Retail Ltd', is_customer: true, email: 'purchase@meghnaretail.example', phone: '+880 1811-000002', address: 'GEC Circle, Chattogram', tax_reg_no: '001987654-0202', payment_terms_days: 45 });
  const sylhet = await mkContact({ name: 'Sylhet Superstore', is_customer: true, phone: '+880 1911-000003', address: 'Zindabazar, Sylhet', payment_terms_days: 15 });
  const usBuyer = await mkContact({ name: 'Atlantic Imports LLC', is_customer: true, email: 'ap@atlanticimports.example', address: 'Newark, NJ, USA', currency: 'USD', payment_terms_days: 60 });
  const govAgency = await mkContact({ name: 'Public Works Department', is_customer: true, address: 'Segunbagicha, Dhaka', payment_terms_days: 90 });

  const karim = await mkContact({ name: 'Karim & Sons Wholesale', is_vendor: true, phone: '+880 1611-000010', address: 'Chawkbazar, Dhaka', tax_reg_no: '003456789-0303', payment_terms_days: 30 });
  const bengalTextiles = await mkContact({ name: 'Bengal Textiles Ltd', is_vendor: true, email: 'sales@bengaltextiles.example', payment_terms_days: 45 });
  const landlord = await mkContact({ name: 'Banani Properties', is_vendor: true, payment_terms_days: 7 });
  const iscon = await mkContact({ name: 'ISCON Office Supplies', is_vendor: true, payment_terms_days: 14 });

  // ---- Items ----
  const mkItem = async (row: any) =>
    (await trx('items').insert({ company_id: c, ...row }).returning('*'))[0];
  const cottonFabric = await mkItem({
    name: 'Cotton Fabric (per roll)', sku: 'FAB-CTN', type: 'inventory',
    sale_price: 4500, purchase_price: 3200,
    income_account_id: A['4000'], expense_account_id: A['5000'], inventory_account_id: A['1200'],
    tax_code_id: T['VAT15'],
  });
  const silkFabric = await mkItem({
    name: 'Silk Fabric (per roll)', sku: 'FAB-SLK', type: 'inventory',
    sale_price: 9800, purchase_price: 7100,
    income_account_id: A['4000'], expense_account_id: A['5000'], inventory_account_id: A['1200'],
    tax_code_id: T['VAT15'],
  });
  const thread = await mkItem({
    name: 'Sewing Thread (box of 50)', sku: 'THR-50', type: 'inventory',
    sale_price: 1200, purchase_price: 800,
    income_account_id: A['4000'], expense_account_id: A['5000'], inventory_account_id: A['1200'],
    tax_code_id: T['VAT15'],
  });
  const tailoring = await mkItem({
    name: 'Tailoring Service (per batch)', type: 'service',
    sale_price: 15000, income_account_id: A['4100'], tax_code_id: T['VAT15'],
  });
  const consulting = await mkItem({
    name: 'Sourcing Consultancy (per day)', type: 'service',
    sale_price: 20000, income_account_id: A['4100'], tax_code_id: T['VAT15'],
  });

  // ---- Opening capital (Jan 2026) ----
  await postEntry(trx, {
    companyId: c, txnDate: '2026-01-02', memo: 'Owner capital injection',
    sourceType: 'manual', userId: owner.id,
    lines: [
      { accountId: A['1010'], debit: 1500000, description: 'Initial deposit — City Bank' },
      { accountId: A['1000'], debit: 50000, description: 'Petty cash float' },
      { accountId: A['3000'], credit: 1550000, description: 'Owner capital' },
    ],
  });

  // ---- Stock purchases ----
  const bill1 = await createBill(trx, c, owner.id, {
    vendorId: bengalTextiles.id, issueDate: '2026-01-08', vendorRef: 'BT-2026-0114',
    lines: [
      { itemId: cottonFabric.id, qty: 100, unitPrice: 3200, taxCodeId: T['VAT15'] },
      { itemId: silkFabric.id, qty: 30, unitPrice: 7100, taxCodeId: T['VAT15'] },
    ],
  });
  await postBill(trx, c, bill1.id, owner.id);
  await payBill(trx, c, owner.id, {
    contactId: bengalTextiles.id, paymentDate: '2026-02-05', paymentAccountId: A['1010'],
    reference: 'TT-88121',
    allocations: [{ billId: bill1.id, amount: bill1.total }],
    withholdings: [
      { taxCodeId: T['VDS15'], baseAmount: 533000, amount: 79950 },
      { taxCodeId: T['AIT5'], baseAmount: 533000, amount: 26650 },
    ],
  });

  const bill2 = await createBill(trx, c, owner.id, {
    vendorId: karim.id, issueDate: '2026-02-12', vendorRef: 'KS-3391',
    lines: [
      { itemId: thread.id, qty: 200, unitPrice: 800, taxCodeId: T['VAT15'] },
      { itemId: cottonFabric.id, qty: 50, unitPrice: 3350, taxCodeId: T['VAT15'] },
    ],
  });
  await postBill(trx, c, bill2.id, owner.id);

  // Rent bills (monthly, Feb–Jun paid, Jul open)
  for (const [i, month] of ['02', '03', '04', '05', '06', '07'].entries()) {
    const bill = await createBill(trx, c, owner.id, {
      vendorId: landlord.id, issueDate: `2026-${month}-01`,
      lines: [{ description: `Warehouse & office rent 2026-${month}`, qty: 1, unitPrice: 60000, accountId: A['6100'], taxCodeId: T['VAT15'] }],
    });
    await postBill(trx, c, bill.id, owner.id);
    if (i < 5) {
      await payBill(trx, c, owner.id, {
        contactId: landlord.id, paymentDate: `2026-${month}-05`, paymentAccountId: A['1010'],
        allocations: [{ billId: bill.id, amount: bill.total }],
        withholdings: [{ taxCodeId: T['VDS15'], baseAmount: 60000, amount: 9000 }],
      });
    }
  }

  // Office supplies bill, open
  const bill3 = await createBill(trx, c, owner.id, {
    vendorId: iscon.id, issueDate: '2026-06-20', vendorRef: 'INV-7723',
    lines: [{ description: 'Printer toner and stationery', qty: 1, unitPrice: 18500, accountId: A['6300'], taxCodeId: T['VAT15'] }],
  });
  await postBill(trx, c, bill3.id, owner.id);

  // ---- Sales ----
  const inv1 = await createInvoice(trx, c, owner.id, {
    customerId: rahim.id, issueDate: '2026-02-20',
    lines: [
      { itemId: cottonFabric.id, qty: 40, unitPrice: 4500, taxCodeId: T['VAT15'] },
      { itemId: thread.id, qty: 50, unitPrice: 1200, taxCodeId: T['VAT15'] },
    ],
  });
  await postInvoice(trx, c, inv1.id, owner.id);
  await receivePayment(trx, c, owner.id, {
    contactId: rahim.id, paymentDate: '2026-03-12', depositAccountId: A['1010'],
    reference: 'bKash TRX9912',
    allocations: [{ invoiceId: inv1.id, amount: (await trx('invoices').where({ id: inv1.id }).first()).total }],
  });

  const inv2 = await createInvoice(trx, c, owner.id, {
    customerId: meghna.id, issueDate: '2026-04-05',
    lines: [
      { itemId: silkFabric.id, qty: 20, unitPrice: 9800, taxCodeId: T['VAT15'] },
      { itemId: tailoring.id, qty: 2, unitPrice: 15000, taxCodeId: T['VAT15'] },
    ],
  });
  await postInvoice(trx, c, inv2.id, owner.id);
  // Partial payment
  await receivePayment(trx, c, owner.id, {
    contactId: meghna.id, paymentDate: '2026-05-18', depositAccountId: A['1010'],
    allocations: [{ invoiceId: inv2.id, amount: 150000 }],
  });

  // Government customer withholds AIT + VDS on payment
  const inv3 = await createInvoice(trx, c, owner.id, {
    customerId: govAgency.id, issueDate: '2026-03-15',
    lines: [{ itemId: consulting.id, qty: 10, unitPrice: 20000, taxCodeId: T['VAT15'] }],
  });
  await postInvoice(trx, c, inv3.id, owner.id);
  await receivePayment(trx, c, owner.id, {
    contactId: govAgency.id, paymentDate: '2026-06-10', depositAccountId: A['1010'],
    reference: 'Cheque 445210',
    allocations: [{ invoiceId: inv3.id, amount: 230000 }],
    withholdings: [{ taxCodeId: T['AIT10'], baseAmount: 200000, amount: 20000 }],
  });

  // USD export invoice (zero-rated), paid at a different rate → realized FX gain
  const inv4 = await createInvoice(trx, c, owner.id, {
    customerId: usBuyer.id, issueDate: '2026-04-20', currency: 'USD', exchangeRate: '119.50',
    lines: [{ itemId: silkFabric.id, qty: 8, unitPrice: 95, taxCodeId: T['VAT0'] }],
  });
  await postInvoice(trx, c, inv4.id, owner.id);
  await receivePayment(trx, c, owner.id, {
    contactId: usBuyer.id, paymentDate: '2026-06-02', currency: 'USD', exchangeRate: '122.80',
    depositAccountId: usdBank.id,
    allocations: [{ invoiceId: inv4.id, amount: 760 }],
  });

  // Overdue invoice (90+ days)
  const inv5 = await createInvoice(trx, c, owner.id, {
    customerId: sylhet.id, issueDate: '2026-02-10', dueDate: '2026-02-25',
    lines: [{ itemId: cottonFabric.id, qty: 25, unitPrice: 4600, taxCodeId: T['VAT15'] }],
  });
  await postInvoice(trx, c, inv5.id, owner.id);

  // Recent open invoice + a draft
  const inv6 = await createInvoice(trx, c, owner.id, {
    customerId: rahim.id, issueDate: '2026-06-25',
    lines: [
      { itemId: thread.id, qty: 80, unitPrice: 1200, taxCodeId: T['VAT15'] },
      { itemId: cottonFabric.id, qty: 30, unitPrice: 4550, taxCodeId: T['VAT15'] },
    ],
  });
  await postInvoice(trx, c, inv6.id, owner.id);
  await createInvoice(trx, c, owner.id, {
    customerId: meghna.id, issueDate: '2026-07-05',
    memo: 'July replenishment order — awaiting confirmation',
    lines: [{ itemId: silkFabric.id, qty: 12, unitPrice: 9900, taxCodeId: T['VAT15'] }],
  });

  // Credit note against inv2 (short delivery of one tailoring batch)
  const cn = await createCreditNote(trx, c, owner.id, {
    customerId: meghna.id, issueDate: '2026-05-25',
    memo: 'One tailoring batch not delivered',
    lines: [{ itemId: tailoring.id, qty: 1, unitPrice: 15000, taxCodeId: T['VAT15'] }],
  });
  const postedCn = await postCreditNote(trx, c, cn.id, owner.id);
  await applyCreditNote(trx, c, owner.id, { creditNoteId: postedCn.id, invoiceId: inv2.id, amount: postedCn.total });

  // ---- Quotes ----
  const quoteTotals = [
    { customer: sylhet.id, date: '2026-06-28', status: 'sent', qty: 60 },
    { customer: meghna.id, date: '2026-07-01', status: 'draft', qty: 35 },
  ];
  for (const q of quoteTotals) {
    const [quote] = await trx('quotes')
      .insert({
        company_id: c, customer_id: q.customer,
        doc_no: await nextDocNo(trx, c, 'quote'),
        status: q.status, issue_date: q.date, expiry_date: '2026-07-31',
        currency: 'BDT', amounts_are: 'exclusive',
        subtotal: (q.qty * 4500).toFixed(2),
        tax_total: (q.qty * 4500 * 0.15).toFixed(2),
        total: (q.qty * 4500 * 1.15).toFixed(2),
        created_by: owner.id,
      })
      .returning('*');
    await trx('quote_lines').insert({
      quote_id: quote.id, line_no: 1, item_id: cottonFabric.id,
      description: 'Cotton Fabric (per roll)', qty: q.qty, unit_price: 4500,
      account_id: A['4000'], tax_code_id: T['VAT15'],
      net_amount: (q.qty * 4500).toFixed(2), tax_amount: (q.qty * 4500 * 0.15).toFixed(2),
    });
  }

  // ---- Recurring invoice schedule ----
  await trx('recurring_invoices').insert({
    company_id: c, customer_id: meghna.id, name: 'Monthly sourcing retainer',
    template: JSON.stringify({
      memo: 'Monthly sourcing retainer',
      lines: [{ itemId: consulting.id, description: 'Sourcing retainer', qty: 2, unitPrice: 20000, accountId: A['4100'], taxCodeId: T['VAT15'] }],
    }),
    frequency: 'monthly', every_n: 1, next_run_date: '2026-08-01', auto_post: false,
  });

  // ---- Monthly operating expenses via spend money ----
  for (const month of ['01', '02', '03', '04', '05', '06']) {
    await createSpendReceive(trx, {
      companyId: c, accountId: A['1010'], date: `2026-${month}-28`,
      description: `Salaries 2026-${month}`, amount: -185000, targetAccountId: A['6000'], userId: owner.id,
    });
    await createSpendReceive(trx, {
      companyId: c, accountId: A['1010'], date: `2026-${month}-15`,
      description: `DESCO electricity 2026-${month}`, amount: -(8200 + Number(month) * 310),
      targetAccountId: A['6200'], userId: owner.id,
    });
    await createSpendReceive(trx, {
      companyId: c, accountId: A['1010'], date: `2026-${month}-10`,
      description: `GP internet 2026-${month}`, amount: -3450, targetAccountId: A['6600'], userId: owner.id,
    });
  }

  // ---- Expense claim ----
  const claim = await createExpenseClaim(trx, c, accountant.id, {
    claimant: 'Sara Ahmed (Sales)', claimDate: '2026-06-18',
    lines: [
      { expenseDate: '2026-06-12', accountId: A['6700'], description: 'Chattogram client visit — train + CNG', amount: 3200 },
      { expenseDate: '2026-06-13', accountId: A['6700'], description: 'Hotel (1 night)', amount: 5750, taxCodeId: T['VAT15'] },
    ],
  });
  await approveExpenseClaim(trx, c, claim.id, owner.id);
  await reimburseExpenseClaim(trx, c, claim.id, owner.id, { paymentDate: '2026-06-25', paymentAccountId: A['1000'] });

  // ---- Bank rules + statement import with auto-match ----
  await trx('bank_rules').insert([
    { company_id: c, name: 'DESCO electricity', pattern: 'DESCO', direction: 'out', target_account_id: A['6200'] },
    { company_id: c, name: 'Bank charges', pattern: 'SERVICE CHARGE', direction: 'out', target_account_id: A['6400'] },
  ]);
  const csv = [
    'Date,Description,Amount,Reference',
    '2026-06-28,SALARY BATCH JUNE,-185000.00,SAL-06',
    '2026-06-15,DESCO BILL 2026-06,-10060.00,',
    '2026-06-10,GP INTERNET AUTOPAY,-3450.00,',
    '2026-06-30,SERVICE CHARGE JUNE,-575.00,',
    '2026-06-10,PWD CHEQUE 445210,210000.00,445210',
    '2026-07-02,UNKNOWN DEPOSIT,25000.00,',
  ].join('\n');
  await importStatement(trx, { companyId: c, accountId: A['1010'], format: 'csv', content: csv, filename: 'citybank-june.csv', userId: owner.id });
  await autoMatch(trx, c, A['1010'], owner.id);

  console.log(`Seeded company ${company.name} (${c})`);
});

console.log('Done. Login: demo@khatabooks.app / demo1234');
await db.destroy();
