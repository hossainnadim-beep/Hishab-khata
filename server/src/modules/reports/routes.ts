import { Router, type Response } from 'express';
import { db } from '../../db.ts';
import { badRequest, notFound } from '../../lib/errors.ts';
import type { AuthedRequest } from '../../lib/auth.ts';
import {
  trialBalance, profitAndLoss, balanceSheet, cashFlow, generalLedger,
  arAging, apAging, taxSummary, stockOnHand, customerStatement,
} from './service.ts';
import { toXlsx, toPdf, type FlatReport } from './render.ts';
import { documentPdf } from '../sales/pdf.ts';
import {
  statementProfitOrLoss,
  statementFinancialPosition,
  statementChangesInEquity,
} from './ifrs.ts';

export const reportsRouter = Router({ mergeParams: true });

function period(req: AuthedRequest): { from: string; to: string } {
  const { from, to } = req.query as Record<string, string>;
  if (!from || !to) throw badRequest('from and to query params are required (YYYY-MM-DD)');
  return { from, to };
}

/** compare=previous_period|previous_year derives the comparative window. */
function comparePeriod(req: AuthedRequest, from: string, to: string) {
  const mode = req.query.compare as string | undefined;
  if (!mode) return {};
  const f = new Date(from + 'T00:00:00Z');
  const t = new Date(to + 'T00:00:00Z');
  if (mode === 'previous_year') {
    f.setUTCFullYear(f.getUTCFullYear() - 1);
    t.setUTCFullYear(t.getUTCFullYear() - 1);
  } else {
    const spanDays = Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
    t.setTime(f.getTime() - 86400000);
    f.setTime(t.getTime() - (spanDays - 1) * 86400000);
  }
  return { compareFrom: f.toISOString().slice(0, 10), compareTo: t.toISOString().slice(0, 10) };
}

async function send(res: Response, req: AuthedRequest, report: any, flatten: () => FlatReport) {
  const format = (req.query.format as string) ?? 'json';
  if (format === 'json') return res.json(report);
  const flat = flatten();
  if (format === 'xlsx') {
    const buf = await toXlsx(flat);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${flat.title.replace(/\s+/g, '_')}.xlsx"`);
    return res.send(buf);
  }
  if (format === 'pdf') {
    const buf = await toPdf(flat);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${flat.title.replace(/\s+/g, '_')}.pdf"`);
    return res.send(buf);
  }
  throw badRequest('format must be json, xlsx, or pdf');
}

reportsRouter.get('/trial-balance', async (req: AuthedRequest, res, next) => {
  try {
    const asOf = (req.query.as_of as string) ?? new Date().toISOString().slice(0, 10);
    const report = await trialBalance(db, req.companyId!, asOf);
    await send(res, req, report, () => ({
      title: 'Trial Balance',
      subtitle: `As of ${asOf}`,
      sections: [{
        columns: [
          { label: 'Code', width: 1 }, { label: 'Account', width: 3 },
          { label: 'Debit', width: 1.5, align: 'right' }, { label: 'Credit', width: 1.5, align: 'right' },
        ],
        rows: report.rows.map((r) => [r.code, r.account, r.debit, r.credit]),
        footer: ['', 'Total', report.totals.debit, report.totals.credit],
      }],
    }));
  } catch (e) {
    next(e);
  }
});

reportsRouter.get('/profit-loss', async (req: AuthedRequest, res, next) => {
  try {
    const { from, to } = period(req);
    const cmp = comparePeriod(req, from, to);
    const report = await profitAndLoss(db, req.companyId!, { from, to, ...cmp });
    const hasCmp = !!report.comparePeriod;
    const cols = [
      { label: 'Account', width: 3 },
      { label: 'Amount', width: 1.5, align: 'right' as const },
      ...(hasCmp ? [{ label: 'Comparative', width: 1.5, align: 'right' as const }] : []),
    ];
    const toRow = (r: any) => [r.account, r.amount, ...(hasCmp ? [r.compare ?? ''] : [])];
    await send(res, req, report, () => ({
      title: 'Profit & Loss',
      subtitle: `${from} to ${to}${hasCmp ? ` (comparative: ${report.comparePeriod!.from} to ${report.comparePeriod!.to})` : ''}`,
      sections: [
        { heading: 'Income', columns: cols, rows: report.income.rows.map(toRow),
          footer: ['Total Income', report.income.total, ...(hasCmp ? [report.income.compareTotal ?? ''] : [])] },
        { heading: 'Expenses', columns: cols, rows: report.expenses.rows.map(toRow),
          footer: ['Total Expenses', report.expenses.total, ...(hasCmp ? [report.expenses.compareTotal ?? ''] : [])] },
        { columns: cols, rows: [],
          footer: ['Net Income', report.netIncome, ...(hasCmp ? [report.compareNetIncome ?? ''] : [])] },
      ],
    }));
  } catch (e) {
    next(e);
  }
});

