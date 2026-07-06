import PDFDocument from 'pdfkit';
import { d, money } from '../../lib/money.ts';

/**
 * Branded document PDF (invoice / quote / credit note). Original layout —
 * company-configurable header text and footer, not derived from any vendor's
 * trade dress.
 */
export function documentPdf(opts: {
  kind: 'INVOICE' | 'QUOTE' | 'CREDIT NOTE';
  company: any;
  contact: { name: string; address?: string | null; email?: string | null; tax_reg_no?: string | null };
  doc: {
    doc_no: string;
    issue_date: string;
    due_date?: string;
    currency: string;
    subtotal: string;
    tax_total: string;
    total: string;
    balance_due?: string;
    memo?: string | null;
    amounts_are?: string;
  };
  lines: Array<{ description: string | null; qty: string; unit_price: string; discount_pct?: string; tax_amount: string; net_amount: string }>;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    const { company, contact, doc, lines, kind } = opts;
    const pageWidth = pdf.page.width - 100;

    // Header band
    pdf.rect(0, 0, pdf.page.width, 6).fill('#1a6b54');
    pdf.fill('#000').fontSize(20).font('Helvetica-Bold')
      .text(company.invoice_logo_text || company.name, 50, 40);
    pdf.fontSize(9).font('Helvetica').fillColor('#444');
    const headerLines = [company.legal_name !== company.name ? company.legal_name : null,
      company.address, company.phone, company.email,
      company.tax_registration_no ? `BIN: ${company.tax_registration_no}` : null].filter(Boolean);
    pdf.text(headerLines.join('\n'), 50, pdf.y + 2);

    pdf.fontSize(24).font('Helvetica-Bold').fillColor('#1a6b54')
      .text(kind, 50, 45, { align: 'right', width: pageWidth });
    pdf.fontSize(10).font('Helvetica').fillColor('#000')
      .text(doc.doc_no, 50, pdf.y + 2, { align: 'right', width: pageWidth });

    // Bill-to + dates
    const infoY = 140;
    pdf.fontSize(9).font('Helvetica-Bold').fillColor('#888').text(kind === 'QUOTE' ? 'QUOTE FOR' : 'BILL TO', 50, infoY);
    pdf.fontSize(11).font('Helvetica-Bold').fillColor('#000').text(contact.name, 50, infoY + 14);
    pdf.fontSize(9).font('Helvetica').fillColor('#444');
    if (contact.address) pdf.text(contact.address, 50, pdf.y + 2, { width: 250 });
    if (contact.tax_reg_no) pdf.text(`BIN: ${contact.tax_reg_no}`);

    const rightX = 360;
    pdf.fontSize(9).fillColor('#888').font('Helvetica-Bold').text('ISSUE DATE', rightX, infoY, { width: 90 });
    pdf.fillColor('#000').font('Helvetica').text(doc.issue_date, rightX + 95, infoY);
    if (doc.due_date) {
      pdf.fillColor('#888').font('Helvetica-Bold').text(kind === 'QUOTE' ? 'VALID UNTIL' : 'DUE DATE', rightX, infoY + 14, { width: 90 });
      pdf.fillColor('#000').font('Helvetica').text(doc.due_date, rightX + 95, infoY + 14);
    }
    pdf.fillColor('#888').font('Helvetica-Bold').text('CURRENCY', rightX, infoY + 28, { width: 90 });
    pdf.fillColor('#000').font('Helvetica').text(doc.currency, rightX + 95, infoY + 28);

    // Lines table
    let y = 230;
    const cols = [
      { label: 'Description', w: 0.42, align: 'left' as const },
      { label: 'Qty', w: 0.1, align: 'right' as const },
      { label: 'Unit Price', w: 0.16, align: 'right' as const },
      { label: 'Tax', w: 0.14, align: 'right' as const },
      { label: 'Amount', w: 0.18, align: 'right' as const },
    ];
    pdf.rect(50, y - 4, pageWidth, 18).fill('#f0f4f2');
    pdf.fillColor('#333').fontSize(8).font('Helvetica-Bold');
    let x = 50;
    for (const c of cols) {
      pdf.text(c.label, x + 4, y, { width: c.w * pageWidth - 8, align: c.align });
      x += c.w * pageWidth;
    }
    y += 20;
    pdf.font('Helvetica').fontSize(9).fillColor('#000');
    for (const l of lines) {
      if (y > pdf.page.height - 180) {
        pdf.addPage();
        y = 50;
      }
      x = 50;
      const cells = [
        l.description ?? '',
        d(l.qty).toFixed(2).replace(/\.00$/, ''),
        d(l.unit_price).toFixed(2),
        money(l.tax_amount),
        money(l.net_amount),
      ];
      cells.forEach((cell, i) => {
        pdf.text(cell, x + 4, y, { width: cols[i].w * pageWidth - 8, align: cols[i].align, lineBreak: false });
        x += cols[i].w * pageWidth;
      });
      y += 16;
      pdf.moveTo(50, y - 4).lineTo(50 + pageWidth, y - 4).lineWidth(0.3).strokeColor('#ddd').stroke();
    }

    // Totals
    y += 10;
    const totalRow = (label: string, value: string, bold = false) => {
      pdf.fontSize(bold ? 11 : 9).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor('#000');
      pdf.text(label, 330, y, { width: 130, align: 'right' });
      pdf.text(value, 465, y, { width: 80, align: 'right' });
      y += bold ? 20 : 15;
    };
    totalRow('Subtotal', money(doc.subtotal));
    totalRow(doc.amounts_are === 'inclusive' ? 'Included VAT' : 'VAT', money(doc.tax_total));
    pdf.moveTo(330, y - 2).lineTo(545, y - 2).lineWidth(0.5).strokeColor('#333').stroke();
    totalRow(`Total (${doc.currency})`, money(doc.total), true);
    if (doc.balance_due !== undefined && kind === 'INVOICE') {
      totalRow('Balance Due', money(doc.balance_due), true);
    }

    if (doc.memo) {
      pdf.fontSize(9).fillColor('#444').font('Helvetica').text(`Notes: ${doc.memo}`, 50, y + 10, { width: 260 });
    }
    if (company.invoice_footer) {
      pdf.fontSize(8).fillColor('#888').text(company.invoice_footer, 50, pdf.page.height - 70, {
        width: pageWidth,
        align: 'center',
      });
    }
    pdf.end();
  });
}
