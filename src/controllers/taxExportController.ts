import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import {
  getTaxExportRows,
  summarizeForTaxYear,
  buildCsv,
  buildPdf,
} from '../services/taxExportService';

const querySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  format: z.enum(['csv', 'pdf']),
});

export async function exportTaxHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { year, format } = querySchema.parse(req.query);
    const rows = await getTaxExportRows(req.currentUser!.userId, year);
    const filename = `propjournal-tax-${year}.${format}`;

    if (format === 'csv') {
      const csv = buildCsv(rows);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
      return;
    }

    const summary = summarizeForTaxYear(rows, year);
    const pdf = await buildPdf(rows, summary);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdf.length.toString());
    res.send(pdf);
  } catch (error) {
    next(error);
  }
}
