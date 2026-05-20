import PDFDocument from 'pdfkit';
import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';

// ── Domain shape (pure, exported for tests) ──────────────────────────────────
// Trades coming out of Prisma carry Decimal-like floats + Date objects. The
// pure formatters work off this narrower row shape so tests don't need to
// stand up a full Trade record.

export interface TaxRow {
  externalId: string | null;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: number;
  entryPrice: number;
  exitPrice: number | null;
  pnl: number | null;
  commission: number | null;
  swap: number | null;
  entryAt: Date;
  exitAt: Date | null;
  accountName: string;
}

export interface TaxSummary {
  year: number;
  tradesClosed: number;
  grossPnL: number;
  totalCommission: number;
  totalSwap: number;
  netPnL: number;
  winningTrades: number;
  losingTrades: number;
  breakevenTrades: number;
  largestWin: number;
  largestLoss: number;
}

export function summarizeForTaxYear(rows: TaxRow[], year: number): TaxSummary {
  let grossPnL = 0;
  let totalCommission = 0;
  let totalSwap = 0;
  let wins = 0;
  let losses = 0;
  let breakevens = 0;
  let largestWin = 0;
  let largestLoss = 0;

  for (const r of rows) {
    const pnl = r.pnl ?? 0;
    grossPnL += pnl;
    totalCommission += r.commission ?? 0;
    totalSwap += r.swap ?? 0;
    if (pnl > 0) {
      wins++;
      if (pnl > largestWin) largestWin = pnl;
    } else if (pnl < 0) {
      losses++;
      if (pnl < largestLoss) largestLoss = pnl;
    } else {
      breakevens++;
    }
  }

  // The "net" line that matters for tax: realised P&L, less the cost of
  // trading. Swap is added in (it can be negative or positive depending on
  // direction + carry).
  const netPnL = grossPnL + totalCommission + totalSwap;

  return {
    year,
    tradesClosed: rows.length,
    grossPnL,
    totalCommission,
    totalSwap,
    netPnL,
    winningTrades: wins,
    losingTrades: losses,
    breakevenTrades: breakevens,
    largestWin,
    largestLoss,
  };
}

// ── CSV ──────────────────────────────────────────────────────────────────────

const CSV_HEADER = [
  'Ticket',
  'Symbol',
  'Side',
  'Volume',
  'Entry Price',
  'Exit Price',
  'P&L',
  'Commission',
  'Swap',
  'Entry Time (UTC)',
  'Exit Time (UTC)',
  'Account',
];

function csvCell(v: string | number | null | undefined): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function tradesToCsvRows(rows: TaxRow[]): string[][] {
  return [
    CSV_HEADER,
    ...rows.map((r) => [
      r.externalId ?? '',
      r.symbol,
      r.side,
      r.volume.toString(),
      r.entryPrice.toString(),
      r.exitPrice?.toString() ?? '',
      r.pnl?.toFixed(2) ?? '',
      r.commission?.toFixed(2) ?? '',
      r.swap?.toFixed(2) ?? '',
      r.entryAt.toISOString(),
      r.exitAt?.toISOString() ?? '',
      r.accountName,
    ]),
  ];
}

