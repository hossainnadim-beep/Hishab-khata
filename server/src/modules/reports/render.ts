import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

/** Normalized tabular report for export. */
export interface FlatReport {
  title: string;
  subtitle?: string;
  sections: Array<{
    heading?: string;
    columns: Array<{ label: string; width?: number; align?: 'left' | 'right' }>;
    rows: string[][];
    footer?: string[];
  }>;
}

export async function toXlsx(report: FlatReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(report.title.slice(0, 31));
  ws.addRow([report.title]).font = { bold: true, size: 14 };
  if (report.subtitle) ws.addRow([report.subtitle]).font = { size: 10, color: { argb: 'FF666666' } };
  ws.addRow([]);

  for (const section of report.sections) {
    if (section.heading) {
      ws.addRow([section.heading]).font = { bold: true, size: 12 };
    }
    const headerRow = ws.addRow(section.columns.map((c) => c.label));
    headerRow.font = { bold: true };
    headerRow.eachCell((cell) => {
      cell.border = { bottom: { style: 'thin' } };
    });
    for (const row of section.rows) ws.addRow(row);
    if (section.footer) {
      const f = ws.addRow(section.footer);
      f.font = { bold: true };
      f.eachCell((cell) => {
        cell.border = { top: { style: 'thin' } };
      });
    }
    ws.addRow([]);
  }
  // column widths + right alignment
  const first = report.sections[0];
  if (first) {
    first.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = c.width ?? 22;
      if (c.align === 'right') col.alignment = { horizontal: 'right' };
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toPdf(report: FlatReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).font('Helvetica-Bold').text(report.title);
    if (report.subtitle) doc.fontSize(9).font('Helvetica').fillColor('#555').text(report.subtitle);
    doc.moveDown(0.8).fillColor('#000');

    const pageWidth = doc.page.width - 80;

    for (const section of report.sections) {
      if (section.heading) {
        doc.moveDown(0.4).fontSize(11).font('Helvetica-Bold').text(section.heading).moveDown(0.2);
      }
      const weights = section.columns.map((c) => c.width ?? 1);
      const totalW = weights.reduce((a, b) => a + b, 0);
      const colWidths = weights.map((w) => (w / totalW) * pageWidth);

      const drawRow = (cells: string[], opts: { bold?: boolean; rule?: boolean } = {}) => {
        if (doc.y > doc.page.height - 60) doc.addPage();
        const y = doc.y;
        doc.fontSize(8).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica');
        let x = 40;
        cells.forEach((cell, i) => {
          doc.text(cell ?? '', x, y, {
            width: colWidths[i] - 6,
            align: section.columns[i]?.align ?? 'left',
            lineBreak: false,
          });
          x += colWidths[i];
        });
        doc.y = y + 13;
        doc.x = 40;
        if (opts.rule) {
          doc.moveTo(40, doc.y - 2).lineTo(40 + pageWidth, doc.y - 2).lineWidth(0.5).strokeColor('#999').stroke();
          doc.strokeColor('#000');
        }
      };

      drawRow(section.columns.map((c) => c.label), { bold: true, rule: true });
      for (const row of section.rows) drawRow(row);
      if (section.footer) drawRow(section.footer, { bold: true, rule: true });
      doc.moveDown(0.6);
    }
    doc.end();
  });
}
