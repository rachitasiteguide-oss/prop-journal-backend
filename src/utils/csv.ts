// Minimal RFC-4180 CSV tokenizer. Returns a 2D array of fields with quoted
// fields unescaped (e.g. ""foo"" → "foo"). Supports comma OR tab delimiters
// (auto-detected from the first non-empty row) so we don't need a separate
// TSV path for MT4 statement exports.

export interface ParseCsvOptions {
  delimiter?: ',' | '\t' | 'auto';
}

export function parseCsv(input: string, opts: ParseCsvOptions = {}): string[][] {
  if (!input) return [];
  // Normalise line endings — MT4/MT5 exports vary.
  const text = input.replace(/\r\n?/g, '\n');

  const delimiter = opts.delimiter === 'auto' || !opts.delimiter
    ? detectDelimiter(text)
    : opts.delimiter;

  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }

  // Trailing field / row (no terminating newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop empty rows that resulted from blank lines.
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

function detectDelimiter(text: string): ',' | '\t' {
  const sample = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  const tabs = (sample.match(/\t/g) ?? []).length;
  const commas = (sample.match(/,/g) ?? []).length;
  return tabs > commas ? '\t' : ',';
}