reportsRouter.get('/balance-sheet', async (req: AuthedRequest, res, next) => {
  try {
    const asOf = (req.query.as_of as string) ?? new Date().toISOString().slice(0, 10);
    const compareAsOf = req.query.compare_as_of as string | undefined;
    const report = await balanceSheet(db, req.companyId!, asOf, compareAsOf);
    const cols = [
      { label: 'Account', width: 3 },
      { label: 'Amount', width: 1.5, align: 'right' as const },
    ];
    await send(res, req, report, () => ({
      title: 'Balance Sheet',
      subtitle: `As of ${asOf}`,
      sections: [
        { heading: 'Assets', columns: cols, rows: report.assets.rows.map((r: any) => [r.account, r.amount]),
          footer: ['Total Assets', report.assets.total] },
        { heading: 'Liabilities', columns: cols, rows: report.liabilities.rows.map((r: any) => [r.account, r.amount]),
          footer: ['Total Liabilities', report.liabilities.total] },
        { heading: 'Equity', columns: cols, rows: report.equity.rows.map((r: any) => [r.account, r.amount]),
          footer: ['Total Equity', report.equity.total] },
        { columns: cols, rows: [], footer: ['Liabilities + Equity', report.totalLiabilitiesAndEquity] },
      ],
    }));
  } catch (e) {
    next(e);
  }
});

reportsRouter.get('/cash-flow', async (req: AuthedRequest, res, next) => {
  try {
    const { from, to } = period(req);
    const report = await cashFlow(db, req.companyId!, { from, to });
    const cols = [
      { label: 'Item', width: 3 },
      { label: 'Amount', width: 1.5, align: 'right' as const },
    ];
    await send(res, req, report, () => ({
      title: 'Cash Flow Statement',
      subtitle: `${from} to ${to} (indirect method)`,
      sections: [
        { heading: 'Operating Activities', columns: cols,
          rows: [['Net Income', report.operating.netIncome], ...report.operating.adjustments.map((r) => [r.label, r.amount])],
          footer: ['Net Cash from Operating', report.operating.total] },
        { heading: 'Investing Activities', columns: cols,
          rows: report.investing.rows.map((r) => [r.label, r.amount]),
          footer: ['Net Cash from Investing', report.investing.total] },
        { heading: 'Financing Activities', columns: cols,
          rows: report.financing.rows.map((r) => [r.label, r.amount]),
          footer: ['Net Cash from Financing', report.financing.total] },
        { columns: cols, rows: [
            ['Net Change in Cash', report.netChange],
            ['Opening Cash', report.openingCash],
          ],
          footer: ['Closing Cash', report.closingCash] },
      ],
    }));
  } catch (e) {
    next(e);
  }
});

reportsRouter.get('/general-ledger', async (req: AuthedRequest, res, next) => {
  try {
    const { from, to } = period(req);
    const report = await generalLedger(db, req.companyId!, {
      from, to, accountId: req.query.account_id as string | undefined,
    });
    const cols = [
      { label: 'Date', width: 1 }, { label: 'Entry', width: 0.7 },
      { label: 'Description', width: 2.5 },
      { label: 'Debit', width: 1, align: 'right' as const },
      { label: 'Credit', width: 1, align: 'right' as const },
      { label: 'Balance', width: 1.2, align: 'right' as const },
    ];
    await send(res, req, report, () => ({
      title: 'General Ledger',
      subtitle: `${from} to ${to}`,
      sections: report.sections.map((s) => ({
        heading: `${s.accountCode} — ${s.accountName} (opening ${s.opening})`,
        columns: cols,
        rows: s.rows.map((r) => [r.date, String(r.entryNo), r.description ?? '', r.debit, r.credit, r.balance]),
        footer: ['', '', 'Closing balance', '', '', s.closing],
      })),
    }));
  } catch (e) {
    next(e);
  }
});

for (const [path, fn] of [['ar-aging', arAging], ['ap-aging', apAging]] as const) {
  reportsRouter.get(`/${path}`, async (req: AuthedRequest, res, next) => {
    try {
      const asOf = (req.query.as_of as string) ?? new Date().toISOString().slice(0, 10);
      const report = await fn(db, req.companyId!, asOf);
      const cols = [
        { label: 'Contact', width: 2.5 },
        ...report.buckets.map((b) => ({ label: b, width: 1.1, align: 'right' as const })),
        { label: 'Total', width: 1.2, align: 'right' as const },
      ];
      await send(res, req, report, () => ({
        title: report.title,
        subtitle: `As of ${asOf}`,
        sections: [{
          columns: cols,
          rows: report.rows.map((r: any) => [r.contact, ...report.buckets.map((b) => r[b]), r.total]),
          footer: ['Total', ...report.buckets.map((b) => (report.totals as any)[b]), report.totals.total],
        }],
      }));
    } catch (e) {
      next(e);
    }
  });
}