export function buildCsv(rows: TaxRow[]): string {
  const table = tradesToCsvRows(rows);
  // BOM so Excel detects UTF-8 properly when the file is opened from disk.
  return '﻿' + table.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ── PDF ──────────────────────────────────────────────────────────────────────

const COL_WIDTHS = {
  date: 78,
  symbol: 58,
  side: 32,
  volume: 42,
  entry: 56,
  exit: 56,
  pnl: 62,
  fees: 56,
};

const fmtMoney = (n: number) =>
  `${n >= 0 ? '' : '-'}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export function buildPdf(rows: TaxRow[], summary: TaxSummary): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc
      .fontSize(20)
      .fillColor('#0D1610')
      .font('Helvetica-Bold')
      .text(`Prop Journal — Tax Year ${summary.year}`, { align: 'left' });
    doc
      .moveDown(0.3)
      .fontSize(10)
      .fillColor('#666')
      .font('Helvetica')
      .text(`Generated ${new Date().toISOString().slice(0, 10)}`, { align: 'left' });

    // Summary block
    doc.moveDown(1);
    doc.fontSize(12).fillColor('#0D1610').font('Helvetica-Bold').text('Summary');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#222');

    const summaryRows: [string, string][] = [
      ['Closed trades', String(summary.tradesClosed)],
      ['Winning trades', String(summary.winningTrades)],
      ['Losing trades', String(summary.losingTrades)],
      ['Break-even', String(summary.breakevenTrades)],
      ['Gross P&L', fmtMoney(summary.grossPnL)],
      ['Commissions', fmtMoney(summary.totalCommission)],
      ['Swap / rollover', fmtMoney(summary.totalSwap)],
      ['Net P&L', fmtMoney(summary.netPnL)],
      ['Largest single winner', fmtMoney(summary.largestWin)],
      ['Largest single loser', fmtMoney(summary.largestLoss)],
    ];
    const labelX = 40;
    const valueX = 220;
    for (const [label, value] of summaryRows) {
      doc.text(label, labelX, doc.y, { continued: false });
      doc.text(value, valueX, doc.y - 12);
    }

    // Trade table
    doc.moveDown(1.2);
    doc
      .fontSize(12)
      .font('Helvetica-Bold')
      .fillColor('#0D1610')
      .text('Closed trades', 40);
    doc.moveDown(0.4);

    const headerY = doc.y;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#0D1610');
    let x = 40;
    const headers: [string, number][] = [
      ['Exit', COL_WIDTHS.date],
      ['Symbol', COL_WIDTHS.symbol],
      ['Side', COL_WIDTHS.side],
      ['Volume', COL_WIDTHS.volume],
      ['Entry', COL_WIDTHS.entry],
      ['Exit', COL_WIDTHS.exit],
      ['P&L', COL_WIDTHS.pnl],
      ['Fees', COL_WIDTHS.fees],
    ];
    for (const [label, w] of headers) {
      doc.text(label, x, headerY, { width: w });
      x += w;
    }
    doc.moveDown(0.3);
    doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#999').stroke();
    doc.moveDown(0.2);

    doc.fontSize(8).font('Helvetica').fillColor('#222');
    for (const r of rows) {
      // Add a page break with a re-rendered header row before bleeding off the
      // bottom margin. pdfkit's auto-page would otherwise drop the column
      // headers from page 2 onward.
      if (doc.y > 760) {
        doc.addPage();
      }
      const rowY = doc.y;
      let cx = 40;
      const cells: [string, number][] = [
        [r.exitAt?.toISOString().slice(0, 10) ?? '—', COL_WIDTHS.date],
        [r.symbol, COL_WIDTHS.symbol],
        [r.side, COL_WIDTHS.side],
        [r.volume.toString(), COL_WIDTHS.volume],
        [r.entryPrice.toString(), COL_WIDTHS.entry],
        [r.exitPrice?.toString() ?? '—', COL_WIDTHS.exit],
        [r.pnl != null ? fmtMoney(r.pnl) : '—', COL_WIDTHS.pnl],
        [fmtMoney((r.commission ?? 0) + (r.swap ?? 0)), COL_WIDTHS.fees],
      ];
      for (const [v, w] of cells) {
        doc.text(v, cx, rowY, { width: w });
        cx += w;
      }
      doc.moveDown(0.6);
    }

    doc.end();
  });
}

// ── DB read + orchestration ──────────────────────────────────────────────────

export async function getTaxExportRows(userId: string, year: number): Promise<TaxRow[]> {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new AppError('Invalid year', 400);
  }
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year + 1, 0, 1));

  const trades = await prisma.trade.findMany({
    where: {
      account: { userId },
      status: 'CLOSED',
      exitAt: { gte: start, lt: end },
    },
    orderBy: { exitAt: 'asc' },
    select: {
      externalId: true,
      symbol: true,
      side: true,
      volume: true,
      entryPrice: true,
      exitPrice: true,
      pnl: true,
      commission: true,
      swap: true,
      entryAt: true,
      exitAt: true,
      account: { select: { name: true } },
    },
  });

  return trades.map((t) => ({
    externalId: t.externalId,
    symbol: t.symbol,
    side: t.side as 'BUY' | 'SELL',
    volume: t.volume,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    pnl: t.pnl,
    commission: t.commission,
    swap: t.swap,
    entryAt: t.entryAt,
    exitAt: t.exitAt,
    accountName: t.account.name,
  }));
}
