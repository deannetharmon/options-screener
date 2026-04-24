export interface BarchartRow {
  symbol: string;
  name: string;
  price: number;
  ivRank: number;
  ivx: number;
  optionsVol: number;
  earnings: string | null;
}

// Parse the Barchart "Highest IV Rank" CSV download
export function parseBarchartCSV(csvText: string): BarchartRow[] {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];

  // Find header row
  const header = lines[0].split(',').map((h) => h.replace(/"/g, '').trim().toLowerCase());

  const idx = {
    symbol: header.findIndex((h) => h === 'symbol'),
    name: header.findIndex((h) => h === 'name'),
    price: header.findIndex((h) => h === 'latest'),
    ivRank: header.findIndex((h) => h.includes('iv rank')),
    ivx: header.findIndex((h) => h.includes('imp vol')),
    optVol: header.findIndex((h) => h.includes('options vol')),
    earnings: header.findIndex((h) => h === 'earnings'),
  };

  const results: BarchartRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Handle quoted fields with commas
    const cols = parseCSVLine(line);
    if (cols.length < 5) continue;

    try {
      const symbol = cols[idx.symbol]?.replace(/"/g, '').trim();
      if (!symbol) continue;

      const price = parseFloat(cols[idx.price] || '0');
      const ivRank = parseFloat((cols[idx.ivRank] || '0').replace('%', ''));
      const ivx = parseFloat((cols[idx.ivx] || '0').replace('%', ''));
      const optVol = parseFloat((cols[idx.optVol] || '0').replace(/,/g, ''));
      const earnings = cols[idx.earnings]?.replace(/"/g, '').trim() || null;

      if (!symbol || isNaN(price) || isNaN(ivRank) || isNaN(ivx)) continue;

      results.push({
        symbol,
        name: cols[idx.name]?.replace(/"/g, '').trim() || symbol,
        price,
        ivRank,
        ivx,
        optionsVol: isNaN(optVol) ? 0 : optVol,
        earnings: earnings && earnings !== '' ? earnings : null,
      });
    } catch {
      continue;
    }
  }

  return results;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

// Filter the parsed CSV rows by your course rules
export function filterBarchartRows(
  rows: BarchartRow[],
  opts: {
    minIVR?: number;
    minIVx?: number;
    minPrice?: number;
    minOptVol?: number;
    earningsSafeAfterDays?: number;
  } = {}
): BarchartRow[] {
  const {
    minIVR = 30,
    minIVx = 35,
    minPrice = 50,
    minOptVol = 10000,
    earningsSafeAfterDays = 21,
  } = opts;

  const today = new Date();

  return rows.filter((row) => {
    if (row.ivRank < minIVR) return false;
    if (row.ivx < minIVx) return false;
    if (row.price < minPrice) return false;
    if (row.optionsVol < minOptVol) return false;

    // Earnings check - skip if earnings within buffer days
    if (row.earnings) {
      try {
        const earningsDate = new Date(row.earnings);
        const daysAway = Math.round(
          (earningsDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
        );
        if (daysAway >= 0 && daysAway <= earningsSafeAfterDays) return false;
      } catch {
        // Can't parse earnings date, keep the row
      }
    }

    return true;
  });
}