reportsRouter.get('/tax-summary', async (req: AuthedRequest, res, next) => {
  try {
    const { from, to } = period(req);
    const report = await taxSummary(db, req.companyId!, { from, to });
    await send(res, req, report, () => ({
      title: 'VAT & Withholding Summary',
      subtitle: `${from} to ${to}`,
      sections: [
        {
          columns: [
            { label: 'Code', width: 1 }, { label: 'Name', width: 2.5 },
            { label: 'Rate %', width: 0.8, align: 'right' }, { label: 'Category', width: 1.2 },
            { label: 'Amount', width: 1.2, align: 'right' }, { label: 'Direction', width: 1 },
          ],
          rows: report.rows.map((r) => [r.code, r.name, r.rate, r.category ?? '', r.amount, r.direction]),
        },
        {
          heading: 'Summary',
          columns: [{ label: 'Item', width: 3 }, { label: 'Amount', width: 1.5, align: 'right' }],
          rows: [
            ['Output VAT (on sales)', report.summary.outputVat],
            ['Input VAT (rebatable)', report.summary.inputVat],
            ['VDS withheld payable', report.summary.vdsPayable],
            ['AIT net (payable − receivable)', report.summary.aitNet],
          ],
          footer: ['Net VAT payable', report.summary.netVatPayable],
        },
      ],
    }));
  } catch (e) {
    next(e);
  }
});

reportsRouter.get('/stock-on-hand', async (req: AuthedRequest, res, next) => {
  try {
    const report = await stockOnHand(db, req.companyId!);
    await send(res, req, report, () => ({
      title: 'Stock on Hand',
      sections: [{
        columns: [
          { label: 'Item', width: 2.5 }, { label: 'SKU', width: 1 },
          { label: 'Qty', width: 1, align: 'right' }, { label: 'Avg Cost', width: 1.2, align: 'right' },
          { label: 'Value', width: 1.3, align: 'right' },
        ],
        rows: report.rows.map((r) => [r.name, r.sku, r.qtyOnHand, r.avgCost, r.value]),
        footer: ['Total', '', '', '', report.totalValue],
      }],
    }));
  } catch (e) {
    next(e);
  }
});

reportsRouter.get('/customer-statement/:customerId', async (req: AuthedRequest, res, next) => {
  try {
    const { from, to } = period(req);
    const report = await customerStatement(db, req.companyId!, req.params.customerId, { from, to });
    await send(res, req, report, () => ({
      title: 'Customer Statement',
      subtitle: `${report.customer.name} — ${from} to ${to}`,
      sections: [{
        columns: [
          { label: 'Date', width: 1 }, { label: 'Type', width: 1 },
          { label: 'Description', width: 2.5 },
          { label: 'Charges', width: 1.1, align: 'right' },
          { label: 'Payments', width: 1.1, align: 'right' },
          { label: 'Balance', width: 1.2, align: 'right' },
        ],
        rows: [
          ['', '', 'Opening balance', '', '', report.opening],
          ...report.rows.map((r: any) => [r.date, r.type, r.description ?? '', r.charges, r.payments, r.balance]),
        ],
        footer: ['', '', 'Closing balance', '', '', report.closing],
      }],
    }));
  } catch (e) {
    next(e);
  }
});

// ---- IFRS statements ----

reportsRouter.get('/statement-profit-loss', async (req: AuthedRequest, res, next) => {
  try {
    const { from, to } = period(req);
    const cmp = comparePeriod(req, from, to);
    const report = await statementProfitOrLoss(db, req.companyId!, { from, to, ...cmp });
    const hasCmp = !!report.comparePeriod;
    const cols = [
      { label: '', width: 3 },
      { label: 'Amount', width: 1.5, align: 'right' as const },
      ...(hasCmp ? [{ label: 'Comparative', width: 1.5, align: 'right' as const }] : []),
    ];
    const r = (label: string, a: string, c: string | null) => [label, a, ...(hasCmp ? [c ?? ''] : [])];
    await send(res, req, report, () => ({
      title: 'Statement of Profit or Loss and OCI',
      subtitle: `${from} to ${to}`,
      sections: [{
        columns: cols,
        rows: [
          ...report.lines.map((l) => r(l.label, l.amount, l.compare)),
          r('Gross profit', report.grossProfit.amount, report.grossProfit.compare),
          ...report.lines2.map((l) => r(l.label, l.amount, l.compare)),
          r('Profit for the period', report.profitForPeriod.amount, report.profitForPeriod.compare),
          r('Other comprehensive income', report.otherComprehensiveIncome.amount, report.otherComprehensiveIncome.compare),
        ],
        footer: r('Total comprehensive income', report.totalComprehensiveIncome.amount, report.totalComprehensiveIncome.compare),
      }],
    }));
  } catch (e) {
    next(e);
  }
});

reportsRouter.get('/statement-financial-position', async (req: AuthedRequest, res, next) => {
  try {
    const asOf = (req.query.as_of as string) ?? new Date().toISOString().slice(0, 10);
    const compareAsOf = req.query.compare_as_of as string | undefined;
    const report = await statementFinancialPosition(db, req.companyId!, asOf, compareAsOf);
    const hasCmp = !!compareAsOf;
    const cols = [
      { label: '', width: 3 },
      { label: 'Amount', width: 1.5, align: 'right' as const },
      ...(hasCmp ? [{ label: 'Comparative', width: 1.5, align: 'right' as const }] : []),
    ];
    const r = (label: string, a: string, c?: string | null) => [label, a, ...(hasCmp ? [c ?? ''] : [])];
    const sec = (heading: string, s: any) => ({
      heading,
      columns: cols,
      rows: s.lines.map((l: any) => r(l.label, l.amount, l.compare)),
      footer: r(`Total ${heading.toLowerCase()}`, s.total, s.compareTotal),
    });
    await send(res, req, report, () => ({
      title: 'Statement of Financial Position',
      subtitle: `As of ${asOf}`,
      sections: [
        sec('Non-current assets', report.nonCurrentAssets),
        sec('Current assets', report.currentAssets),
        { columns: cols, rows: [], footer: r('TOTAL ASSETS', report.totalAssets.amount, report.totalAssets.compare) },
        sec('Equity', report.equity),
        sec('Non-current liabilities', report.nonCurrentLiabilities),
        sec('Current liabilities', report.currentLiabilities),
        { columns: cols, rows: [], footer: r('TOTAL EQUITY AND LIABILITIES', report.totalEquityAndLiabilities.amount, report.totalEquityAndLiabilities.compare) },
      ],
    }));
  } catch (e) {
    next(e);
  }
});

reportsRouter.get('/statement-changes-equity', async (req: AuthedRequest, res, next) => {
  try {
    const { from, to } = period(req);
    const report = await statementChangesInEquity(db, req.companyId!, { from, to });
    await send(res, req, report, () => ({
      title: 'Statement of Changes in Equity',
      subtitle: `${from} to ${to}`,
      sections: [{
        columns: [
          { label: '', width: 2 },
          ...report.columns.map((c) => ({ label: c.label, width: 1.4, align: 'right' as const })),
          { label: 'Total', width: 1.2, align: 'right' as const },
        ],
        rows: report.rows.map((row) => [row.label, ...row.cells, row.total]),
      }],
    }));
  } catch (e) {
    next(e);
  }
});

// ---- Branded document PDFs ----

const DOC_SOURCES = {
  invoice: { table: 'invoices', lines: 'invoice_lines', fk: 'invoice_id', contact: 'customer_id', kind: 'INVOICE' as const },
  quote: { table: 'quotes', lines: 'quote_lines', fk: 'quote_id', contact: 'customer_id', kind: 'QUOTE' as const },
  'credit-note': { table: 'credit_notes', lines: 'credit_note_lines', fk: 'credit_note_id', contact: 'customer_id', kind: 'CREDIT NOTE' as const },
};

reportsRouter.get('/document-pdf/:docType/:id', async (req: AuthedRequest, res, next) => {
  try {
    const src = DOC_SOURCES[req.params.docType as keyof typeof DOC_SOURCES];
    if (!src) throw badRequest('docType must be invoice, quote, or credit-note');
    const doc = await db(src.table).where({ id: req.params.id, company_id: req.companyId }).first();
    if (!doc) throw notFound('Document not found');
    const [company, contact, lines] = await Promise.all([
      db('companies').where({ id: req.companyId }).first(),
      db('contacts').where({ id: doc[src.contact] }).first(),
      db(src.lines).where({ [src.fk]: doc.id }).orderBy('line_no'),
    ]);
    const buf = await documentPdf({ kind: src.kind, company, contact, doc, lines });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${doc.doc_no}.pdf"`);
    res.send(buf);
  } catch (e) {
    next(e);
  }
});
